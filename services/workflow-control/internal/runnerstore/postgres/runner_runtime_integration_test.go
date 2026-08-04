package postgres

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

var errSimulatedCommitResponseLoss = errors.New("simulated PostgreSQL commit response loss")

func TestCommittedResponseLossRecoversRunnerReceipt(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "commit-response-loss")
	event := leaseAcceptInput(t, lease, "accept-commit-response-loss")

	lossy := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errSimulatedCommitResponseLoss
	})
	recovered, err := lossy.RecordEvent(ctx, event)
	if err != nil {
		t.Fatalf("recover committed runner receipt: %v", err)
	}
	if recovered.Status != runnerstore.ReceiptAccepted || recovered.Duplicate {
		t.Fatalf("unexpected recovered receipt: %+v", recovered)
	}
	assertEventRows(t, pool, lease.AttemptID, 1, 1, 2)
}

func TestUnknownCommitPersistsRunnerReconciliation(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	input := jobInput(t, "unknown-submit")
	unknown := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		_ = tx.Rollback(ctx)
		return errSimulatedCommitResponseLoss
	})

	receipt, err := unknown.Submit(ctx, input)
	if err != nil {
		t.Fatalf("persist submit reconciliation: %v", err)
	}
	if receipt.Status != runnerstore.ReceiptReconciliationRequired || receipt.State != runnerstore.JobReconciliationRequired || receipt.ReconciliationID == nil {
		t.Fatalf("unknown commit did not converge to reconciliation: %+v", receipt)
	}

	repository := New(pool)
	view, err := repository.ReadJob(ctx, input.Prepared.Spec.WorkspaceID, input.Prepared.Spec.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if view.State != runnerstore.JobReconciliationRequired || view.ReconciliationID == nil || *view.ReconciliationID != *receipt.ReconciliationID {
		t.Fatalf("durable reconciliation job mismatch: %+v", view)
	}
	replayed, err := repository.Submit(ctx, input)
	if err != nil {
		t.Fatalf("replay reconciled submission: %v", err)
	}
	if !bytes.Equal(replayed.ExactBytes, receipt.ExactBytes) || replayed.ReconciliationID == nil || *replayed.ReconciliationID != *receipt.ReconciliationID {
		t.Fatalf("reconciliation receipt is not stable: first=%+v replay=%+v", receipt, replayed)
	}
	if _, err := repository.ClaimNext(ctx, claimInput(input.Prepared.Spec.WorkspaceID)); !runnerstore.IsCode(err, runnerstore.ErrorNoWork) {
		t.Fatalf("reconciliation tombstone became dispatchable: %v", err)
	}
	var jobs, receipts, reconciliations int
	if err := pool.QueryRow(ctx, `
SELECT
    (SELECT count(*) FROM workflow_runner_jobs WHERE workspace_id=$1 AND job_id=$2 AND state='reconciliation_required'),
    (SELECT count(*) FROM workflow_runner_job_receipts WHERE idempotency_key=$3 AND status='reconciliation_required'),
    (SELECT count(*) FROM workflow_runner_reconciliations WHERE workspace_id=$1 AND job_id=$2)`,
		input.Prepared.Spec.WorkspaceID, input.Prepared.Spec.JobID, input.IdempotencyKey,
	).Scan(&jobs, &receipts, &reconciliations); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 || receipts != 1 || reconciliations != 1 {
		t.Fatalf("durable reconciliation cardinality = jobs:%d receipts:%d reconciliations:%d", jobs, receipts, reconciliations)
	}
}

func TestExpiredLeaseTakeoverIncrementsFence(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	first := submitAndClaim(t, repository, "expired-takeover")
	expireLeaseAtDatabase(t, pool, first.LeaseID)

	recovered, err := repository.RecoverExpired(ctx, runnerstore.RecoverExpiredInput{
		Now: time.Now().Add(365 * 24 * time.Hour), Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 1 || !recovered[0].SafeForNewAttempt || recovered[0].PreviousFence != first.FencingToken {
		t.Fatalf("unexpected expiry recovery: %+v", recovered)
	}
	second, err := repository.ClaimNext(ctx, claimInput(first.WorkspaceID))
	if err != nil {
		t.Fatal(err)
	}
	if second.FencingToken != first.FencingToken+1 || second.AttemptOrdinal != first.AttemptOrdinal+1 || second.AttemptID == first.AttemptID {
		t.Fatalf("takeover did not advance identity: first=%+v second=%+v", first, second)
	}
}

func TestStaleFenceCannotAdvanceAttempt(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	first := submitAndClaim(t, repository, "stale-fence")
	expireLeaseAtDatabase(t, pool, first.LeaseID)
	if _, err := repository.RecoverExpired(ctx, runnerstore.RecoverExpiredInput{
		Now: time.Time{}, Limit: 10,
	}); err != nil {
		t.Fatal(err)
	}
	second, err := repository.ClaimNext(ctx, claimInput(first.WorkspaceID))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.RecordEvent(ctx, leaseAcceptInput(t, first, "stale-accept")); !runnerstore.IsCode(err, runnerstore.ErrorStaleFence) {
		t.Fatalf("stale fence was not rejected: %v", err)
	}
	var currentFence, workerSequence int64
	var currentAttempt string
	if err := pool.QueryRow(ctx, `
SELECT j.current_fence, j.current_attempt_id, a.worker_sequence
FROM workflow_runner_jobs j JOIN workflow_runner_attempts a ON a.attempt_id=j.current_attempt_id
WHERE j.workspace_id=$1 AND j.job_id=$2`, first.WorkspaceID, first.JobID).Scan(&currentFence, &currentAttempt, &workerSequence); err != nil {
		t.Fatal(err)
	}
	if currentFence != second.FencingToken || currentAttempt != second.AttemptID || workerSequence != 0 {
		t.Fatalf("stale event advanced current attempt: fence=%d attempt=%q sequence=%d", currentFence, currentAttempt, workerSequence)
	}
	statistics, err := repository.Statistics(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if statistics.StaleFenceRejects != 1 {
		t.Fatalf("stale fence rejection metric = %d, want 1", statistics.StaleFenceRejects)
	}
}

func TestRecoverExpiredUsesDatabaseClockDespiteHostSkew(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "recovery-clock-skew")

	results, err := repository.RecoverExpired(ctx, runnerstore.RecoverExpiredInput{
		Now: time.Now().Add(100 * 365 * 24 * time.Hour), Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("host future clock expired a database-live lease: %+v", results)
	}
	expireLeaseAtDatabase(t, pool, lease.LeaseID)
	results, err = repository.RecoverExpired(ctx, runnerstore.RecoverExpiredInput{
		Now: time.Now().Add(-100 * 365 * 24 * time.Hour), Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].SafeForNewAttempt {
		t.Fatalf("host past clock hid a database-expired lease: %+v", results)
	}
}

func TestSubmitRejectsClientClockOutsideDatabaseWindow(t *testing.T) {
	tests := []struct {
		name   string
		offset time.Duration
	}{
		{name: "future", offset: 5 * time.Second},
		{name: "stale", offset: -6 * time.Minute},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := testsupport.OpenPostgres(t)
			ctx := t.Context()
			repository := New(pool)
			input := jobInputAt(t, "clock-"+test.name, time.Now().UTC().Add(test.offset), time.Hour)
			if _, err := repository.Submit(ctx, input); !runnerstore.IsCode(err, runnerstore.ErrorInputInvalid) {
				t.Fatalf("%s submittedAt was not rejected against database time: %v", test.name, err)
			}
			var rows int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runner_jobs WHERE workspace_id=$1 AND job_id=$2`, input.Prepared.Spec.WorkspaceID, input.Prepared.Spec.JobID).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			if rows != 0 {
				t.Fatalf("rejected %s submission persisted %d jobs", test.name, rows)
			}
		})
	}
}

func TestEffectAmbiguityRequiresReconciliation(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "effect-ambiguity")
	if _, err := repository.RecordEvent(ctx, leaseAcceptInput(t, lease, "accept-effect-ambiguity")); err != nil {
		t.Fatal(err)
	}
	effect := leasedEventInput(t, lease, runnerprotocol.KindEffectIntent, 2, "effect-ambiguous", map[string]any{
		"effectId": "effect-1", "effectKind": "collaboration.event",
		"effectHash": strings.Repeat("1", 64), "capabilityHash": strings.Repeat("2", 64),
		"requiresHumanDecision": false,
	})
	unknown := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		_ = tx.Rollback(ctx)
		return errSimulatedCommitResponseLoss
	})
	receipt, err := unknown.RecordEvent(ctx, effect)
	if err != nil {
		t.Fatalf("persist ambiguous effect reconciliation: %v", err)
	}
	if receipt.Status != runnerstore.ReceiptReconciliationRequired || receipt.JobState != runnerstore.JobReconciliationRequired || receipt.AttemptState != runnerstore.AttemptReconciliationRequired {
		t.Fatalf("effect ambiguity did not stop in reconciliation: %+v", receipt)
	}
	view, err := repository.ReadJob(ctx, lease.WorkspaceID, lease.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if view.State != runnerstore.JobReconciliationRequired || view.ReconciliationID == nil {
		t.Fatalf("effect reconciliation is not durable: %+v", view)
	}
	replayed, err := repository.RecordEvent(ctx, effect)
	if err != nil {
		t.Fatalf("replay ambiguous effect: %v", err)
	}
	if !replayed.Duplicate || !bytes.Equal(replayed.ReceiptBytes, receipt.ReceiptBytes) {
		t.Fatalf("ambiguous effect receipt is not stable: first=%+v replay=%+v", receipt, replayed)
	}
}

func TestEffectOutcomeCommitDetectionDoesNotDependOnXmin(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "effect-outcome-commit-detection")
	if _, err := repository.RecordEvent(ctx, leaseAcceptInput(t, lease, "accept-effect-outcome-commit-detection")); err != nil {
		t.Fatal(err)
	}
	intent := leasedEventInput(t, lease, runnerprotocol.KindEffectIntent, 2, "intent-effect-outcome-commit-detection", map[string]any{
		"effectId": "effect-commit-detection", "effectKind": "openslack.task.sync",
		"effectHash": strings.Repeat("1", 64), "capabilityHash": strings.Repeat("2", 64),
		"requiresHumanDecision": false,
	})
	if _, err := repository.RecordEvent(ctx, intent); err != nil {
		t.Fatal(err)
	}
	outcome := leasedEventInput(t, lease, runnerprotocol.KindEffectOutcome, 3, "outcome-effect-outcome-commit-detection", map[string]any{
		"effectId": "effect-commit-detection", "status": "executed", "outcomeHash": strings.Repeat("3", 64),
	})
	var observed atomic.Bool
	var injected atomic.Bool
	unknown := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workflow_runner_worker_events WHERE workspace_id=$1 AND job_id=$2 AND event_id=$3 AND kind='effect_outcome')`, lease.WorkspaceID, lease.JobID, outcome.Message.EventID).Scan(&exists); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if exists {
			observed.Store(true)
		}
		if exists && injected.CompareAndSwap(false, true) {
			_ = tx.Rollback(ctx)
			return errSimulatedCommitResponseLoss
		}
		return tx.Commit(ctx)
	})
	receipt, err := unknown.RecordEvent(ctx, outcome)
	if err != nil {
		t.Fatalf("persist deterministic effect outcome reconciliation: %v", err)
	}
	if !observed.Load() || !injected.Load() || receipt.Status != runnerstore.ReceiptReconciliationRequired || receipt.JobState != runnerstore.JobReconciliationRequired {
		t.Fatalf("effect outcome commit was not deterministically intercepted: observed=%v injected=%v receipt=%+v", observed.Load(), injected.Load(), receipt)
	}
	view, err := repository.ReadJob(ctx, lease.WorkspaceID, lease.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if view.State != runnerstore.JobReconciliationRequired || view.OpenEffectCount != 1 || view.ReconciliationID == nil {
		t.Fatalf("effect outcome ambiguity did not preserve the open boundary: %+v", view)
	}
}

func TestDuplicateExactEventReturnsReceiptAndAdvancesOnce(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "duplicate-exact")
	event := leaseAcceptInput(t, lease, "accept-duplicate-exact")
	first, err := repository.RecordEvent(ctx, event)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := repository.RecordEvent(ctx, event)
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate.Duplicate || !bytes.Equal(first.ReceiptBytes, duplicate.ReceiptBytes) || first.Receipt.EventID != duplicate.Receipt.EventID {
		t.Fatalf("duplicate did not return the exact durable receipt: first=%+v duplicate=%+v", first, duplicate)
	}
	assertEventRows(t, pool, lease.AttemptID, 1, 1, 2)
	view, err := repository.ReadJob(ctx, lease.WorkspaceID, lease.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Revision != 3 || view.State != runnerstore.JobRunning {
		t.Fatalf("duplicate advanced job twice: %+v", view)
	}
}

func TestNegotiationWithIndependentPreleaseCorrelation(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "independent-correlation")
	hello := helloEnvelope(lease.WorkspaceID, "hello-correlation-independent", exactCapabilities(), int64(1))
	input := negotiationInput(t, lease, hello)
	negotiation, err := repository.RecordNegotiation(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if hello.CorrelationID == lease.CorrelationID || negotiation.HelloAck.CorrelationID != hello.CorrelationID {
		t.Fatalf("pre-lease correlation was not mirrored independently: hello=%q lease=%q ack=%q", hello.CorrelationID, lease.CorrelationID, negotiation.HelloAck.CorrelationID)
	}
	var capabilities []string
	if err := pool.QueryRow(ctx, `SELECT capabilities FROM workflow_runner_process_sessions WHERE attempt_id=$1`, lease.AttemptID).Scan(&capabilities); err != nil {
		t.Fatal(err)
	}
	if strings.Join(capabilities, ",") != "cancel_ack,effect_receipts,lease_heartbeat" {
		t.Fatalf("persisted capabilities = %v", capabilities)
	}
}

func TestNegotiationRejectsIncompleteRuntimeCapabilities(t *testing.T) {
	tests := []struct {
		name          string
		capabilities  []any
		maxConcurrent int64
	}{
		{name: "missing capability", capabilities: []any{"cancel_ack", "effect_receipts"}, maxConcurrent: 1},
		{name: "concurrency greater than one", capabilities: exactCapabilities(), maxConcurrent: 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := testsupport.OpenPostgres(t)
			ctx := t.Context()
			repository := New(pool)
			lease := submitAndClaim(t, repository, "reject-"+strings.ReplaceAll(test.name, " ", "-"))
			hello := helloEnvelope(lease.WorkspaceID, "hello-correlation-rejected", test.capabilities, test.maxConcurrent)
			if _, err := repository.RecordNegotiation(ctx, negotiationInput(t, lease, hello)); !runnerstore.IsCode(err, runnerstore.ErrorInputInvalid) {
				t.Fatalf("invalid hello was not rejected pre-lease: %v", err)
			}
			var sessions int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runner_process_sessions WHERE attempt_id=$1`, lease.AttemptID).Scan(&sessions); err != nil {
				t.Fatal(err)
			}
			if sessions != 0 {
				t.Fatalf("invalid hello persisted %d process sessions", sessions)
			}
		})
	}
}

func TestReceiptProvenTerminalSurvivesNonzeroProcessExit(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "terminal-process-exit")
	if _, err := repository.RecordEvent(ctx, leaseAcceptInput(t, lease, "accept-terminal-process-exit")); err != nil {
		t.Fatal(err)
	}
	resultHash := strings.Repeat("9", 64)
	finishedAt := canonicalNow()
	terminal := leasedEventInputAt(t, lease, runnerprotocol.KindTerminal, 2, "terminal-completed", finishedAt, map[string]any{
		"status": string(runnerprotocol.TerminalCompleted), "finishedAt": finishedAt,
		"resultHash": resultHash, "terminalReason": nil,
	})
	if _, err := repository.RecordEvent(ctx, terminal); err != nil {
		t.Fatal(err)
	}

	view, err := repository.RecordProcessExit(ctx, runnerstore.ProcessExitInput{
		WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, AttemptID: lease.AttemptID,
		LeaseID: lease.LeaseID, FencingToken: lease.FencingToken,
		Class: runnerstore.ProcessCrashed, ObservedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.State != runnerstore.JobTerminal || view.TerminalStatus == nil || *view.TerminalStatus != runnerprotocol.TerminalCompleted || view.ResultHash == nil || *view.ResultHash != resultHash || view.TerminalReason != nil {
		t.Fatalf("process exit overwrote receipt-proven terminal: %+v", view)
	}
	var exitEvidence int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runner_attempts WHERE attempt_id=$1 AND process_exit_class IS NOT NULL`, lease.AttemptID).Scan(&exitEvidence); err != nil {
		t.Fatal(err)
	}
	if exitEvidence != 0 {
		t.Fatal("late process exit mutated receipt-proven attempt evidence")
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	cancelInput := runnerstore.CancelInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, CorrelationID: lease.CorrelationID, ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken, Reason: "operator", Now: now, ExpiresAt: now.Add(time.Minute)}
	cancelInput.IdempotencyKey, cancelInput.RequestFingerprint, _ = runnerstore.CancelBindings(cancelInput)
	if _, err := repository.RequestCancel(ctx, cancelInput); !runnerstore.IsCode(err, runnerstore.ErrorConflict) {
		t.Fatalf("receipt-proven terminal accepted a new cancellation: %v", err)
	}
}

func TestDispatchFailuresBackOffAndBecomeDeadReconciliation(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	input := jobInput(t, "bounded-dispatch")
	if _, err := repository.Submit(ctx, input); err != nil {
		t.Fatal(err)
	}
	for failure := int64(1); failure <= runnerstore.MaxDispatchFailures; failure++ {
		lease, err := repository.ClaimNext(ctx, claimInput(input.Prepared.Spec.WorkspaceID))
		if err != nil {
			t.Fatalf("claim dispatch attempt %d: %v", failure, err)
		}
		view, err := repository.RecordAttemptFailure(ctx, runnerstore.AttemptFailureInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken, Kind: runnerstore.AttemptLaunchFailed, ObservedAt: time.Now().UTC()})
		if err != nil {
			t.Fatalf("record dispatch failure %d: %v", failure, err)
		}
		if failure < runnerstore.MaxDispatchFailures {
			if view.State != runnerstore.JobQueued {
				t.Fatalf("failure %d state=%s want queued", failure, view.State)
			}
			if _, err := repository.ClaimNext(ctx, claimInput(input.Prepared.Spec.WorkspaceID)); !runnerstore.IsCode(err, runnerstore.ErrorNoWork) {
				t.Fatalf("failure %d ignored durable backoff: %v", failure, err)
			}
			if _, err := pool.Exec(ctx, `UPDATE workflow_runner_jobs SET dispatch_not_before=clock_timestamp()-interval '1 millisecond' WHERE workspace_id=$1 AND job_id=$2`, lease.WorkspaceID, lease.JobID); err != nil {
				t.Fatal(err)
			}
		} else if view.State != runnerstore.JobReconciliationRequired || view.ReconciliationID == nil {
			t.Fatalf("dispatch exhaustion did not fail closed: %+v", view)
		}
	}
	if _, err := repository.ClaimNext(ctx, claimInput(input.Prepared.Spec.WorkspaceID)); !runnerstore.IsCode(err, runnerstore.ErrorNoWork) {
		t.Fatalf("dead dispatch job became claimable: %v", err)
	}
	var failures int64
	var dispatchState string
	if err := pool.QueryRow(ctx, `SELECT dispatch_failures,dispatch_state FROM workflow_runner_jobs WHERE workspace_id=$1 AND job_id=$2`, input.Prepared.Spec.WorkspaceID, input.Prepared.Spec.JobID).Scan(&failures, &dispatchState); err != nil {
		t.Fatal(err)
	}
	if failures != runnerstore.MaxDispatchFailures || dispatchState != "dead" {
		t.Fatalf("durable dispatch state=%s failures=%d", dispatchState, failures)
	}
}

func TestCancelAckInputBindsAcknowledgedAtToEnvelopeTime(t *testing.T) {
	lease := runnerstore.AttemptLease{
		WorkspaceID: "workspace.fixture", JobID: "job.fixture", WorkflowRunID: "run.fixture",
		CorrelationID: "correlation.fixture", AttemptID: "attempt.fixture",
		LeaseID: "lease.fixture", FencingToken: 1,
	}
	input := cancelAckInput(t, lease, 1, "cancel-ack-fixture", "cancel.fixture", "cancelling")
	acknowledgedAt, ok := input.Message.Payload["acknowledgedAt"].(string)
	if !ok {
		t.Fatalf("cancel acknowledgement fixture has non-string acknowledgedAt: %T", input.Message.Payload["acknowledgedAt"])
	}
	if acknowledgedAt != input.Message.SentAt {
		t.Fatalf("cancel acknowledgement fixture time mismatch: payload=%s envelope=%s", acknowledgedAt, input.Message.SentAt)
	}
	if _, err := runnerstore.ValidateRecordEventInput(input); err != nil {
		t.Fatalf("cancel acknowledgement fixture is invalid: %v", err)
	}
}

func TestCancelAckMustBindPersistedCancel(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "cancel-ack-binding")
	now := time.Now().UTC().Truncate(time.Millisecond)
	input := runnerstore.CancelInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, CorrelationID: lease.CorrelationID, ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken, Reason: "operator", Now: now, ExpiresAt: now.Add(time.Minute)}
	input.IdempotencyKey, input.RequestFingerprint, _ = runnerstore.CancelBindings(input)
	if _, err := repository.RequestCancel(ctx, input); err != nil {
		t.Fatal(err)
	}
	ack := cancelAckInput(t, lease, 1, "cancel-ack-wrong", "cancel.not-the-control", "cancelling")
	if _, err := repository.RecordEvent(ctx, ack); !runnerstore.IsCode(err, runnerstore.ErrorIdentityMismatch) {
		t.Fatalf("unbound cancel acknowledgement was accepted: %v", err)
	}
}

func TestLateAlreadyTerminalCancelAckPreservesReceiptProvenTerminal(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "late-cancel-ack")
	if _, err := repository.RecordEvent(ctx, leaseAcceptInput(t, lease, "accept-late-cancel-ack")); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	cancelInput := runnerstore.CancelInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, CorrelationID: lease.CorrelationID, ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken, Reason: "operator", Now: now, ExpiresAt: now.Add(time.Minute)}
	cancelInput.IdempotencyKey, cancelInput.RequestFingerprint, _ = runnerstore.CancelBindings(cancelInput)
	control, err := repository.RequestCancel(ctx, cancelInput)
	if err != nil {
		t.Fatal(err)
	}
	finishedAt := canonicalNow()
	terminal := leasedEventInputAt(t, lease, runnerprotocol.KindTerminal, 2, "terminal-before-cancel-ack", finishedAt, map[string]any{"status": "cancelled", "finishedAt": finishedAt, "resultHash": nil, "terminalReason": "cancelled_by_control"})
	if _, err := repository.RecordEvent(ctx, terminal); err != nil {
		t.Fatal(err)
	}
	wrongStatus := cancelAckInput(t, lease, 3, "late-cancel-ack-wrong-status", control.CancelID, "cancelling")
	if _, err := repository.RecordEvent(ctx, wrongStatus); !runnerstore.IsCode(err, runnerstore.ErrorConflict) {
		t.Fatalf("terminal cancel ack with nonterminal status was accepted: %v", err)
	}
	ack := cancelAckInput(t, lease, 3, "late-cancel-ack-valid", control.CancelID, "already_terminal")
	if _, err := repository.RecordEvent(ctx, ack); err != nil {
		t.Fatalf("receipt-proven terminal rejected bound already_terminal ack: %v", err)
	}
	view, err := repository.ReadJob(ctx, lease.WorkspaceID, lease.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if view.State != runnerstore.JobTerminal || view.AttemptState == nil || *view.AttemptState != runnerstore.AttemptTerminal || view.TerminalStatus == nil || *view.TerminalStatus != runnerprotocol.TerminalCancelled || view.TerminalReason == nil || *view.TerminalReason != "cancelled_by_control" {
		t.Fatalf("late cancel ack regressed terminal evidence: %+v", view)
	}
}

func TestTerminalEventRequiresReceiptGatedRunningAttempt(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "terminal-from-offered")
	finishedAt := canonicalNow()
	terminal := leasedEventInputAt(t, lease, runnerprotocol.KindTerminal, 1, "terminal-from-offered", finishedAt, map[string]any{"status": "failed", "finishedAt": finishedAt, "resultHash": nil, "terminalReason": "workflow_failed"})
	if _, err := repository.RecordEvent(ctx, terminal); !runnerstore.IsCode(err, runnerstore.ErrorConflict) {
		t.Fatalf("offered attempt forged terminal transition: %v", err)
	}
	view, err := repository.ReadJob(ctx, lease.WorkspaceID, lease.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if view.State != runnerstore.JobOffered || view.TerminalStatus != nil {
		t.Fatalf("rejected terminal mutated offered job: %+v", view)
	}
}

func TestCancelDeliveryUpdatesBothRecordsAtomically(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := t.Context()
	repository := New(pool)
	lease := submitAndClaim(t, repository, "cancel-delivery-atomic")
	now := time.Now().UTC().Truncate(time.Millisecond)
	input := runnerstore.CancelInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, CorrelationID: lease.CorrelationID, ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken, Reason: "operator", Now: now, ExpiresAt: now.Add(time.Minute)}
	input.IdempotencyKey, input.RequestFingerprint, _ = runnerstore.CancelBindings(input)
	control, err := repository.RequestCancel(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_cancel_sent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='sent' THEN RAISE EXCEPTION 'simulated cancel update failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_cancel_sent BEFORE UPDATE ON workflow_runner_cancel_controls FOR EACH ROW EXECUTE FUNCTION reject_cancel_sent()`); err != nil {
		t.Fatal(err)
	}
	if err := repository.MarkControlDelivered(ctx, lease.AttemptID, control.Message.EventID, string(runnerprotocol.KindCancelRequest), now); err == nil {
		t.Fatal("cancel delivery unexpectedly ignored cancel-state update failure")
	}
	var deliveryState, cancelState string
	if err := pool.QueryRow(ctx, `SELECT m.delivery_state,c.state FROM workflow_runner_control_messages m JOIN workflow_runner_cancel_controls c ON c.control_event_id=m.control_event_id WHERE m.control_event_id=$1`, control.Message.EventID).Scan(&deliveryState, &cancelState); err != nil {
		t.Fatal(err)
	}
	if deliveryState != "pending" || cancelState != "pending" {
		t.Fatalf("failed atomic cancel delivery partially committed: message=%s cancel=%s", deliveryState, cancelState)
	}
}

func jobInput(t testing.TB, suffix string) runnerstore.SubmitInput {
	t.Helper()
	return jobInputAt(t, suffix, time.Now().UTC(), time.Hour)
}

func jobInputAt(t testing.TB, suffix string, submittedAt time.Time, wholeTimeout time.Duration) runnerstore.SubmitInput {
	t.Helper()
	prepared, err := runnerstore.PrepareJobSpec(runnerstore.JobSpec{
		Schema: runnerstore.JobSpecSchema, WorkspaceID: "workspace-" + suffix,
		JobID: "job-" + suffix, WorkflowRunID: "run-" + suffix,
		CorrelationID:           "correlation-" + suffix,
		ExecutionDescriptorRef:  "descriptor-" + suffix,
		ExecutionDescriptorHash: strings.Repeat("a", 64),
		WorkflowID:              "workflow-" + suffix, WorkflowVersion: "1.0.0",
		WorkflowSourceHash: strings.Repeat("b", 64), ManifestHash: strings.Repeat("c", 64),
		InputHash: strings.Repeat("d", 64), WholeTimeoutMS: wholeTimeout.Milliseconds(),
		SubmittedAt: runnerstore.CanonicalTimestamp(submittedAt),
	})
	if err != nil {
		t.Fatal(err)
	}
	key, fingerprint := runnerstore.SubmissionBindings(prepared)
	return runnerstore.SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint}
}

func expireLeaseAtDatabase(t testing.TB, pool interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, leaseID string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
UPDATE workflow_runner_leases
SET created_at=clock_timestamp()-interval '3 seconds',
    offer_expires_at=clock_timestamp()-interval '2 seconds',
    lease_expires_at=clock_timestamp()-interval '1 second',
    updated_at=clock_timestamp()
WHERE lease_id=$1`, leaseID); err != nil {
		t.Fatal(err)
	}
}

func submitAndClaim(t testing.TB, repository *Repository, suffix string) runnerstore.AttemptLease {
	t.Helper()
	input := jobInput(t, suffix)
	if _, err := repository.Submit(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	lease, err := repository.ClaimNext(context.Background(), claimInput(input.Prepared.Spec.WorkspaceID))
	if err != nil {
		t.Fatal(err)
	}
	return lease
}

func claimInput(workspaceID string) runnerstore.ClaimInput {
	return runnerstore.ClaimInput{
		WorkspaceID: workspaceID, SupervisorInstanceID: "supervisor-test",
		LeaseOfferTimeout: 30 * time.Second, LeaseDuration: 10 * time.Minute,
		Now: time.Now().UTC(),
	}
}

func leaseAcceptInput(t testing.TB, lease runnerstore.AttemptLease, eventID string) runnerstore.RecordEventInput {
	t.Helper()
	sentAt := canonicalNow()
	return leasedEventInputAt(t, lease, runnerprotocol.KindLeaseAccept, 1, eventID, sentAt, map[string]any{
		"acceptedAt": sentAt, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt),
	})
}

func cancelAckInput(t testing.TB, lease runnerstore.AttemptLease, sequence int64, eventID, cancelID, status string) runnerstore.RecordEventInput {
	t.Helper()
	sentAt := canonicalNow()
	return leasedEventInputAt(t, lease, runnerprotocol.KindCancelAck, sequence, eventID, sentAt, map[string]any{
		"cancelId": cancelID, "acknowledgedAt": sentAt, "status": status,
	})
}

func leasedEventInput(t testing.TB, lease runnerstore.AttemptLease, kind runnerprotocol.Kind, sequence int64, eventID string, payload map[string]any) runnerstore.RecordEventInput {
	t.Helper()
	return leasedEventInputAt(t, lease, kind, sequence, eventID, canonicalNow(), payload)
}

func leasedEventInputAt(t testing.TB, lease runnerstore.AttemptLease, kind runnerprotocol.Kind, sequence int64, eventID, sentAt string, payload map[string]any) runnerstore.RecordEventInput {
	t.Helper()
	jobID, runID, attemptID, leaseID, fence := lease.JobID, lease.WorkflowRunID, lease.AttemptID, lease.LeaseID, lease.FencingToken
	message := runnerprotocol.Envelope{
		ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: kind, WorkspaceID: lease.WorkspaceID,
		JobID: &jobID, WorkflowRunID: &runID, AttemptID: &attemptID, LeaseID: &leaseID,
		FencingToken: &fence, Sequence: &sequence, EventID: eventID,
		CorrelationID: lease.CorrelationID, SentAt: sentAt, Payload: payload,
	}
	input := runnerstore.RecordEventInput{
		Message: message, ExactBytes: canonicalEnvelope(t, message),
		ControlBuildHash: strings.Repeat("f", 64), Now: time.Now().UTC(),
	}
	if _, err := runnerstore.ValidateRecordEventInput(input); err != nil {
		t.Fatalf("leased event fixture is invalid: %v", err)
	}
	return input
}

func helloEnvelope(workspaceID, correlationID string, capabilities []any, maxConcurrentJobs int64) runnerprotocol.Envelope {
	return runnerprotocol.Envelope{
		ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: runnerprotocol.KindHello,
		WorkspaceID: workspaceID, EventID: "hello-event", CorrelationID: correlationID,
		SentAt: canonicalNow(), Payload: map[string]any{
			"runtimeName": "node", "runtimeVersion": "22.0.0",
			"runnerBuildHash":           strings.Repeat("e", 64),
			"supportedProtocolVersions": []any{runnerprotocol.ProtocolVersion},
			"capabilities":              capabilities, "maxConcurrentJobs": maxConcurrentJobs,
		},
	}
}

func negotiationInput(t testing.TB, lease runnerstore.AttemptLease, hello runnerprotocol.Envelope) runnerstore.NegotiationInput {
	t.Helper()
	return runnerstore.NegotiationInput{
		Lease: lease, Hello: hello, ExactBytes: canonicalEnvelope(t, hello),
		ControlBuildHash: strings.Repeat("f", 64), HeartbeatInterval: time.Second,
		LeaseOfferTimeout: 30 * time.Second, Now: time.Now().UTC(),
	}
}

func exactCapabilities() []any {
	return []any{"cancel_ack", "effect_receipts", "lease_heartbeat"}
}

func canonicalEnvelope(t testing.TB, message runnerprotocol.Envelope) []byte {
	t.Helper()
	body, err := runnerprotocol.CanonicalEnvelopeBytes(message)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func canonicalNow() string {
	return runnerstore.CanonicalTimestamp(time.Now().UTC())
}

func assertEventRows(t testing.TB, pool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, attemptID string, wantEvents, wantWorkerSequence, wantControlSequence int64) {
	t.Helper()
	var events, workerSequence, controlSequence int64
	if err := pool.QueryRow(context.Background(), `
SELECT
    (SELECT count(*) FROM workflow_runner_worker_events WHERE attempt_id=$1),
    worker_sequence,
    control_sequence
FROM workflow_runner_attempts WHERE attempt_id=$1`, attemptID).Scan(&events, &workerSequence, &controlSequence); err != nil {
		t.Fatal(err)
	}
	if events != wantEvents || workerSequence != wantWorkerSequence || controlSequence != wantControlSequence {
		t.Fatalf("event advancement = rows:%d worker:%d control:%d; want %d/%d/%d", events, workerSequence, controlSequence, wantEvents, wantWorkerSequence, wantControlSequence)
	}
}
