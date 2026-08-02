BEGIN;
DROP TABLE IF EXISTS governance_shadow_receipts;
DROP TABLE IF EXISTS governance_shadow_record_versions;
DROP TABLE IF EXISTS governance_shadow_observations;
DROP TABLE IF EXISTS governance_shadow_heads;
DROP FUNCTION IF EXISTS governance_shadow_reject_immutable_mutation();
COMMIT;
