package postgres

import "context"

func (repository *Repository) DrainStatistics(ctx context.Context, workspace string, epoch int64) (map[string]int64, error) {
	var jobs, leases, work, recon int64
	err := repository.pool.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM workflow_runner_jobs j WHERE workspace_id=$1 AND routing_epoch=$2 AND NOT EXISTS(SELECT 1 FROM workflow_control_recovery_pauses p WHERE p.workspace_id=j.workspace_id AND p.run_id=j.workflow_run_id AND p.accepted_revision>j.required_run_revision) AND state IN ('queued','offered','running','cancelling')),
 (SELECT count(*) FROM workflow_runner_leases l JOIN workflow_runner_jobs j USING(workspace_id,job_id) WHERE l.workspace_id=$1 AND j.routing_epoch=$2 AND l.state IN ('offered','active','cancelling','expired') AND j.state<>'terminal' AND l.attempt_id=j.current_attempt_id AND NOT EXISTS(SELECT 1 FROM workflow_control_recovery_pauses p WHERE p.workspace_id=j.workspace_id AND p.run_id=j.workflow_run_id AND p.accepted_revision>j.required_run_revision)),
 (SELECT count(*) FROM workflow_runner_authority_bindings b LEFT JOIN workflow_runner_binding_settlements s ON s.binding_id=b.binding_id AND s.workspace_id=b.workspace_id AND s.run_id=b.run_id AND s.stage_hash=b.stage_hash WHERE b.workspace_id=$1 AND b.routing_epoch=$2 AND b.state<>'completed' AND s.binding_id IS NULL),
 (SELECT count(*) FROM workflow_runner_jobs j WHERE workspace_id=$1 AND routing_epoch=$2 AND state='reconciliation_required' AND NOT EXISTS(SELECT 1 FROM workflow_control_recovery_pauses p WHERE p.workspace_id=j.workspace_id AND p.run_id=j.workflow_run_id AND p.accepted_revision>j.required_run_revision))`, workspace, epoch).Scan(&jobs, &leases, &work, &recon)
	if err != nil {
		return nil, databaseFailure("read scoped runner drain", err)
	}
	return map[string]int64{"runner_jobs": jobs, "runner_leases": leases, "runner_work": work, "reconciliation_required": recon}, nil
}
