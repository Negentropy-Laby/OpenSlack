package postgres

import "context"

// One SQL snapshot; terminal history and other workspace/epochs cannot hide live work.
func (repository *Repository) DrainStatistics(ctx context.Context, workspace string, epoch int64) (map[string]int64, error) {
	var active, outbox, recon int64
	err := repository.pool.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM workflow_control_runs WHERE workspace_id=$1 AND routing_epoch=$2 AND state NOT IN ('completed','failed','cancelled')),
 (SELECT count(*) FROM workflow_control_outbox o JOIN workflow_control_runs r USING(workspace_id,run_id) WHERE o.workspace_id=$1 AND r.routing_epoch=$2 AND o.status<>'published'),
 (SELECT count(*) FROM workflow_control_reconciliations c JOIN workflow_control_transition_receipts r ON r.receipt_id=c.receipt_id WHERE c.workspace_id=$1 AND r.routing_epoch=$2 AND c.status='open' AND NOT EXISTS(SELECT 1 FROM workflow_runner_binding_settlements s JOIN workflow_runner_authority_bindings b USING(binding_id) WHERE b.workspace_id=c.workspace_id AND b.run_id=c.run_id AND r.correlation_id='resume.'||encode(b.stage_hash,'hex')))`, workspace, epoch).Scan(&active, &outbox, &recon)
	if err != nil {
		return nil, databaseFailure("read scoped authority drain", err)
	}
	return map[string]int64{"active_runs": active, "outbox_pending": outbox, "reconciliation_required": recon}, nil
}
