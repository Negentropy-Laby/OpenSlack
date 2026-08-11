BEGIN;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM workflow_control_checkpoint_shadow_heads LIMIT 1) OR
       EXISTS (SELECT 1 FROM workflow_control_checkpoint_shadow_observations LIMIT 1) OR
       EXISTS (SELECT 1 FROM workflow_control_checkpoint_shadow_receipts LIMIT 1) OR
       EXISTS (SELECT 1 FROM workflow_control_checkpoint_shadow_reconciliations LIMIT 1) THEN
        RAISE EXCEPTION 'refusing to drop non-empty checkpoint shadow tables';
    END IF;
END;
$$;
DROP TABLE workflow_control_checkpoint_shadow_reconciliations;
DROP TABLE workflow_control_checkpoint_shadow_receipts;
DROP TABLE workflow_control_checkpoint_shadow_observations;
DROP TABLE workflow_control_checkpoint_shadow_heads;
DROP FUNCTION workflow_control_checkpoint_shadow_immutable();
DROP FUNCTION workflow_control_checkpoint_shadow_head_transition();
COMMIT;
