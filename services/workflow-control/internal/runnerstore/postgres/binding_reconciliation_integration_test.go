package postgres

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	authoritypostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/storageproof"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestBindingReconciliationRejectsOtherSchemaWithoutBusinessWrites(t *testing.T) {
	repo, source, v, _ := reconciliationFixture(t, runnerbindingcontract.OperationResumeAdvance, "staged")
	ctx := context.Background()
	expireReconciliationLease(t, repo.pool, v)
	other := testsupport.OpenPostgres(t)
	if _, err := other.Exec(ctx, `CREATE TABLE schema_migrations(version BIGINT PRIMARY KEY,dirty BOOLEAN NOT NULL);INSERT INTO schema_migrations VALUES(10,false)`); err != nil {
		t.Fatal(err)
	}
	writer := authoritypostgres.New(other, 10)
	repo.WithReconciliationWriter(func(ctx context.Context, c storageproof.Challenge, _ int64) (storageproof.Answer, error) {
		return writer.ProveStorage(ctx, c)
	}, "recovery-test")
	if _, err := repo.ApplyBindingReconciliation(ctx, reconciliationRequest(t, v, "not_committed")); !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
		t.Fatalf("different schema was not refused: %v", err)
	}
	for _, pool := range []*pgxpool.Pool{repo.pool, other} {
		var writes int
		if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM workflow_runner_binding_settlements)+(SELECT count(*) FROM workflow_control_source_fences)+(SELECT count(*) FROM workflow_control_recovery_pauses)`).Scan(&writes); err != nil || writes != 0 {
			t.Fatalf("identity refusal wrote business data: %d %v", writes, err)
		}
	}
	if _, err := source.Read(ctx, v.WorkspaceID, v.RunID); err != nil {
		t.Fatal("original source became unavailable", err)
	}
}

func TestBindingReconciliationRejectsClonedDatabaseLockDomain(t *testing.T) {
	requireGS9F2(t)
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.NewWithConfig(ctx, config.Copy())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var seed [8]byte
	if _, err := rand.Read(seed[:]); err != nil {
		t.Fatal(err)
	}
	name := "reconcile_" + hex.EncodeToString(seed[:])
	clone := name + "_clone"
	for _, database := range []string{name, clone} {
		defer func(database string) {
			if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{database}.Sanitize()); err != nil {
				t.Error("remove owned test database", err)
			}
		}(database)
	}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" TEMPLATE template0"); err != nil {
		t.Fatal(err)
	}
	open := func(database string) *pgxpool.Pool {
		cfg := config.Copy()
		cfg.ConnConfig.Database = database
		cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
		cfg.ConnConfig.RuntimeParams["search_path"] = "public"
		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		return pool
	}
	pool := open(name)
	defer pool.Close()
	// Clone only this test's freshly created database, never the configured database.
	migrations, err := filepath.Glob(filepath.Join(filepath.Dir(v2MigrationPath(t, "000010_reconcile_workflow_runner_bindings.up.sql")), "*.up.sql"))
	if err != nil || len(migrations) != 10 {
		pool.Close()
		t.Fatal("migration inventory changed", err)
	}
	for _, path := range migrations {
		raw, err := os.ReadFile(path)
		if err != nil {
			pool.Close()
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(raw)); err != nil {
			pool.Close()
			t.Fatal(err)
		}
	}
	_, _, v, _ := reconciliationFixtureInPool(t, pool, 10, runnerbindingcontract.OperationResumeAdvance, "staged")
	expireReconciliationLease(t, pool, v)
	pool.Close()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{clone}.Sanitize()+" TEMPLATE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	local, remote := open(name), open(clone)
	defer local.Close()
	defer remote.Close()
	writer := authoritypostgres.New(remote, 10)
	checked := false
	repo := NewForV2RuntimeDelivery(local, runnerstore.V2AuthorityPorts{}).WithReconciliationWriter(func(ctx context.Context, c storageproof.Challenge, _ int64) (storageproof.Answer, error) {
		a, err := writer.ProveStorage(ctx, c)
		if err != nil {
			return a, err
		}
		original, err := authoritypostgres.New(local, 10).ProveStorage(ctx, c)
		if err != nil || !reflect.DeepEqual(original.Relations, a.Relations) || original.DatabaseOID == a.DatabaseOID || !original.LockObserved || a.LockObserved {
			t.Fatal("clone did not exercise identical relation OIDs and distinct database lock domains", err)
		}
		checked = true
		return a, nil
	}, "recovery-test")
	if _, err := repo.ApplyBindingReconciliation(ctx, reconciliationRequest(t, v, "not_committed")); !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) || !checked {
		t.Fatalf("cloned database was not refused: %v", err)
	}
	for _, pool := range []*pgxpool.Pool{local, remote} {
		var writes int
		if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM workflow_runner_binding_settlements)+(SELECT count(*) FROM workflow_control_source_fences)+(SELECT count(*) FROM workflow_control_recovery_pauses)`).Scan(&writes); err != nil || writes != 0 {
			t.Fatalf("cloned database refusal wrote business data: %d %v", writes, err)
		}
	}
}

func reconciliationFixture(t *testing.T, operation runnerbindingcontract.Operation, stop string, variant ...string) (*Repository, *authoritypostgres.Repository, runnerstore.V2AuthorityBindingView, authoritystore.RunRecord) {
	t.Helper()
	requireGS9F2(t)
	return reconciliationFixtureInPool(t, testsupport.OpenPostgres(t), 10, operation, stop, variant...)
}

func reconciliationFixtureInPool(t *testing.T, pool *pgxpool.Pool, version int64, operation runnerbindingcontract.Operation, stop string, variant ...string) (*Repository, *authoritypostgres.Repository, runnerstore.V2AuthorityBindingView, authoritystore.RunRecord) {
	t.Helper()
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `CREATE TABLE schema_migrations(version BIGINT PRIMARY KEY,dirty BOOLEAN NOT NULL);INSERT INTO schema_migrations VALUES($1,false)`, version); err != nil {
		t.Fatal(err)
	}
	source := authoritypostgres.New(pool, version)
	repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{}).WithReconciliationWriter(func(ctx context.Context, c storageproof.Challenge, _ int64) (storageproof.Answer, error) {
		return source.ProveStorage(ctx, c)
	}, "recovery-test")
	repo.schemaVersion = version
	v := exerciseGS9F2BindingLifecycleUntil(t, repo, operation, "reconcile-fixture", nil, stop, "", variant...)
	stage, _ := runnerbindingcontract.ParseStageBytes(v.ExactStageBytes)
	route := bindingRecord(stage, "route")
	record := authoritystore.RunRecord{Schema: authoritystore.RunRecordSchema, WorkspaceID: v.WorkspaceID, RunID: v.RunID, WorkflowID: "workflow-reconcile-fixture", WorkflowVersion: "1.0.0",
		WorkflowSourceHash: strings.Repeat("2", 64), ManifestHash: strings.Repeat("3", 64), InputHash: strings.Repeat("4", 64), Route: authoritycontract.Route{Backend: "go", Authority: "workflow-control", RoutingEpoch: bindingInt(route, "routingEpoch"), AuthorityBuildHash: bindingString(route, "authorityBuildHash")}}
	if operation == runnerbindingcontract.OperationBudgetReserve || operation == runnerbindingcontract.OperationBudgetSettle {
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT canonical_record_bytes FROM workflow_control_runs WHERE workspace_id=$1 AND run_id=$2`, v.WorkspaceID, v.RunID).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &record); err != nil {
			t.Fatal(err)
		}
		return repo, source, v, record
	}
	for _, state := range []authoritystore.RunState{"created", "previewed", "confirmed", "running"} {
		input := reconciliationMutation(t, record, state, record.ResumeGeneration, "seed."+string(state))
		if _, err := source.Mutate(ctx, input); err != nil {
			t.Fatal(err)
		}
		record = input.Prepared.Envelope.Record
	}
	if operation == runnerbindingcontract.OperationResumeAdvance {
		input := reconciliationMutation(t, record, "paused", 0, "seed.pause")
		if _, err := source.Mutate(ctx, input); err != nil {
			t.Fatal(err)
		}
		record = input.Prepared.Envelope.Record
	}
	return repo, source, v, record
}

func reconciliationMutation(t *testing.T, prior authoritystore.RunRecord, state authoritystore.RunState, generation int64, correlation string) authoritystore.MutateInput {
	t.Helper()
	expected := authoritystore.ExpectedBinding{Revision: prior.Revision, CurrentPhaseID: prior.CurrentPhaseID, CurrentPhaseIndex: prior.CurrentPhaseIndex, ResumeGeneration: prior.ResumeGeneration}
	op, schema := authoritystore.OperationTransition, authoritystore.TransitionSchema
	if prior.Revision == 0 {
		op, schema = authoritystore.OperationAccept, authoritystore.AcceptSchema
	} else {
		s := prior.State
		expected.State = &s
	}
	record := prior
	record.State = state
	record.Revision++
	record.ResumeGeneration = generation
	if state == "resuming" {
		id, index := "phase-0", int64(0)
		record.CurrentPhaseID, record.CurrentPhaseIndex = &id, &index
	}
	envelope := authoritystore.RequestEnvelope{Schema: schema, Operation: op, WorkspaceID: record.WorkspaceID, RunID: record.RunID, Route: record.Route, Expected: expected, Record: record, CorrelationID: correlation}
	raw, err := canonicaljson.Encode(envelope)
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	prepared, err := authoritystore.PrepareRequest(raw, "recovery-test", record.WorkspaceID, strconv.FormatInt(record.Route.RoutingEpoch, 10), record.Route.AuthorityBuildHash)
	if err != nil {
		t.Fatal(err)
	}
	return authoritystore.MutateInput{Prepared: prepared, IdempotencyKey: authoritystore.ExpectedIdempotencyKey(raw), RequestFingerprint: authoritystore.RequestFingerprint("POST", authoritystore.RequestPath(op, record.RunID), prepared), ServiceBuildHash: record.Route.AuthorityBuildHash}
}
func expireReconciliationLease(t *testing.T, pool *pgxpool.Pool, v runnerstore.V2AuthorityBindingView) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE workflow_runner_leases SET state='expired' WHERE lease_id=$1`, v.LeaseID); err != nil {
		t.Fatal(err)
	}
}
func reconciliationRequest(t *testing.T, v runnerstore.V2AuthorityBindingView, outcome string) runnerstore.PreparedBindingReconciliation {
	t.Helper()
	stage, _ := runnerbindingcontract.ParseStageBytes(v.ExactStageBytes)
	hash, _ := runnerbindingcontract.HashStage(stage)
	raw, err := canonicaljson.Encode(runnerstore.BindingReconciliationRequest{Schema: runnerstore.BindingReconciliationSchema, WorkspaceID: v.WorkspaceID, RunID: v.RunID, BindingID: v.BindingID, StageHash: hash, Outcome: outcome, RulesVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	result, err := runnerstore.ParseBindingReconciliation(append(raw, '\n'))
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestBindingReconciliationClosesHistoryAndPausesWithoutReplaying(t *testing.T) {
	repo, source, v, _ := reconciliationFixture(t, runnerbindingcontract.OperationCheckpointCommit, "resolved")
	ctx := context.Background()
	request := reconciliationRequest(t, v, "committed")
	if _, err := repo.ApplyBindingReconciliation(ctx, request); !runnerstore.IsCode(err, runnerstore.ErrorConflict) {
		t.Fatalf("active lease: %v", err)
	}
	expireReconciliationLease(t, repo.pool, v)
	preview, err := repo.PreviewBindingReconciliation(ctx, v.WorkspaceID, v.RunID, v.BindingID, "")
	if err != nil || len(preview.Items) != 1 || preview.Items[0].Outcome != "committed" {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	var count int
	if err = repo.pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runner_binding_settlements`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("preview wrote: %d %v", count, err)
	}
	receipt, err := repo.ApplyBindingReconciliation(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	// A new repository instance models response loss plus process restart.
	restarted := NewForV2RuntimeDelivery(repo.pool, runnerstore.V2AuthorityPorts{}).WithReconciliationWriter(repo.reconciliationWriter, "recovery-test")
	replay, err := restarted.ApplyBindingReconciliation(ctx, request)
	if err != nil || !bytes.Equal(receipt, replay) {
		t.Fatalf("exact replay: %v", err)
	}
	read, err := restarted.ReadBindingSettlementReceipt(ctx, v.WorkspaceID, v.RunID, request.IdempotencyKey)
	if err != nil || !bytes.Equal(receipt, read) {
		t.Fatal("receipt lookup differs", err)
	}
	if _, err = restarted.ApplyBindingReconciliation(ctx, reconciliationRequest(t, v, "not_committed")); !runnerstore.IsCode(err, runnerstore.ErrorIdempotencyConflict) {
		t.Fatalf("conflicting conclusion accepted: %v", err)
	}
	var original []byte
	if err = repo.pool.QueryRow(ctx, `SELECT exact_resolution_bytes FROM workflow_runner_authority_bindings WHERE binding_id=$1`, v.BindingID).Scan(&original); err != nil || !bytes.Equal(original, v.ExactResolutionBytes) {
		t.Fatal("history changed", err)
	}
	pending, err := repo.RecoverAuthorityBindings(ctx, v.WorkspaceID, time.Now().Add(time.Second), 100)
	if err != nil || len(pending) != 0 {
		t.Fatalf("settled binding is still outstanding: %v %+v", err, pending)
	}
	head, err := source.Read(ctx, v.WorkspaceID, v.RunID)
	if err != nil {
		t.Fatal(err)
	}
	pause := runnerstore.RecoveryPauseRequest{Schema: "openslack.workflow_runner_recovery_pause.v1", WorkspaceID: v.WorkspaceID, RunID: v.RunID, ExpectedRevision: head.Revision, ExpectedRecordHash: head.RecordHash}
	pauseReceipt, err := repo.PauseReconciledRun(ctx, pause)
	if err != nil {
		t.Fatal(err)
	}
	again, err := repo.PauseReconciledRun(ctx, pause)
	if err != nil || !bytes.Equal(pauseReceipt, again) {
		t.Fatal("pause replay differs", err)
	}
	after, err := source.Read(ctx, v.WorkspaceID, v.RunID)
	if err != nil || after.State != "paused" || after.Revision != head.Revision+1 || after.ResumeGeneration != head.ResumeGeneration {
		t.Fatalf("pause head: %+v %v", after, err)
	}
	// The old job cannot regain a lease after the exact head CAS.
	if _, err = repo.pool.Exec(ctx, `UPDATE workflow_runner_leases SET state='active' WHERE lease_id=$1`, v.LeaseID); err == nil {
		t.Fatal("settled lease revived")
	}
	down, e := os.ReadFile(v2MigrationPath(t, "000010_reconcile_workflow_runner_bindings.down.sql"))
	if e != nil {
		t.Fatal(e)
	}
	connection, e := repo.pool.Acquire(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer connection.Release()
	if _, e = connection.Exec(ctx, string(down)); e == nil {
		t.Fatal("destructive downgrade accepted")
	}
	_, _ = connection.Exec(ctx, "ROLLBACK")
}

func TestBindingReconciliationEffectFrontier(t *testing.T) {
	for _, tc := range []struct {
		name      string
		operation runnerbindingcontract.Operation
		variant   string
		allowed   bool
	}{
		{"rejected", runnerbindingcontract.OperationEffectAuthorize, "effectAuthorizeRejected", true},
		{"expired", runnerbindingcontract.OperationEffectAuthorize, "effectAuthorizeExpired", true},
		{"approved_unknown", runnerbindingcontract.OperationEffectAuthorize, "", false},
		{"completed_before_runner_outcome", runnerbindingcontract.OperationEffectComplete, "", true},
		{"reconciliation_required", runnerbindingcontract.OperationEffectComplete, "effectCompleteReconciliation", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			variants := []string{}
			if tc.variant != "" {
				variants = append(variants, tc.variant)
			}
			repo, source, v, _ := reconciliationFixture(t, tc.operation, "resolved", variants...)
			ctx := context.Background()
			expireReconciliationLease(t, repo.pool, v)
			if _, err := repo.ApplyBindingReconciliation(ctx, reconciliationRequest(t, v, "committed")); err != nil {
				t.Fatal(err)
			}
			head, err := source.Read(ctx, v.WorkspaceID, v.RunID)
			if err != nil {
				t.Fatal(err)
			}
			request := runnerstore.RecoveryPauseRequest{Schema: "openslack.workflow_runner_recovery_pause.v1", WorkspaceID: v.WorkspaceID, RunID: v.RunID, ExpectedRevision: head.Revision, ExpectedRecordHash: head.RecordHash}
			_, err = repo.PauseReconciledRun(ctx, request)
			if tc.allowed && err != nil {
				t.Fatal(err)
			}
			if !tc.allowed && !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
				t.Fatalf("unknown effect must block: %v", err)
			}
			if tc.operation == runnerbindingcontract.OperationEffectComplete {
				var unfinished int
				if err := repo.pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runner_effect_boundaries WHERE attempt_id=$1 AND outcome_status IS NULL`, v.AttemptID).Scan(&unfinished); err != nil || unfinished != 1 {
					t.Fatalf("historical boundary was rewritten: %d %v", unfinished, err)
				}
			}
		})
	}
}

func TestBindingReconciliationBudgetSourceCrashWindow(t *testing.T) {
	for _, operation := range []runnerbindingcontract.Operation{runnerbindingcontract.OperationBudgetReserve, runnerbindingcontract.OperationBudgetSettle} {
		t.Run(string(operation), func(t *testing.T) {
			repo, source, v, _ := reconciliationFixture(t, operation, "source_committed")
			ctx := context.Background()
			expireReconciliationLease(t, repo.pool, v)
			preview, err := repo.PreviewBindingReconciliation(ctx, v.WorkspaceID, v.RunID, v.BindingID, "")
			if err != nil || len(preview.Items) != 1 || preview.Items[0].Outcome != "committed" {
				t.Fatalf("lost result preview: %+v %v", preview, err)
			}
			raw, err := repo.ApplyBindingReconciliation(ctx, reconciliationRequest(t, v, "committed"))
			if err != nil {
				t.Fatal(err)
			}
			var receipt runnerstore.BindingSettlementReceipt
			if json.Unmarshal(raw, &receipt) != nil || receipt.ProofKind != "budget_source_result" {
				t.Fatal("missing exact budget result")
			}
			var cached, resolution []byte
			if err := repo.pool.QueryRow(ctx, `SELECT exact_source_result_bytes,exact_resolution_bytes FROM workflow_runner_authority_bindings WHERE binding_id=$1`, v.BindingID).Scan(&cached, &resolution); err != nil || len(cached) != 0 || !bytes.Equal(resolution, v.ExactResolutionBytes) {
				t.Fatal("historical binding changed", err)
			}
			// Source point-read can disappear after commit; exact retry retains bytes.
			repo.v2BudgetResults = nil
			again, err := repo.ApplyBindingReconciliation(ctx, reconciliationRequest(t, v, "committed"))
			if err != nil || !bytes.Equal(raw, again) {
				t.Fatal("retry changed", err)
			}
			head, err := source.Read(ctx, v.WorkspaceID, v.RunID)
			if err != nil {
				t.Fatal(err)
			}
			_, err = repo.PauseReconciledRun(ctx, runnerstore.RecoveryPauseRequest{Schema: "openslack.workflow_runner_recovery_pause.v1", WorkspaceID: v.WorkspaceID, RunID: v.RunID, ExpectedRevision: head.Revision, ExpectedRecordHash: head.RecordHash})
			if operation == runnerbindingcontract.OperationBudgetReserve && !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
				t.Fatalf("open provider reservation must block: %v", err)
			}
			if operation == runnerbindingcontract.OperationBudgetSettle && err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBindingReconciliationSourceCASAndFenceOrder(t *testing.T) {
	for _, sourceFirst := range []bool{true, false} {
		t.Run(strconv.FormatBool(sourceFirst), func(t *testing.T) {
			repo, source, v, record := reconciliationFixture(t, runnerbindingcontract.OperationResumeAdvance, "staged")
			ctx := context.Background()
			stage, _ := runnerbindingcontract.ParseStageBytes(v.ExactStageBytes)
			hash, _ := runnerbindingcontract.HashStage(stage)
			input := reconciliationMutation(t, record, "resuming", 1, "resume."+hash)
			outcome := "not_committed"
			if sourceFirst {
				if _, err := source.Mutate(ctx, input); err != nil {
					t.Fatal(err)
				}
				outcome = "committed"
			}
			expireReconciliationLease(t, repo.pool, v)
			if _, err := repo.ApplyBindingReconciliation(ctx, reconciliationRequest(t, v, outcome)); err != nil {
				t.Fatal(err)
			}
			if !sourceFirst {
				if _, err := source.Mutate(ctx, input); err == nil {
					t.Fatal("old source writer committed after fence")
				}
			}
			var count int
			if err := repo.pool.QueryRow(ctx, `SELECT count(*) FROM workflow_control_transition_events WHERE correlation_id=$1`, "resume."+hash).Scan(&count); err != nil || count != map[bool]int{true: 1, false: 0}[sourceFirst] {
				t.Fatalf("source effects=%d err=%v", count, err)
			}
			if sourceFirst {
				head, err := source.Read(ctx, v.WorkspaceID, v.RunID)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = repo.PauseReconciledRun(ctx, runnerstore.RecoveryPauseRequest{Schema: "openslack.workflow_runner_recovery_pause.v1", WorkspaceID: v.WorkspaceID, RunID: v.RunID, ExpectedRevision: head.Revision, ExpectedRecordHash: head.RecordHash}); err != nil {
					t.Fatal(err)
				}
				next, e := source.Read(ctx, v.WorkspaceID, v.RunID)
				if e != nil || next.ResumeGeneration != 1 || next.State != "paused" {
					t.Fatalf("pause rolled back generation: %+v %v", next, e)
				}
			}
			var storedHash []byte
			if err := repo.pool.QueryRow(ctx, `SELECT stage_hash FROM workflow_runner_binding_settlements WHERE binding_id=$1`, v.BindingID).Scan(&storedHash); err != nil || hex.EncodeToString(storedHash) != hash {
				t.Fatal("settlement stage identity differs", err)
			}
		})
	}
}
