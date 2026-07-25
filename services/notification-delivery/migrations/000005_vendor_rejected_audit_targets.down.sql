BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM admin_audit_events a
        LEFT JOIN vendors v ON v.vendor_id = a.vendor_id
        WHERE a.owning_scope IS NULL OR v.vendor_id IS NULL
    ) THEN
        RAISE EXCEPTION 'cannot restore vendor audit foreign key: orphan/not-found audit rows exist';
    END IF;
END $$;

ALTER TABLE admin_audit_events
    ALTER COLUMN owning_scope SET NOT NULL,
    ADD CONSTRAINT admin_audit_events_vendor_id_fkey
        FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id);

COMMIT;
