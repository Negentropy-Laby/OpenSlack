package postgres

import (
	"context"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/jackc/pgx/v5"
)

// This predicate changes eligibility only; original lifecycle and ACK bytes
// remain available for inspection and are never presented as delivered.
func (repository *Repository) unsettledBindingSQL(alias string) string {
	if repository.schemaVersion < 10 {
		return ""
	}
	return ` AND NOT EXISTS(SELECT 1 FROM workflow_runner_binding_settlements settlement WHERE settlement.binding_id=` + alias + `.binding_id)`
}

type settlementReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (repository *Repository) controlIsSettled(ctx context.Context, reader settlementReader, event string) (bool, error) {
	if repository.schemaVersion < 10 {
		return false, nil
	}
	var settled bool
	err := reader.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_runner_binding_settlements s JOIN workflow_runner_authority_bindings b USING(binding_id)
 WHERE b.target_event_id IN (SELECT received_event_id FROM workflow_runner_event_receipts WHERE receipt_event_id=$1)
 OR b.target_event_id IN (SELECT received_event_id FROM workflow_runner_v2_decision_bindings WHERE decision_control_event_id=$1))`, event).Scan(&settled)
	if err != nil {
		return false, databaseFailure("read control settlement", err)
	}
	return settled, nil
}

func (repository *Repository) requireUnsettledEvent(ctx context.Context, reader settlementReader, event string) error {
	if repository.schemaVersion < 10 {
		return nil
	}
	var settled bool
	err := reader.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_runner_binding_settlements s JOIN workflow_runner_authority_bindings b USING(binding_id) WHERE b.target_event_id=$1)`, event).Scan(&settled)
	if err != nil {
		return databaseFailure("read event settlement", err)
	}
	if settled {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "historical event is closed by explicit reconciliation and cannot be delivered", nil)
	}
	return nil
}
