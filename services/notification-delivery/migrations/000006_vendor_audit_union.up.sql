BEGIN;

ALTER TABLE admin_audit_events
    ADD CONSTRAINT admin_audit_events_operation_check
        CHECK (operation IN ('register', 'update_version', 'activate', 'disable', 'rotate_credential_ref')),
    ADD CONSTRAINT admin_audit_events_result_union_check CHECK (
        (outcome = 'success'
            AND receipt_id IS NOT NULL
            AND reject_reason IS NULL
            AND record_revision_after IS NOT NULL)
        OR
        (outcome = 'rejected'
            AND receipt_id IS NULL
            AND record_revision_after IS NULL
            AND reject_reason IN (
                'VENDOR_ID_UNAVAILABLE', 'VENDOR_NOT_FOUND',
                'EXPECTED_VERSION_MISMATCH', 'INVALID_TRANSITION',
                'VENDOR_DISABLED_UPDATE_FORBIDDEN',
                'INVALID_ENDPOINT_POLICY', 'INVALID_CREDENTIAL_REF'
            ))
    );

COMMIT;
