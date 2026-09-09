package postgres

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestUnsupportedRebuildManifestFailsBeforeEncoding(t *testing.T) {
	outer, encoded, hash, err := exactDurableRecordWithManifest(budgetstore.RecordKindAccount, nil, testBuild, strings.Repeat("0", 64))
	if !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) || encoded != nil || hash != "" || outer.ContractManifestSHA256 != "" {
		t.Fatalf("unsupported manifest reached encoding: %v", err)
	}
}

func TestUnsupportedManifestRebuildHasZeroBusinessWrites(t *testing.T) {
	source, target := openBudgetPostgres(t), openBudgetPostgres(t)
	seedRun(t, source, 4)
	seedRun(t, target, 5)
	if _, err := New(source).Reserve(t.Context(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
		t.Fatal(err)
	}
	importBudgetRecordsWithManifest(t, source, target, strings.Repeat("0", 64))
	snapshot := func() string {
		var result string
		err := target.QueryRow(t.Context(), `SELECT jsonb_build_object(
    'accounts',(SELECT jsonb_agg(to_jsonb(t)) FROM workflow_control_budget_accounts t),
    'ledger',(SELECT jsonb_agg(to_jsonb(t)) FROM workflow_control_budget_ledger t),
    'receipts',(SELECT jsonb_agg(to_jsonb(t)) FROM workflow_control_budget_receipts t),
    'reservations',(SELECT jsonb_agg(to_jsonb(t)) FROM workflow_control_budget_reservations t))::text`).Scan(&result)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := snapshot()
	if _, err := New(target).RebuildAccount(t.Context(), testWorkspace, testRun); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
		t.Fatalf("unsupported durable manifest: %v", err)
	}
	if snapshot() != before {
		t.Fatal("rebuild mutated business records")
	}
}

// A subprocess must fail through the real verify path; the parent still checks cleanup.
func TestBudgetManifestVerifyFailureCleansSchema(t *testing.T) {
	if schema := os.Getenv("OPENSLACK_TEST_BUDGET_VERIFY_FAILURE_SCHEMA"); schema != "" {
		verifyBudgetHistoryRestart(t, "verify", schema, "unused-before-proof-read", nil, budgetstore.MutationResult{})
		t.Fatal("empty proof unexpectedly passed")
	}
	seed := openBudgetPostgres(t)
	var current string
	if err := seed.QueryRow(t.Context(), "SELECT current_schema()").Scan(&current); err != nil {
		t.Fatal(err)
	}
	schema := current + "_verify"
	pool := testsupport.OpenPersistentSchema(t, schema, true)
	pool.Close()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(t.Context(), binary, "-test.run=^TestBudgetManifestVerifyFailureCleansSchema$", "-test.v")
	command.Env = append(os.Environ(), "OPENSLACK_TEST_BUDGET_VERIFY_FAILURE_SCHEMA="+schema)
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "budget_manifest_restart_proof") {
		t.Fatalf("expected verify failure was not exercised: %v", err)
	}
	admin, err := pgxpool.New(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var exists bool
	if err := admin.QueryRow(t.Context(), "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)", schema).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		testsupport.DropSchema(t, schema)
		t.Fatal("verify failure leaked its schema")
	}
}
