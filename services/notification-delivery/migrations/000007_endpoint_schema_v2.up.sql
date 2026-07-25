-- IB1 endpoint configuration schema v2 storage contract.
--
-- This migration only makes the persistence model capable of representing
-- schema v2.  The Vendor Registry command surface continues to create schema
-- v1 endpoint versions until the later public-enablement change.

BEGIN;

ALTER TABLE endpoint_versions
    ADD COLUMN response_policy VARCHAR(32) NOT NULL DEFAULT 'http_status_v1';

ALTER TABLE endpoint_versions
    ALTER COLUMN credential_ref_scheme DROP NOT NULL,
    ALTER COLUMN credential_ref_handle DROP NOT NULL;

ALTER TABLE endpoint_versions
    DROP CONSTRAINT endpoint_versions_config_schema_version_check,
    DROP CONSTRAINT endpoint_versions_auth_strategy_check,
    ADD CONSTRAINT endpoint_versions_config_schema_version_check
        CHECK (config_schema_version IN (1, 2)),
    ADD CONSTRAINT endpoint_versions_auth_strategy_check
        CHECK (auth_strategy IN ('bearer', 'none')),
    ADD CONSTRAINT endpoint_versions_response_policy_check
        CHECK (response_policy IN ('http_status_v1', 'json_ack_v1')),
    ADD CONSTRAINT endpoint_versions_schema_auth_policy_union_check CHECK (
        (
            config_schema_version = 1
            AND auth_strategy = 'bearer'
            AND credential_ref_scheme IS NOT NULL
            AND credential_ref_handle IS NOT NULL
            AND response_policy = 'http_status_v1'
        )
        OR
        (
            config_schema_version = 2
            AND response_policy IN ('http_status_v1', 'json_ack_v1')
            AND (
                (
                    auth_strategy = 'bearer'
                    AND credential_ref_scheme IS NOT NULL
                    AND credential_ref_handle IS NOT NULL
                )
                OR
                (
                    auth_strategy = 'none'
                    AND credential_ref_scheme IS NULL
                    AND credential_ref_handle IS NULL
                    AND credential_ref_version IS NULL
                )
            )
        )
    );

COMMIT;
