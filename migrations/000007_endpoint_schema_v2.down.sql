-- Fail-closed rollback for IB1 endpoint configuration schema v2 storage.

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM endpoint_versions
        WHERE config_schema_version <> 1
           OR auth_strategy <> 'bearer'
           OR credential_ref_scheme IS NULL
           OR credential_ref_handle IS NULL
           OR response_policy <> 'http_status_v1'
    ) THEN
        RAISE EXCEPTION 'cannot roll back endpoint schema v2: v2-only endpoint data exists';
    END IF;
END $$;

ALTER TABLE endpoint_versions
    DROP CONSTRAINT endpoint_versions_schema_auth_policy_union_check,
    DROP CONSTRAINT endpoint_versions_response_policy_check,
    DROP CONSTRAINT endpoint_versions_config_schema_version_check,
    DROP CONSTRAINT endpoint_versions_auth_strategy_check;

ALTER TABLE endpoint_versions
    ALTER COLUMN credential_ref_scheme SET NOT NULL,
    ALTER COLUMN credential_ref_handle SET NOT NULL,
    DROP COLUMN response_policy;

ALTER TABLE endpoint_versions
    ADD CONSTRAINT endpoint_versions_config_schema_version_check
        CHECK (config_schema_version >= 1),
    ADD CONSTRAINT endpoint_versions_auth_strategy_check
        CHECK (auth_strategy = 'bearer');

COMMIT;
