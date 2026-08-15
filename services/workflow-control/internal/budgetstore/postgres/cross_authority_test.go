package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	authoritypostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
)

func TestBudgetDatabaseReconciliationSerializesAndGatesAuthorityMutation(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	input := reserveInput(t, testSeed, 0, 4, "1", "100")
	transition := authorityTransitionInput(t, 4, authoritycontract.RunRunning, authoritycontract.RunCompleted)

	reconciliationReady := make(chan struct{})
	releaseReconciliation := make(chan struct{})
	rollbackUnknown := func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Rollback(ctx); err != nil {
			return err
		}
		return errors.New("database outcome unavailable")
	}
	reconciliationCommit := func(ctx context.Context, tx pgx.Tx) error {
		close(reconciliationReady)
		select {
		case <-releaseReconciliation:
			return tx.Commit(ctx)
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	type budgetOutcome struct {
		result budgetstore.MutationResult
		err    error
	}
	budgetDone := make(chan budgetOutcome, 1)
	go func() {
		result, err := NewWithCommitters(pool, rollbackUnknown, reconciliationCommit).Reserve(context.Background(), input)
		budgetDone <- budgetOutcome{result: result, err: err}
	}()
	select {
	case <-reconciliationReady:
	case <-time.After(5 * time.Second):
		t.Fatal("database reconciliation did not reach its commit boundary")
	}

	authorityDone := make(chan error, 1)
	go func() {
		_, err := authoritypostgres.New(pool).Mutate(context.Background(), transition)
		authorityDone <- err
	}()
	select {
	case err := <-authorityDone:
		t.Fatalf("authority mutation escaped the shared run lock before reconciliation commit: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseReconciliation)

	select {
	case outcome := <-budgetDone:
		if outcome.err != nil || outcome.result.Status != "database_reconciliation_required" {
			t.Fatalf("database reconciliation result=%#v err=%v", outcome.result, outcome.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("database reconciliation did not commit")
	}
	select {
	case err := <-authorityDone:
		if !authoritystore.IsCode(err, authoritystore.ErrorConflict) {
			t.Fatalf("authority mutation after budget reconciliation err=%v, want %s", err, authoritystore.ErrorConflict)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("authority mutation did not resume after reconciliation commit")
	}
	assertRunRecord(t, pool, 5, authoritycontract.RunReconciliationRequired)
}

func TestAuthorityBudgetGateUsesValidatedStartupSchemaVersion(t *testing.T) {
	t.Run("schema 3 skips the absent GS9-E table", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		if _, err := pool.Exec(context.Background(), `ALTER TABLE workflow_control_budget_reconciliations RENAME TO workflow_control_budget_reconciliations_hidden`); err != nil {
			t.Fatal(err)
		}
		transition := authorityTransitionInput(t, 4, authoritycontract.RunRunning, authoritycontract.RunCompleted)
		if _, err := authoritypostgres.New(pool, 3).Mutate(context.Background(), transition); err != nil {
			t.Fatalf("schema-3 authority unexpectedly queried the GS9-E gate: %v", err)
		}
		assertRunRecord(t, pool, 5, authoritycontract.RunCompleted)
	})
	t.Run("schema 6 fails if the required GS9-E table is absent", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		if _, err := pool.Exec(context.Background(), `ALTER TABLE workflow_control_budget_reconciliations RENAME TO workflow_control_budget_reconciliations_hidden`); err != nil {
			t.Fatal(err)
		}
		transition := authorityTransitionInput(t, 4, authoritycontract.RunRunning, authoritycontract.RunCompleted)
		if _, err := authoritypostgres.New(pool, 6).Mutate(context.Background(), transition); !authoritystore.IsCode(err, authoritystore.ErrorDatabase) {
			t.Fatalf("schema-6 authority missing-table err=%v, want %s", err, authoritystore.ErrorDatabase)
		}
		assertRunRecord(t, pool, 4, authoritycontract.RunRunning)
	})
}
