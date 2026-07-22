-- Authorized not-found commands require a rejected audit row. Such a row has
-- no VendorRecord/owning_scope by definition, so the audit target is an opaque
-- command identifier rather than a referential child of vendors.

BEGIN;

ALTER TABLE admin_audit_events
    DROP CONSTRAINT admin_audit_events_vendor_id_fkey,
    ALTER COLUMN owning_scope DROP NOT NULL;

COMMIT;
