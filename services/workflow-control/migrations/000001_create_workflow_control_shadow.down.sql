BEGIN;
DROP TABLE IF EXISTS workflow_control_shadow_receipts;
DROP TABLE IF EXISTS workflow_control_shadow_observations;
DROP TABLE IF EXISTS workflow_control_shadow_heads;
DROP FUNCTION IF EXISTS workflow_control_shadow_reject_immutable_mutation();
COMMIT;
