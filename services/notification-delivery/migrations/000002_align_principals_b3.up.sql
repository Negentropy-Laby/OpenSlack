-- B3 Caller Access schema corrections.
--
-- The B1 base schema created principals.vendor_scope as VARCHAR and omitted
-- managed_principal_scope. This migration aligns the principals table with
-- the data model: vendor_scope is a TEXT[] set and managed_principal_scope is
-- added for operators that manage access keys.

BEGIN;

ALTER TABLE principals
    ALTER COLUMN vendor_scope TYPE TEXT[] USING COALESCE(ARRAY[vendor_scope], '{}'),
    ADD COLUMN managed_principal_scope TEXT[] NOT NULL DEFAULT '{}';

COMMIT;
