package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// hasOpenBudgetDatabaseReconciliation is schema-version compatible with the
// GS9-B authority server. Schemas 3 through 5 do not contain the GS9-E table;
// schema 6 adds the table and requires every run-head writer to honor its
// database-commit ambiguity gate. The shared run advisory lock is already held
// by the caller, so a budget recovery transaction cannot insert the gate
// between this check and the authority mutation.
func hasOpenBudgetDatabaseReconciliation(ctx context.Context, tx pgx.Tx, workspaceID, runID string) (bool, error) {
	var available bool
	if err := tx.QueryRow(ctx, budgetReconciliationTableExistsSQL).Scan(&available); err != nil {
		return false, databaseFailure("discover workflow budget reconciliation gate", err)
	}
	if !available {
		return false, nil
	}
	var open bool
	if err := tx.QueryRow(ctx, openBudgetDatabaseReconciliationSQL, workspaceID, runID).Scan(&open); err != nil {
		return false, databaseFailure("read workflow budget reconciliation gate", err)
	}
	return open, nil
}
