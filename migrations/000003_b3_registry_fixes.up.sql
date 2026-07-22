-- B3 Vendor Registry schema corrections.
--
-- The B1 base schema omitted hostname and port from endpoint_versions. These are
-- server-derived from canonical_url and are required for delivery projections
-- and audit stability.

BEGIN;

ALTER TABLE endpoint_versions
    ADD COLUMN hostname TEXT NOT NULL DEFAULT '',
    ADD COLUMN port INTEGER NOT NULL DEFAULT 443;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM endpoint_versions WHERE auth_strategy <> 'bearer') THEN
        RAISE EXCEPTION 'cannot narrow endpoint auth strategy: non-bearer rows exist';
    END IF;
END $$;

ALTER TABLE endpoint_versions
    DROP CONSTRAINT endpoint_versions_auth_strategy_check,
    ADD CONSTRAINT endpoint_versions_auth_strategy_check
        CHECK (auth_strategy = 'bearer');

COMMIT;
