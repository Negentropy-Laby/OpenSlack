package postgres

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

// Run seed and verify in separate processes with a PostgreSQL restart between them.
// The ordinary upgrade test covers the same records without requiring this opt-in harness.
func TestBudgetManifestPostgresRestart(t *testing.T) {
	phase := os.Getenv("WORKFLOW_BUDGET_MANIFEST_RESTART_PHASE")
	if phase == "" {
		t.Skip("real PostgreSQL budget manifest restart qualification is not enabled")
	}
	schema := os.Getenv("WORKFLOW_BUDGET_MANIFEST_RESTART_SCHEMA")
	if schema == "" {
		t.Fatal("missing restart schema identity")
	}
	var source *pgxpool.Pool
	var first budgetstore.MutationResult
	if phase == "seed" {
		source = openBudgetPostgres(t)
		seedRun(t, source, 4)
		var err error
		first, err = New(source).Reserve(t.Context(), reserveInput(t, testSeed, 0, 4, "1", "600"))
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, manifest := range budgetcontract.AcceptedManifestSHA256() {
		if manifest == budgetcontract.CurrentManifestSHA256 {
			continue
		}
		digest := sha256.Sum256([]byte(schema + ":" + manifest))
		child := "budget_history_" + hex.EncodeToString(digest[:24])
		t.Run(manifest, func(t *testing.T) { verifyBudgetHistoryRestart(t, phase, child, manifest, source, first) })
	}
}
func verifyBudgetHistoryRestart(t *testing.T, phase, schema, manifest string, source *pgxpool.Pool, first budgetstore.MutationResult) {
	ctx := t.Context()
	input := reserveInput(t, testSeed, 0, 4, "1", "600")
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		seedRun(t, pool, 5)
		importBudgetRecordsWithManifest(t, source, pool, manifest)
		response := bytes.ReplaceAll(first.ExactResponseBytes, []byte(budgetstore.ContractManifestSHA256), []byte(manifest))
		receipt := bytes.ReplaceAll(first.ExactReceiptBytes, []byte(budgetstore.ContractManifestSHA256), []byte(manifest))
		if _, err := pool.Exec(ctx, `CREATE TABLE budget_manifest_restart_proof (postmaster timestamptz NOT NULL, response bytea NOT NULL, receipt bytea NOT NULL); INSERT INTO budget_manifest_restart_proof VALUES (pg_postmaster_start_time(),$1,$2)`, response, receipt); err != nil {
			t.Fatal(err)
		}
		pool.Close()
	case "verify":
		defer testsupport.DropSchema(t, schema)
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		var seeded, current time.Time
		var response, receipt []byte
		if err := pool.QueryRow(ctx, `SELECT postmaster, pg_postmaster_start_time(), response, receipt FROM budget_manifest_restart_proof`).Scan(&seeded, &current, &response, &receipt); err != nil {
			t.Fatal(err)
		}
		if seeded.Equal(current) {
			t.Fatal("qualification requires an actual PostgreSQL process restart")
		}
		repository := New(pool)
		before, err := repository.ReadReceipt(ctx, testWorkspace, input.Prepared.IdempotencyKey)
		if err != nil || !bytes.Equal(before.ExactResponseBytes, response) || !bytes.Equal(before.ExactReceiptBytes, receipt) {
			t.Fatalf("historical point receipt bytes changed: %v", err)
		}
		replay, err := repository.Reserve(ctx, input)
		if err != nil || !replay.Replay || !bytes.Equal(replay.ExactResponseBytes, response) {
			t.Fatalf("restart did not exactly replay historical reserve: %v", err)
		}
		settled, err := repository.Settle(ctx, settlementInput(t, testSeed, replay, 1, 5, "trusted", "provider_response_accepted", "100"))
		if err != nil || settled.Status != "settled" || settled.DurableReceipt.ContractManifestSHA256 != budgetstore.ContractManifestSHA256 {
			t.Fatalf("current settlement after historical restart: %v", err)
		}
		rebuilt, err := repository.RebuildAccount(ctx, testWorkspace, testRun)
		if err != nil {
			t.Fatal(err)
		}
		head, err := repository.ReadAccount(ctx, testWorkspace, testRun)
		if err != nil || !bytes.Equal(rebuilt.ExactBytes, head.ExactBytes) {
			t.Fatalf("mixed-manifest rebuild changed bytes: %v", err)
		}
		after, err := repository.ReadReceipt(ctx, testWorkspace, input.Prepared.IdempotencyKey)
		if err != nil || !bytes.Equal(after.ExactResponseBytes, response) || !bytes.Equal(after.ExactReceiptBytes, receipt) {
			t.Fatalf("new settlement altered historical receipt: %v", err)
		}
		t.Logf("PostgreSQL restart %s -> %s preserved historical receipt bytes and mixed-manifest rebuild", seeded, current)
		pool.Close()
	default:
		t.Fatalf("unknown budget restart phase %q", phase)
	}
}
