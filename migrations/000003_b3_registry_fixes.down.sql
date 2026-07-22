-- B3 Vendor Registry schema correction rollback.

BEGIN;

ALTER TABLE endpoint_versions
    DROP COLUMN hostname,
    DROP COLUMN port;

ALTER TABLE endpoint_versions
    DROP CONSTRAINT endpoint_versions_auth_strategy_check,
    ADD CONSTRAINT endpoint_versions_auth_strategy_check
        CHECK (auth_strategy IN ('bearer', 'hmac', 'mTLS', 'aws_sig_v4', 'custom'));

COMMIT;
