package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

func TestMigrationCreatesIsolatedShadowNamespaceAndImmutableTriggers(t *testing.T) {
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
		"workflow_control_shadow_heads",
		"workflow_control_shadow_observations",
		"workflow_control_shadow_receipts",
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
      'workflow_control_shadow_observations',
      'workflow_control_shadow_receipts'
  )
  AND action_timing = 'BEFORE'
  AND event_manipulation IN ('UPDATE','DELETE')`).Scan(&triggerEvents); err != nil {
		t.Fatalf("count immutable trigger events: %v", err)
	}
	if triggerEvents != 4 {
		t.Fatalf("immutable trigger coverage = %d, want 4 event rows", triggerEvents)
	}
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
