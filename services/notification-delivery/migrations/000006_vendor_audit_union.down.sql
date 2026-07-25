BEGIN;

ALTER TABLE admin_audit_events
    DROP CONSTRAINT admin_audit_events_result_union_check,
    DROP CONSTRAINT admin_audit_events_operation_check;

COMMIT;
