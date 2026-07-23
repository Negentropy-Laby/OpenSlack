BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM delivery_attempts
        WHERE config_version IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            '000009 down migration refused: delivery attempt config_version evidence exists';
    END IF;
END
$$;

ALTER TABLE delivery_attempts
    DROP CONSTRAINT delivery_attempts_config_version_positive;

ALTER TABLE delivery_attempts
    DROP COLUMN config_version;

COMMIT;
