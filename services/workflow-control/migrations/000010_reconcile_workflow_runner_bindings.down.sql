BEGIN;
-- Serialize the empty-evidence check with every in-flight settlement/fence/pause.
-- Checking before taking these locks can discard evidence committed during DDL.
LOCK TABLE workflow_control_source_fences,workflow_runner_binding_settlements,workflow_control_recovery_pauses
 IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM workflow_runner_binding_settlements)
 OR EXISTS (SELECT 1 FROM workflow_control_source_fences)
 OR EXISTS (SELECT 1 FROM workflow_control_recovery_pauses) THEN
   RAISE EXCEPTION 'schema 10 recovery evidence forbids destructive downgrade; use a compatible build';
 END IF;
END $$;
DROP TRIGGER workflow_runner_binding_settled ON workflow_runner_authority_bindings;
DROP TRIGGER workflow_runner_recovery_lease_fence ON workflow_runner_leases;
DROP TRIGGER workflow_runner_recovery_stage_fence ON workflow_runner_authority_bindings;
DROP TRIGGER workflow_control_source_event_fence ON workflow_control_transition_events;
DROP TRIGGER workflow_control_source_receipt_fence ON workflow_control_transition_receipts;
DROP TRIGGER workflow_control_recovery_pause_guard ON workflow_control_runs;
DROP TABLE workflow_control_recovery_pauses,workflow_runner_binding_settlements,workflow_control_source_fences;
DROP FUNCTION workflow_runner_reject_settled_binding_write(),workflow_control_check_source_fence(),
 workflow_control_install_source_fence(),workflow_runner_binding_settlement_guard(),workflow_control_check_recovery_pause(),workflow_runner_recovery_lease_guard(),workflow_runner_recovery_stage_guard();
COMMIT;
