-- B3 Caller Access schema rollback.
--
-- Reverts the principals table corrections from 000002. Existing data in the
-- array columns will be lost; this migration is intended for development/test
-- teardown only.

BEGIN;

ALTER TABLE principals
    DROP COLUMN managed_principal_scope,
    ALTER COLUMN vendor_scope TYPE VARCHAR(128) USING vendor_scope[1];

COMMIT;
