package integration_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

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
	      'workflow_runner_worker_events',
	      'workflow_runner_event_receipts',
	      'workflow_runner_effect_boundaries',
	      'workflow_runner_reconciliations'
	  )
  AND action_timing = 'BEFORE'
  AND event_manipulation IN ('UPDATE','DELETE')`).Scan(&triggerEvents); err != nil {
		t.Fatalf("count immutable trigger events: %v", err)
	}
	if triggerEvents != 37 {
		t.Fatalf("immutable trigger coverage = %d, want 37 event rows", triggerEvents)
	}
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

	rows, err := pool.Query(ctx, `
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name LIKE 'workflow_runner_%'
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
