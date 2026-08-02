package integration_test

import (
	"context"
	"sort"
	"testing"

	shadowpostgres "github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

func TestMigrationCreatesTheIsolatedImmutableNamespace(t *testing.T) {
	pool := testsupport.Open(t)
	rows, err := pool.Query(context.Background(), `
SELECT table_name
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND table_name LIKE 'governance_shadow_%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	sort.Strings(tables)
	want := []string{
		"governance_shadow_heads",
		"governance_shadow_observations",
		"governance_shadow_receipts",
		"governance_shadow_record_versions",
	}
	if len(tables) != len(want) {
		t.Fatalf("tables = %v", tables)
	}
	for index := range want {
		if tables[index] != want[index] {
			t.Fatalf("tables = %v", tables)
		}
	}

	var immutableTriggers int
	if err := pool.QueryRow(context.Background(), `
SELECT count(*)
FROM information_schema.triggers
WHERE trigger_schema = current_schema()
  AND trigger_name LIKE 'governance_shadow_%_immutable'`).Scan(&immutableTriggers); err != nil {
		t.Fatal(err)
	}
	if immutableTriggers != 6 {
		// information_schema exposes one row per UPDATE and DELETE event.
		t.Fatalf("immutable trigger event count = %d", immutableTriggers)
	}
}

func TestMigrationRejectsReceiptStateCombinationsOutsideTheFrozenSchema(t *testing.T) {
	pool := testsupport.Open(t)
	repository := shadowpostgres.New(pool)
	_, input := testsupport.PendingObservation(t, 1)
	if _, err := repository.Observe(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	var observationID string
	if err := pool.QueryRow(context.Background(), `SELECT observation_id FROM governance_shadow_observations LIMIT 1`).Scan(&observationID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, status, parity, mismatch string
		committed, observation, token  bool
	}{
		{name: "accepted unknown", status: "accepted", parity: "unknown", committed: true, observation: true},
		{name: "accepted mismatch without code", status: "accepted", parity: "mismatched", committed: true, observation: true},
		{name: "reconciliation matched", status: "reconciliation_required", parity: "matched", token: true},
		{name: "reconciliation mismatch code", status: "reconciliation_required", parity: "unknown", mismatch: "not-allowed", token: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var committedAt, observed, token any
			if test.committed {
				committedAt = "2026-08-02T00:00:00Z"
			}
			if test.observation {
				observed = observationID
			}
			if test.token {
				token = "greconcile-test"
			}
			_, err := pool.Exec(context.Background(), `
INSERT INTO governance_shadow_receipts (
    receipt_id, operation, status, parity, idempotency_key, request_fingerprint,
    workspace_id, plan_id, source_sequence, observation_kind, observation_digest,
    observation_id, mismatch_code, committed_at, reconciliation_token
) VALUES ($1,'observation_ingest',$2,$3,$4,decode(repeat('00',32),'hex'),
          $5,$6,99,'record',decode(repeat('00',32),'hex'),$7,$8,$9,$10)`,
				"invalid-"+test.name, test.status, test.parity, "invalid-key-"+test.name,
				testsupport.WorkspaceID, testsupport.PlanID, observed, nullableTestString(test.mismatch), committedAt, token)
			if err == nil {
				t.Fatal("invalid receipt state was persisted")
			}
		})
	}
}

func nullableTestString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
