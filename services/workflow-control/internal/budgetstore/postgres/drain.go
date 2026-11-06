package postgres

import "context"

func (repository *Repository) DrainStatistics(ctx context.Context, workspace string, epoch int64) (map[string]int64, error) {
	var reservations, recon int64
	err := repository.pool.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM workflow_control_budget_reservations WHERE workspace_id=$1 AND routing_epoch=$2 AND status='open'),
 (SELECT count(*) FROM workflow_control_budget_reconciliations c JOIN workflow_control_budget_accounts a USING(workspace_id,run_id,account_id) WHERE c.workspace_id=$1 AND a.routing_epoch=$2 AND c.status='open')`, workspace, epoch).Scan(&reservations, &recon)
	if err != nil {
		return nil, databaseFailure("read scoped budget drain", err)
	}
	return map[string]int64{"open_reservations": reservations, "reconciliation_required": recon}, nil
}
