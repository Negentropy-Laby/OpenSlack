-- B1 base schema rollback.
--
-- This is the documented restore/rollback procedure for the first migration.
-- Drops tables, indexes, triggers and helper functions in dependency order.
-- Uses IF EXISTS so it can be repeated safely.

BEGIN;

DROP TRIGGER IF EXISTS delivery_attempts_append_only ON delivery_attempts;
DROP TRIGGER IF EXISTS admin_audit_events_append_only ON admin_audit_events;
DROP TRIGGER IF EXISTS admin_command_receipts_append_only ON admin_command_receipts;
DROP TRIGGER IF EXISTS endpoint_versions_append_only ON endpoint_versions;

DROP FUNCTION IF EXISTS rc_wsman_append_only_protect();

DROP TABLE IF EXISTS delivery_attempts CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS admin_audit_events CASCADE;
DROP TABLE IF EXISTS admin_command_receipts CASCADE;
DROP TABLE IF EXISTS endpoint_versions CASCADE;
DROP TABLE IF EXISTS vendors CASCADE;
DROP TABLE IF EXISTS access_keys CASCADE;
DROP TABLE IF EXISTS principals CASCADE;

-- pgcrypto is database-scoped and may be shared by other schemas/services.
-- Rollback removes only rc_wsman-owned objects and deliberately leaves the
-- extension installed.

COMMIT;
