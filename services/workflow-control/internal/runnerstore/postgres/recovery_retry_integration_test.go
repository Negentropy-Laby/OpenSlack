package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestRecoveryMetadataAbortRetriesExactBindingLifecycle(t *testing.T) {
	requireGS9F2(t)
	pool := testsupport.OpenPostgres(t)
	repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	lease := claimV2(t, repo, v2JobInput(t, "metadata-retry", "go", "workflow-control"))
	sealRuntimeAdmission(t, repo, lease, "initial")
	negotiateV2Lease(t, repo, lease)
	at := canonicalNow()
	accept := v2LeasedEventAt(t, lease, authoritycontract.KindLeaseAccept, 1, "event-metadata-retry-initial", lease.RunRevision, lease.ResumeGeneration, at,
		map[string]any{"acceptedAt": at, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)})
	accept.ControlBuildHash = lease.AuthorityRoute.AuthorityBuildHash
	recorded, err := repo.RecordV2Event(context.Background(), accept)
	if err != nil {
		t.Fatal(err)
	}
	deliverV2Control(t, repo, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind))
	aborted := map[string]bool{}
	repo.commitTransaction = func(ctx context.Context, tx pgx.Tx) error {
		var state string
		err := tx.QueryRow(ctx, "SELECT state FROM workflow_runner_authority_bindings WHERE run_id=$1", lease.WorkflowRunID).Scan(&state)
		if err == nil && !aborted[state] {
			aborted[state] = true
			if err = tx.Rollback(ctx); err != nil {
				return err
			}
			return &pgconn.PgError{Code: "40001", ConstraintName: "workflow_runner_recovery_version_retry", Detail: "fixture-recovery-version"}
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return tx.Commit(ctx)
	}
	view := exerciseGS9F2BindingLifecycleUntil(t, repo, runnerbindingcontract.OperationCheckpointCommit, "metadata-retry-checkpoint", &lease, "completed", "")
	for _, state := range []string{"staged", "resolved", "runner_committed", "completed"} {
		if !aborted[state] {
			t.Fatal("retry window untested", state)
		}
	}
	if view.State != "completed" || len(view.ControlACKs) != 1 {
		t.Fatal("retry changed control lifecycle")
	}
	// The lifecycle helper also verifies exact request, receipt and ACK replay.
}

type cancelRecoveryProofTracer struct{ cancel context.CancelFunc }

func (tr *cancelRecoveryProofTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	if tr.cancel != nil && strings.Contains(d.SQL, "SELECT state IN ('offered','active','cancelling')") {
		tr.cancel()
	}
	return ctx
}
func (*cancelRecoveryProofTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestRecoveryPreviewPropagatesFinalProofCancellation(t *testing.T) {
	tr := &cancelRecoveryProofTracer{}
	pool := testsupport.OpenPostgresWithTracer(t, tr)
	repo, _, binding, _ := reconciliationFixtureInPool(t, pool, 11, runnerbindingcontract.OperationResumeAdvance, "staged")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tr.cancel = cancel
	result, err := repo.PreviewBindingReconciliation(ctx, binding.WorkspaceID, binding.RunID, binding.BindingID, "")
	if !errors.Is(err, context.Canceled) || !runnerstore.IsCode(err, runnerstore.ErrorAuthorityUnavailable) || len(result.Encoded) != 0 {
		t.Fatal("cancelled proof returned a successful page", err)
	}
}

func TestRecoveryRetryDoesNotRepeatUnknownCommitsOrUnrelatedSerialization(t *testing.T) {
	for _, failure := range []error{errors.New("commit response lost"), &pgconn.PgError{Code: "40001"}} {
		attempts := 0
		_, err := retryRecoveryTransaction(context.Background(), nil, func(context.Context) (string, error) { t.Fatal("unexpected retry"); return "", nil }, func(context.Context) (int, error) { attempts++; return 0, failure })
		if err != failure || attempts != 1 {
			t.Fatal("uncertain outcome was retried")
		}
	}
}

// The retry notification is emitted only after the trigger aborted the original
// transaction, so releasing this lock cannot conceal a business-lock deadlock.
type metadataWaitTracer struct{ waiting chan struct{} }

func (tr *metadataWaitTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	if d.SQL == "SELECT pg_advisory_xact_lock(hashtextextended($1,11))" {
		select {
		case tr.waiting <- struct{}{}:
		default:
		}
	}
	return ctx
}
func (*metadataWaitTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func holdRecoveryVersion(t *testing.T, repo *Repository, workspace, run string) pgx.Tx {
	t.Helper()
	ctx := t.Context()
	tx, err := repo.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	var schema string
	if err = tx.QueryRow(ctx, "SELECT current_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	key := fmt.Sprintf("recovery-version:%s:%d:%s:%s", schema, len(workspace), workspace, run)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,11)) /* fixture holder */", key); err != nil {
		t.Fatal(err)
	}
	return tx
}

func TestRecoveryMetadataContentionRetriesMaintenance(t *testing.T) {
	for _, kind := range []string{"submit", "claim", "cancel", "process_exit", "launch_failure", "expired"} {
		t.Run(kind, func(t *testing.T) {
			tr := &metadataWaitTracer{waiting: make(chan struct{}, 1)}
			pool := testsupport.OpenPostgresWithTracer(t, tr)
			repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
			input := v2JobInput(t, "metadata-maintenance-"+kind, "go", "workflow-control")
			workspace, run := input.Prepared.Spec.WorkspaceID, input.Prepared.Spec.WorkflowRunID
			var lease runnerstore.AttemptLease
			if kind == "claim" {
				if _, err := repo.SubmitV2(t.Context(), input); err != nil {
					t.Fatal(err)
				}
			} else if kind != "submit" {
				lease = claimV2(t, repo, input)
			}
			if kind == "expired" {
				expireLeaseAtDatabase(t, repo.pool, lease.LeaseID)
			}
			var before int64
			if err := pool.QueryRow(t.Context(), "SELECT COALESCE((SELECT revision FROM workflow_runner_recovery_versions WHERE workspace_id=$1 AND run_id=$2),0)", workspace, run).Scan(&before); err != nil {
				t.Fatal(err)
			}
			lock := holdRecoveryVersion(t, repo, workspace, run)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				var err error
				switch kind {
				case "submit":
					_, err = repo.SubmitV2(ctx, input)
				case "claim":
					claim := claimInput(workspace)
					claim.ProtocolVersions = []string{authoritycontract.ProtocolVersion}
					_, err = repo.ClaimNext(ctx, claim)
				case "cancel":
					now := time.Now().UTC().Truncate(time.Millisecond)
					cancelInput := runnerstore.CancelInput{WorkspaceID: workspace, JobID: lease.JobID, CorrelationID: lease.CorrelationID, ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken, Reason: "operator", Now: now, ExpiresAt: now.Add(time.Minute)}
					cancelInput.IdempotencyKey, cancelInput.RequestFingerprint, _ = runnerstore.CancelBindings(cancelInput)
					_, err = repo.RequestCancel(ctx, cancelInput)
				case "process_exit":
					_, err = repo.RecordProcessExit(ctx, runnerstore.ProcessExitInput{WorkspaceID: workspace, JobID: lease.JobID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken, Class: runnerstore.ProcessCrashed, ObservedAt: time.Now().UTC()})
				case "launch_failure":
					_, err = repo.RecordAttemptFailure(ctx, runnerstore.AttemptFailureInput{WorkspaceID: workspace, JobID: lease.JobID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken, Kind: runnerstore.AttemptLaunchFailed, ObservedAt: time.Now().UTC()})
				case "expired":
					var result []runnerstore.RecoveryResult
					result, err = repo.RecoverExpired(ctx, runnerstore.RecoverExpiredInput{Limit: 10})
					if err == nil && (len(result) != 1 || !result[0].SafeForNewAttempt) {
						err = fmt.Errorf("expired recovery did not settle exactly one unstarted attempt: %+v", result)
					}
				}
				done <- err
			}()
			select {
			case <-tr.waiting:
			case err := <-done:
				t.Fatalf("operation did not enter metadata retry: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if err := lock.Rollback(t.Context()); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			var after int64
			var jobs, attempts int
			if err := pool.QueryRow(t.Context(), "SELECT revision,(SELECT count(*) FROM workflow_runner_jobs),(SELECT count(*) FROM workflow_runner_attempts) FROM workflow_runner_recovery_versions WHERE workspace_id=$1 AND run_id=$2", workspace, run).Scan(&after, &jobs, &attempts); err != nil {
				t.Fatal(err)
			}
			expectedAttempts := 1
			if kind == "submit" {
				expectedAttempts = 0
			}
			if after != before+1 || jobs != 1 || attempts != expectedAttempts {
				t.Fatalf("rollback left duplicate business or version writes: %d -> %d jobs=%d attempts=%d", before, after, jobs, attempts)
			}
		})
	}
}

func TestRecoveryMetadataWaitHonorsCallerCancellation(t *testing.T) {
	tr := &metadataWaitTracer{waiting: make(chan struct{}, 1)}
	pool := testsupport.OpenPostgresWithTracer(t, tr)
	repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	input := v2JobInput(t, "metadata-cancel-wait", "go", "workflow-control")
	lock := holdRecoveryVersion(t, repo, input.Prepared.Spec.WorkspaceID, input.Prepared.Spec.WorkflowRunID)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := repo.SubmitV2(ctx, input); done <- err }()
	select {
	case <-tr.waiting:
	case err := <-done:
		t.Fatalf("operation did not wait: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("metadata wait was not reached")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("caller cancellation lost", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("metadata lock ignored cancellation")
	}
	var jobs int
	if err := pool.QueryRow(t.Context(), "SELECT count(*) FROM workflow_runner_jobs").Scan(&jobs); err != nil || jobs != 0 {
		t.Fatal("cancelled transaction persisted business writes", jobs, err)
	}
	if err := lock.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	// The identical request remains usable after the caller chooses to retry.
	if _, err := repo.SubmitV2(t.Context(), input); err != nil {
		t.Fatal(err)
	}
}

func TestRecoveryMetadataEvidenceRetryAfterLeaseExpiry(t *testing.T) {
	requireGS9F2(t)
	for _, state := range []string{"resolved", "completed"} {
		t.Run(state, func(t *testing.T) {
			pool := testsupport.OpenPostgres(t)
			repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
			aborted := false
			repo.commitTransaction = func(ctx context.Context, tx pgx.Tx) error {
				var actual, id string
				err := tx.QueryRow(ctx, "SELECT state,lease_id FROM workflow_runner_authority_bindings").Scan(&actual, &id)
				if err == nil && actual == state && !aborted {
					aborted = true
					if err = tx.Rollback(ctx); err != nil {
						return err
					}
					expireLeaseAtDatabase(t, repo.pool, id)
					return &pgconn.PgError{Code: "40001", ConstraintName: "workflow_runner_recovery_version_retry", Detail: "fixture-expired-evidence"}
				}
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return err
				}
				return tx.Commit(ctx)
			}
			view := exerciseGS9F2BindingLifecycleUntil(t, repo, runnerbindingcontract.OperationCheckpointCommit, "metadata-expired-"+state, nil, state, "")
			if !aborted || view.State != state {
				t.Fatal("evidence retry did not retain its historical result")
			}
		})
	}
}

func TestRecoveryMetadataLegacyRetriesKeepUnknownReconciliationSeparate(t *testing.T) {
	for _, event := range []bool{false, true} {
		for _, unknown := range []bool{false, true} {
			t.Run(fmt.Sprintf("event=%t/unknown=%t", event, unknown), func(t *testing.T) {
				tr := &metadataWaitTracer{waiting: make(chan struct{}, 1)}
				pool := testsupport.OpenPostgresWithTracer(t, tr)
				repo := New(pool)
				input := jobInput(t, "legacy-metadata")
				workspace, run := input.Prepared.Spec.WorkspaceID, input.Prepared.Spec.WorkflowRunID
				var message runnerstore.RecordEventInput
				if event {
					lease := submitAndClaim(t, repo, "legacy-metadata")
					message = leaseAcceptInput(t, lease, "event-legacy-metadata")
				}
				attempts := 0
				if unknown {
					repo.commitTransaction = func(ctx context.Context, tx pgx.Tx) error {
						attempts++
						if attempts > 1 {
							return fmt.Errorf("normal transaction replayed after an unknown commit")
						}
						if err := tx.Rollback(ctx); err != nil {
							return err
						}
						return &pgconn.PgError{Code: "40003", Message: "statement completion unknown"}
					}
				}
				lock := holdRecoveryVersion(t, repo, workspace, run)
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				defer cancel()
				done := make(chan error, 1)
				go func() {
					expected := runnerstore.ReceiptAccepted
					if unknown {
						expected = runnerstore.ReceiptReconciliationRequired
					}
					var err error
					if event {
						var result runnerstore.RecordedEvent
						result, err = repo.RecordEvent(ctx, message)
						if err == nil && result.Status != expected {
							err = fmt.Errorf("event status=%s want=%s", result.Status, expected)
						}
					} else {
						var result runnerstore.JobReceipt
						result, err = repo.Submit(ctx, input)
						if err == nil && result.Status != expected {
							err = fmt.Errorf("submission status=%s want=%s", result.Status, expected)
						}
					}
					done <- err
				}()
				select {
				case <-tr.waiting:
				case err := <-done:
					t.Fatalf("metadata transaction did not retry: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if err := lock.Rollback(t.Context()); err != nil {
					t.Fatal(err)
				}
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				if unknown && attempts != 1 {
					t.Fatal("reconciliation re-executed the original operation", attempts)
				}
				var jobs, events, reconciliations int
				if err := pool.QueryRow(t.Context(), "SELECT (SELECT count(*) FROM workflow_runner_jobs),(SELECT count(*) FROM workflow_runner_worker_events),(SELECT count(*) FROM workflow_runner_reconciliations)").Scan(&jobs, &events, &reconciliations); err != nil {
					t.Fatal(err)
				}
				expectedEvents := 0
				if event {
					expectedEvents = 1
				}
				expectedReconciliations := 0
				if unknown {
					expectedReconciliations = 1
				}
				if jobs != 1 || events != expectedEvents || reconciliations != expectedReconciliations {
					t.Fatalf("unexpected durable writes jobs=%d events=%d reconciliation=%d", jobs, events, reconciliations)
				}
			})
		}
	}
}
