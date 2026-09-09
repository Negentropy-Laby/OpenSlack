package postgres

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

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

func TestBudgetManifestVerifyFailureCleansSchema(t *testing.T) {
	for _, stage := range []string{"proof", "restart", "historical point receipt bytes changed"} {
		t.Run(stage, func(t *testing.T) {
			seed := openBudgetPostgres(t)
			var current string
			if err := seed.QueryRow(t.Context(), "SELECT current_schema()").Scan(&current); err != nil {
				t.Fatal(err)
			}
			schema := current + "_verify"
			pool := testsupport.OpenPersistentSchema(t, schema, true)
			t.Cleanup(func() { testsupport.DropSchema(t, schema) })
			if stage != "proof" {
				expression := "pg_postmaster_start_time()"
				if stage != "restart" {
					expression += " - interval '1 second'"
				}
				if _, err := pool.Exec(t.Context(), "CREATE TABLE budget_manifest_restart_proof (postmaster timestamptz, response bytea, receipt bytea); INSERT INTO budget_manifest_restart_proof VALUES ("+expression+",'{}'::bytea,'{}'::bytea)"); err != nil {
					t.Fatal(err)
				}
			}
			pool.Close()
			err := verifyBudgetHistoryRestart(t, schema)
			var failure *budgetRestartVerificationError
			var postgresFailure *pgconn.PgError
			if !errors.As(err, &failure) || failure.Stage != stage || (stage == "proof" && (!errors.As(err, &postgresFailure) || postgresFailure.Code != "42P01")) {
				t.Fatalf("unexpected verify failure: %v", err)
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
				t.Fatal("verify failure leaked its schema")
			}
		})
	}
}
