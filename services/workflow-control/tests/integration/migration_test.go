package integration_test

import (
	"context"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

func TestMigrationCreatesIsolatedShadowRunnerAndAuthorityNamespacesWithImmutableEvidence(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()

	rows, err := pool.Query(ctx, `
SELECT table_name
FROM information_schema.tables
WHERE table_schema = current_schema()
ORDER BY table_name`)
	if err != nil {
		t.Fatalf("list migrated tables: %v", err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatalf("scan migrated table: %v", err)
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate migrated tables: %v", err)
	}
	want := []string{
		"workflow_control_authority_epochs",
		"workflow_control_budget_accounts",
		"workflow_control_budget_ledger",
		"workflow_control_budget_receipts",
		"workflow_control_budget_reconciliations",
		"workflow_control_budget_reservations",
		"workflow_control_checkpoint_shadow_heads",
		"workflow_control_checkpoint_shadow_observations",
		"workflow_control_checkpoint_shadow_receipts",
		"workflow_control_checkpoint_shadow_reconciliations",
		"workflow_control_effect_shadow_heads",
		"workflow_control_effect_shadow_observations",
		"workflow_control_effect_shadow_outbox",
		"workflow_control_effect_shadow_receipts",
		"workflow_control_effect_shadow_reconciliation_resolutions",
		"workflow_control_effect_shadow_reconciliations",
		"workflow_control_outbox",
		"workflow_control_reconciliations",
		"workflow_control_runs",
		"workflow_control_shadow_heads",
		"workflow_control_shadow_observations",
		"workflow_control_shadow_receipts",
		"workflow_control_transition_events",
		"workflow_control_transition_receipts",
		"workflow_runner_attempts",
		"workflow_runner_cancel_controls",
		"workflow_runner_control_messages",
		"workflow_runner_effect_boundaries",
		"workflow_runner_event_receipts",
		"workflow_runner_job_receipts",
		"workflow_runner_jobs",
		"workflow_runner_leases",
		"workflow_runner_process_sessions",
		"workflow_runner_reconciliations",
		"workflow_runner_v2_attempt_bindings",
		"workflow_runner_v2_cancel_bindings",
		"workflow_runner_v2_decision_bindings",
		"workflow_runner_v2_event_inbox",
		"workflow_runner_worker_events",
	}
	if len(tables) != len(want) {
		t.Fatalf("unexpected migrated tables: got=%v want=%v", tables, want)
	}
	for index := range want {
		if tables[index] != want[index] {
			t.Fatalf("unexpected migrated tables: got=%v want=%v", tables, want)
		}
	}

	var triggerEvents int
	if err := pool.QueryRow(ctx, `
SELECT count(*)
FROM information_schema.triggers
WHERE trigger_schema = current_schema()
	  AND event_object_table IN (
	      'workflow_control_authority_epochs',
	      'workflow_control_transition_events',
	      'workflow_control_transition_receipts',
	      'workflow_control_reconciliations',
	      'workflow_control_budget_accounts',
	      'workflow_control_budget_reservations',
	      'workflow_control_budget_ledger',
	      'workflow_control_budget_receipts',
	      'workflow_control_budget_reconciliations',
	      'workflow_control_checkpoint_shadow_observations',
	      'workflow_control_checkpoint_shadow_receipts',
	      'workflow_control_checkpoint_shadow_reconciliations',
	      'workflow_control_effect_shadow_observations',
	      'workflow_control_effect_shadow_receipts',
	      'workflow_control_effect_shadow_outbox',
	      'workflow_control_effect_shadow_reconciliations',
	      'workflow_control_effect_shadow_reconciliation_resolutions',
	      'workflow_control_shadow_observations',
	      'workflow_control_shadow_receipts',
		      'workflow_runner_job_receipts',
		      'workflow_runner_jobs',
		      'workflow_runner_worker_events',
		      'workflow_runner_event_receipts',
		      'workflow_runner_effect_boundaries',
		      'workflow_runner_reconciliations',
		      'workflow_runner_v2_attempt_bindings',
		      'workflow_runner_v2_decision_bindings',
		      'workflow_runner_v2_cancel_bindings'
	  )
  AND action_timing = 'BEFORE'
  AND event_manipulation IN ('UPDATE','DELETE')`).Scan(&triggerEvents); err != nil {
		t.Fatalf("count immutable trigger events: %v", err)
	}
	if triggerEvents != 54 {
		t.Fatalf("immutable trigger coverage = %d, want 54 event rows", triggerEvents)
	}
}

func TestWorkflowRunnerV2DownMigrationIsIsolatedAndRefusesEvidence(t *testing.T) {
	t.Run("empty v2 namespace is removable without changing v1 evidence", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		ctx := context.Background()
		exactV1 := []byte(`{"schema":"v1-preserved"}`)
		if _, err := pool.Exec(ctx, `INSERT INTO workflow_runner_jobs (
workspace_id,job_id,workflow_run_id,correlation_id,execution_descriptor_ref,execution_descriptor_hash,
job_spec_hash,exact_spec_bytes,workflow_id,workflow_version,workflow_source_hash,manifest_hash,input_hash,
whole_deadline,state,revision,created_at,updated_at
) VALUES ('workspace-down-v1','job-down-v1','run-down-v1','correlation-down-v1','descriptor-down-v1',decode(repeat('11',32),'hex'),
decode(repeat('22',32),'hex'),$1,'workflow-down-v1','1.0.0',decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'),decode(repeat('55',32),'hex'),
clock_timestamp()+interval '1 hour','queued',1,clock_timestamp(),clock_timestamp())`, exactV1); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, workflowRunnerV2DownMigration(t)); err != nil {
			t.Fatal(err)
		}
		var stored []byte
		var v1Table, v2Table *string
		if err := pool.QueryRow(ctx, `SELECT exact_spec_bytes FROM workflow_runner_jobs WHERE workspace_id='workspace-down-v1' AND job_id='job-down-v1'`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT to_regclass('workflow_runner_jobs')::TEXT,to_regclass('workflow_runner_v2_event_inbox')::TEXT`).Scan(&v1Table, &v2Table); err != nil {
			t.Fatal(err)
		}
		if string(stored) != string(exactV1) || v1Table == nil || v2Table != nil {
			t.Fatalf("v2 down changed prior evidence: stored=%q v1=%v v2=%v", stored, v1Table, v2Table)
		}
	})

	t.Run("v2 admission evidence prevents destructive rollback", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		ctx := context.Background()
		if _, err := pool.Exec(ctx, `INSERT INTO workflow_runner_jobs (
workspace_id,job_id,workflow_run_id,correlation_id,execution_descriptor_ref,execution_descriptor_hash,
job_spec_hash,exact_spec_bytes,workflow_id,workflow_version,workflow_source_hash,manifest_hash,input_hash,
whole_deadline,state,revision,created_at,updated_at,required_protocol_version,required_capabilities,
authority_backend,workflow_authority,routing_epoch,authority_build_hash,required_run_revision,required_resume_generation
) VALUES ('workspace-down-v2','job-down-v2','run-down-v2','correlation-down-v2','descriptor-down-v2',decode(repeat('11',32),'hex'),
decode(repeat('22',32),'hex'),convert_to('{}','UTF8'),'workflow-down-v2','1.0.0',decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'),decode(repeat('55',32),'hex'),
clock_timestamp()+interval '1 hour','queued',1,clock_timestamp(),clock_timestamp(),'openslack.workflow_runner.v2',
ARRAY['cancel_ack','effect_receipts','lease_heartbeat']::TEXT[],'ts-local','typescript',1,decode(repeat('66',32),'hex'),1,0)`); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, workflowRunnerV2DownMigration(t)); err == nil {
			t.Fatal("v2 admission evidence was destructively removed")
		}
		var preserved bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_runner_jobs WHERE required_protocol_version='openslack.workflow_runner.v2')`).Scan(&preserved); err != nil || !preserved {
			t.Fatalf("failed v2 down was not atomic: preserved=%v err=%v", preserved, err)
		}
	})
}

func TestBudgetAuthorityMigrationLocksSemanticIndexInventory(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	rows, err := pool.Query(context.Background(), `
SELECT indexname
FROM pg_indexes
WHERE schemaname=current_schema() AND tablename LIKE 'workflow_control_budget_%'
ORDER BY indexname`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		got = append(got, name)
		if len(name) > 63 {
			t.Fatalf("PostgreSQL identifier was not explicitly bounded: %q", name)
		}
	}
	want := []string{
		"workflow_control_budget_accounts_pkey",
		"workflow_control_budget_accounts_workspace_account_key",
		"workflow_control_budget_ledger_account_revision_key",
		"workflow_control_budget_ledger_hash_key",
		"workflow_control_budget_ledger_pkey",
		"workflow_control_budget_ledger_reserve_call_attempt_idx",
		"workflow_control_budget_ledger_reserve_reservation_idx",
		"workflow_control_budget_ledger_run_revision_key",
		"workflow_control_budget_ledger_settlement_reservation_idx",
		"workflow_control_budget_receipts_idempotency_key",
		"workflow_control_budget_receipts_ledger_binding_idx",
		"workflow_control_budget_receipts_pkey",
		"workflow_control_budget_receipts_run_idx",
		"workflow_control_budget_recon_one_open_db_run_idx",
		"workflow_control_budget_reconciliations_idem_key",
		"workflow_control_budget_reconciliations_pkey",
		"workflow_control_budget_reconciliations_receipt_key",
		"workflow_control_budget_reconciliations_run_idx",
		"workflow_control_budget_reservations_call_attempt_key",
		"workflow_control_budget_reservations_open_idx",
		"workflow_control_budget_reservations_pkey",
	}
	if len(got) != len(want) {
		t.Fatalf("budget index inventory got=%v want=%v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("budget index inventory got=%v want=%v", got, want)
		}
	}
}

func TestBudgetAuthorityDownMigrationIsIsolatedAndRefusesEvidence(t *testing.T) {
	t.Run("empty namespace is independently removable", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		if _, err := pool.Exec(context.Background(), budgetAuthorityDownMigration(t)); err != nil {
			t.Fatal(err)
		}
		var budgetTables, priorTables int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'workflow_control_budget_%'`).Scan(&budgetTables); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('workflow_control_runs','workflow_control_checkpoint_shadow_heads','workflow_control_effect_shadow_heads')`).Scan(&priorTables); err != nil {
			t.Fatal(err)
		}
		if budgetTables != 0 || priorTables != 3 {
			t.Fatalf("budget=%d prior=%d", budgetTables, priorTables)
		}
	})
	t.Run("evidence prevents destructive rollback", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		ctx := context.Background()
		genesisHash, genesisBytes := budgetMigrationAccount(t, 0)
		accountHash, accountBytes := budgetMigrationAccount(t, 1)
		if _, err := pool.Exec(ctx, `
INSERT INTO workflow_control_authority_epochs (workspace_id,routing_epoch,backend,authority,authority_build_hash)
VALUES ('workspace-budget-down',1,'go','workflow-control',decode(repeat('11',32),'hex'));
INSERT INTO workflow_control_runs (
 workspace_id,run_id,workflow_id,workflow_version,workflow_source_hash,manifest_hash,input_hash,
 backend,authority,routing_epoch,authority_build_hash,state,revision,resume_generation,record_hash,canonical_record_bytes
) VALUES (
 'workspace-budget-down','run-budget-down','workflow','v1',decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'),
 'go','workflow-control',1,decode(repeat('11',32),'hex'),'running',1,0,decode(repeat('55',32),'hex'),convert_to('{}','UTF8')
);
INSERT INTO workflow_control_budget_accounts (
 workspace_id,run_id,account_id,policy_hash,backend,authority,routing_epoch,authority_build_hash,
 account_revision,run_revision,limit_tokens,limit_nano_usd,limit_calls,reserved_tokens,reserved_nano_usd,reserved_calls,
 settled_tokens,settled_nano_usd,settled_calls,genesis_account_hash,canonical_genesis_account_bytes,
 account_hash,canonical_account_bytes,updated_at
) VALUES (
 'workspace-budget-down','run-budget-down','account-budget-down',decode(repeat('66',32),'hex'),'go','workflow-control',1,decode(repeat('11',32),'hex'),
 1,1,1,1,1,0,0,0,0,0,0,$1,$2,$3,$4,$5::timestamptz
)`, genesisHash, genesisBytes, accountHash, accountBytes, "2026-08-15T00:00:00.000Z"); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, budgetAuthorityDownMigration(t)); err == nil {
			t.Fatal("non-empty budget authority rollback unexpectedly succeeded")
		} else {
			requireSQLState(t, err, "P0001")
		}
		var accounts, runs int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM workflow_control_budget_accounts WHERE workspace_id='workspace-budget-down'`).Scan(&accounts); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM workflow_control_runs WHERE workspace_id='workspace-budget-down'`).Scan(&runs); err != nil {
			t.Fatal(err)
		}
		if accounts != 1 || runs != 1 {
			t.Fatalf("accounts=%d runs=%d after refused rollback", accounts, runs)
		}
	})
}

func budgetMigrationAccount(t *testing.T, accountRevision int64) ([]byte, []byte) {
	t.Helper()
	zero := budgetcontract.Record{"tokens": "0", "nanoUsd": "0", "calls": "0"}
	value, err := budgetcontract.ValidateAccount(budgetcontract.Record{
		"schema": budgetcontract.SchemaAccount, "contractVersion": budgetcontract.ContractVersion,
		"authority": budgetcontract.Authority, "writer": budgetcontract.Writer,
		"goRole": budgetcontract.GoRole, "goAuthorityClaim": budgetcontract.GoAuthorityClaim,
		"goAuthorityEligible": false, "workspaceId": "workspace-budget-down",
		"runId": "run-budget-down", "accountId": "account-budget-down",
		"policyHash": strings.Repeat("6", 64),
		"route": budgetcontract.Record{
			"backend": "go", "authority": "workflow-control", "routingEpoch": int64(1),
			"authorityBuildHash": strings.Repeat("1", 64),
		},
		"accountRevision": accountRevision, "runRevision": int64(1),
		"limit":    budgetcontract.Record{"tokens": "1", "nanoUsd": "1", "calls": "1"},
		"reserved": zero, "settled": zero, "updatedAt": "2026-08-15T00:00:00.000Z",
	})
	if err != nil {
		t.Fatalf("build rollback budget account projection: %v", err)
	}
	durable, err := budgetstore.NewDurableRecord(budgetstore.RecordKindAccount, value, strings.Repeat("1", 64))
	if err != nil {
		t.Fatalf("build rollback durable budget account: %v", err)
	}
	exact, err := budgetstore.EncodeDurableRecord(durable)
	if err != nil {
		t.Fatalf("encode rollback durable budget account: %v", err)
	}
	digest, err := hex.DecodeString(durable.OperationalProjectionHash)
	if err != nil {
		t.Fatalf("decode rollback durable budget account hash: %v", err)
	}
	return digest, exact
}

func TestEffectShadowDownMigrationIsIsolatedAndRefusesEvidence(t *testing.T) {
	t.Run("empty namespace is independently removable", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		if _, err := pool.Exec(context.Background(), effectShadowDownMigration(t)); err != nil {
			t.Fatal(err)
		}
		var effectTables, priorTables int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'workflow_control_effect_shadow_%'`).Scan(&effectTables); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('workflow_control_checkpoint_shadow_heads','workflow_control_runs','workflow_runner_jobs')`).Scan(&priorTables); err != nil {
			t.Fatal(err)
		}
		if effectTables != 0 || priorTables != 3 {
			t.Fatalf("effect=%d prior=%d", effectTables, priorTables)
		}
	})
	t.Run("evidence prevents destructive rollback", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		_, err := pool.Exec(context.Background(), `INSERT INTO workflow_control_effect_shadow_heads (workspace_id,run_id,occurrence_id,approval_id,last_source_sequence,last_operation,last_observation_hash,mismatch_latched,mismatch_code,service_build_hash) VALUES ('workspace','run','WFOCCURRENCE-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','WFAPPROVAL-test',1,'approval_created',decode(repeat('11',32),'hex'),true,'INITIAL_SEQUENCE_MISMATCH',decode(repeat('22',32),'hex'))`)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(context.Background(), effectShadowDownMigration(t)); err == nil {
			t.Fatal("non-empty effect shadow rollback unexpectedly succeeded")
		} else {
			requireSQLState(t, err, "P0001")
		}
	})
}

func TestCheckpointShadowDownMigrationIsIsolatedAndRefusesEvidence(t *testing.T) {
	t.Run("empty namespace is independently removable", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		if _, err := pool.Exec(context.Background(), checkpointShadowDownMigration(t)); err != nil {
			t.Fatal(err)
		}
		var checkpointTables, priorTables int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'workflow_control_checkpoint_shadow_%'`).Scan(&checkpointTables); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('workflow_control_shadow_heads','workflow_runner_jobs','workflow_control_runs')`).Scan(&priorTables); err != nil {
			t.Fatal(err)
		}
		if checkpointTables != 0 || priorTables != 3 {
			t.Fatalf("checkpoint=%d prior=%d", checkpointTables, priorTables)
		}
	})
	t.Run("evidence prevents destructive rollback", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		_, err := pool.Exec(context.Background(), `INSERT INTO workflow_control_checkpoint_shadow_heads (workspace_id,run_id,source_sequence,operation,mismatch_latched) VALUES ('workspace','run',1,'checkpoint_commit',true)`)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(context.Background(), checkpointShadowDownMigration(t)); err == nil {
			t.Fatal("non-empty checkpoint shadow rollback unexpectedly succeeded")
		} else {
			requireSQLState(t, err, "P0001")
		}
	})
}

func TestCheckpointShadowHeadRejectsNullMatchedBypasses(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
INSERT INTO workflow_control_checkpoint_shadow_heads (
    workspace_id, run_id, source_sequence, operation, mismatch_latched
) VALUES ('workspace-null','run-null',1,'checkpoint_commit',false)`); err == nil {
		t.Fatal("unmatched non-mismatch head bypassed its CHECK constraint")
	} else {
		requireSQLState(t, err, "23514")
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO workflow_control_checkpoint_shadow_heads (
    workspace_id, run_id, source_sequence, operation, matched_source_sequence,
    mismatch_latched, observation_hash, exact_observation_bytes
) VALUES (
    'workspace-matched','run-matched',1,'checkpoint_commit',1,
    false,decode(repeat('11',32),'hex'),convert_to('{}','UTF8')
)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
UPDATE workflow_control_checkpoint_shadow_heads
SET source_sequence=2, matched_source_sequence=NULL, mismatch_latched=true,
    observation_hash=NULL, exact_observation_bytes=NULL
WHERE workspace_id='workspace-matched' AND run_id='run-matched'`); err == nil {
		t.Fatal("NULL matched sequence bypassed the transition trigger")
	} else {
		requireSQLState(t, err, "P0001")
	}
}

func TestRunnerMigrationDoesNotClaimGS9Authority(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	var exactTransportGenerationBindings int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
WHERE table_schema=current_schema() AND column_name='resume_generation'
  AND table_name IN ('workflow_runner_v2_cancel_bindings','workflow_runner_v2_event_inbox')`).Scan(&exactTransportGenerationBindings); err != nil {
		t.Fatal(err)
	}
	if exactTransportGenerationBindings != 2 {
		t.Fatalf("v2 transport generation bindings=%d, want exact two non-authority envelope bindings", exactTransportGenerationBindings)
	}

	rows, err := pool.Query(ctx, `
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name LIKE 'workflow_runner_%'
  AND NOT (column_name='resume_generation' AND table_name IN (
      'workflow_runner_v2_cancel_bindings','workflow_runner_v2_event_inbox'
  ))
  AND (
      column_name IN ('run_status','checkpoint','resume_cursor','approval','approval_decision','budget','budget_used')
      OR column_name LIKE 'checkpoint_%'
      OR column_name LIKE 'resume_%'
      OR column_name LIKE 'approval_%'
      OR column_name LIKE 'budget_%'
  )
ORDER BY table_name, column_name`)
	if err != nil {
		t.Fatalf("query forbidden GS9 authority columns: %v", err)
	}
	defer rows.Close()
	var forbidden []string
	for rows.Next() {
		var table, column string
		if err := rows.Scan(&table, &column); err != nil {
			t.Fatalf("scan forbidden GS9 authority column: %v", err)
		}
		forbidden = append(forbidden, table+"."+column)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate forbidden GS9 authority columns: %v", err)
	}
	if len(forbidden) != 0 {
		t.Fatalf("GS8-B runner schema claimed GS9 authority: %v", forbidden)
	}
}

func TestAuthorityMigrationDoesNotClaimLaterGS9OrRunnerLifecycle(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()

	rows, err := pool.Query(ctx, `
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name IN (
      'workflow_control_authority_epochs',
      'workflow_control_runs',
      'workflow_control_transition_events',
      'workflow_control_transition_receipts',
      'workflow_control_outbox',
      'workflow_control_reconciliations'
  )
  AND (
      column_name IN (
          'checkpoint', 'approval', 'approval_decision', 'budget', 'budget_used',
          'job_id', 'attempt_id', 'lease_id', 'fencing_token', 'effect_id'
      )
      OR column_name LIKE 'checkpoint_%'
      OR column_name LIKE 'approval_%'
      OR column_name LIKE 'budget_%'
      OR column_name LIKE 'effect_%'
  )
ORDER BY table_name, column_name`)
	if err != nil {
		t.Fatalf("query forbidden later-stage columns: %v", err)
	}
	defer rows.Close()
	var forbidden []string
	for rows.Next() {
		var table, column string
		if err := rows.Scan(&table, &column); err != nil {
			t.Fatalf("scan forbidden later-stage column: %v", err)
		}
		forbidden = append(forbidden, table+"."+column)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate forbidden later-stage columns: %v", err)
	}
	if len(forbidden) != 0 {
		t.Fatalf("GS9-B authority schema claimed a later GS9/runner lifecycle plane: %v", forbidden)
	}
}

func TestAuthorityDownMigrationIsIsolatedAndRefusesRegisteredEpochs(t *testing.T) {
	t.Run("empty namespace can be removed without touching earlier slices", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		ctx := context.Background()
		if _, err := pool.Exec(ctx, authorityDownMigration(t)); err != nil {
			t.Fatalf("apply empty GS9-B down migration: %v", err)
		}

		var authorityTables int
		if err := pool.QueryRow(ctx, `
SELECT count(*)
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name IN (
      'workflow_control_authority_epochs',
      'workflow_control_runs',
      'workflow_control_transition_events',
      'workflow_control_transition_receipts',
      'workflow_control_outbox',
      'workflow_control_reconciliations'
  )`).Scan(&authorityTables); err != nil {
			t.Fatalf("count authority tables after down migration: %v", err)
		}
		if authorityTables != 0 {
			t.Fatalf("authority tables after down migration = %d, want 0", authorityTables)
		}

		var priorTables int
		if err := pool.QueryRow(ctx, `
SELECT count(*)
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name IN ('workflow_control_shadow_heads', 'workflow_runner_jobs')`).Scan(&priorTables); err != nil {
			t.Fatalf("count prior-slice tables after down migration: %v", err)
		}
		if priorTables != 2 {
			t.Fatalf("prior-slice tables after down migration = %d, want 2", priorTables)
		}
	})

	t.Run("registered epoch prevents destructive rollback", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		ctx := context.Background()
		if _, err := pool.Exec(ctx, `
INSERT INTO workflow_control_authority_epochs (
    workspace_id, routing_epoch, backend, authority, authority_build_hash
) VALUES ('workspace-down-guard', 1, 'go', 'workflow-control', decode(repeat('ab',32),'hex'))`); err != nil {
			t.Fatalf("seed registered authority epoch: %v", err)
		}
		if _, err := pool.Exec(ctx, authorityDownMigration(t)); err == nil {
			t.Fatal("GS9-B down migration unexpectedly removed a registered authority epoch")
		} else {
			requireSQLState(t, err, "P0001")
		}

		var epochs int
		if err := pool.QueryRow(ctx, `
SELECT count(*) FROM workflow_control_authority_epochs
WHERE workspace_id = 'workspace-down-guard'`).Scan(&epochs); err != nil {
			t.Fatalf("read registered epoch after refused rollback: %v", err)
		}
		if epochs != 1 {
			t.Fatalf("registered epochs after refused rollback = %d, want 1", epochs)
		}
	})
}

func TestMigrationRejectsPartialMatchedHeadAndInvalidReceiptStates(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
INSERT INTO workflow_control_shadow_heads (
    workspace_id, run_id, source_sequence, matched_source_sequence
) VALUES ('workspace-partial','run-partial',1,1)`); err == nil {
		t.Fatal("partial matched-head tuple unexpectedly passed its CHECK constraint")
	} else {
		requireSQLState(t, err, "23514")
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO workflow_control_shadow_observations (
    observation_id, workspace_id, run_id, source_sequence, parity,
    status, canonical_envelope_bytes, body_digest, observation_hash,
    projection_bytes
) VALUES (
    'observation-valid', 'workspace-invalid', 'run-invalid', 1, 'matched',
    'running', decode('00','hex'), decode(repeat('00',32),'hex'),
    decode(repeat('11',32),'hex'), decode('00','hex')
)`); err != nil {
		t.Fatalf("seed receipt foreign key: %v", err)
	}

	invalidReceipts := []struct {
		name   string
		status string
		parity string
		extra  string
	}{
		{name: "accepted unknown parity", status: "accepted", parity: "unknown", extra: "clock_timestamp(), 'observation-valid', decode(repeat('11',32),'hex'), NULL"},
		{name: "accepted mismatch without code", status: "accepted", parity: "mismatched", extra: "clock_timestamp(), 'observation-valid', decode(repeat('11',32),'hex'), NULL"},
		{name: "reconciliation carries observation hash", status: "reconciliation_required", parity: "unknown", extra: "NULL, NULL, decode(repeat('11',32),'hex'), 'token'"},
	}
	for _, test := range invalidReceipts {
		t.Run(test.name, func(t *testing.T) {
			query := `
INSERT INTO workflow_control_shadow_receipts (
    receipt_id, operation, status, parity, idempotency_key,
    request_fingerprint, workspace_id, run_id, source_sequence,
    observation_digest, committed_at, observation_id, observation_hash,
    reconciliation_token
) VALUES (
    'receipt-' || md5($1), 'observation_ingest', $2, $3, 'key-' || md5($1),
    decode(repeat('00',32),'hex'), 'workspace-invalid', 'run-invalid', 1,
    decode(repeat('00',32),'hex'), ` + test.extra + `
)`
			if _, err := pool.Exec(ctx, query, test.name, test.status, test.parity); err == nil {
				t.Fatal("invalid receipt state unexpectedly passed its CHECK constraint")
			} else {
				requireSQLState(t, err, "23514")
			}
		})
	}
}

func requireSQLState(t *testing.T, err error, want string) {
	t.Helper()
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != want {
		t.Fatalf("PostgreSQL error = %v, want SQLSTATE %s", err, want)
	}
}

func authorityDownMigration(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source path")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(file), "..", "..", "migrations",
		"000003_create_workflow_control_authority.down.sql",
	))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read GS9-B down migration: %v", err)
	}
	return string(body)
}

func checkpointShadowDownMigration(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source path")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "migrations", "000004_create_workflow_control_checkpoint_shadow.down.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read GS9-C down migration: %v", err)
	}
	return string(body)
}

func effectShadowDownMigration(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source path")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "migrations", "000005_create_workflow_control_effect_shadow.down.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read GS9-D down migration: %v", err)
	}
	return string(body)
}

func budgetAuthorityDownMigration(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source path")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "migrations", "000006_create_workflow_control_budget_authority.down.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read GS9-E2 down migration: %v", err)
	}
	return string(body)
}

func workflowRunnerV2DownMigration(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source path")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "migrations", "000007_integrate_workflow_runner_v2.down.sql"))
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read GS9-F1 down migration: %v", err)
	}
	return string(body)
}
