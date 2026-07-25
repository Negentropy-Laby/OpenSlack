BEGIN;

ALTER TABLE delivery_attempts
    ADD COLUMN config_version BIGINT;

ALTER TABLE delivery_attempts
    ADD CONSTRAINT delivery_attempts_config_version_positive
        CHECK (config_version IS NULL OR config_version >= 1);

COMMIT;
