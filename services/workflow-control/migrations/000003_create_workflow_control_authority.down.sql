BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM workflow_control_authority_epochs LIMIT 1)
       OR EXISTS (SELECT 1 FROM workflow_control_runs LIMIT 1)
       OR EXISTS (SELECT 1 FROM workflow_control_transition_events LIMIT 1)
       OR EXISTS (SELECT 1 FROM workflow_control_transition_receipts LIMIT 1)
       OR EXISTS (SELECT 1 FROM workflow_control_outbox LIMIT 1)
       OR EXISTS (SELECT 1 FROM workflow_control_reconciliations LIMIT 1) THEN
        RAISE EXCEPTION 'refusing to remove GS9-B workflow authority schema while authority records exist';
    END IF;
END;
$$;

DROP TABLE workflow_control_reconciliations;
DROP TABLE workflow_control_outbox;
DROP TABLE workflow_control_transition_events;
DROP TABLE workflow_control_transition_receipts;
DROP TABLE workflow_control_runs;
DROP TABLE workflow_control_authority_epochs;
DROP FUNCTION workflow_control_authority_outbox_transition();
DROP FUNCTION workflow_control_authority_run_head_transition();
DROP FUNCTION workflow_control_authority_reject_immutable_mutation();

COMMIT;
