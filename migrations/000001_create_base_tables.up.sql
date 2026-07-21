-- B1 base schema.
--
-- Per data-model.md, the outbox has no separate table: pending rows in
-- `notifications` are the outbox and dead rows are the DLQ.  This migration
-- creates the logical-model tables, indexes, OCC version columns and
-- append-only protections.  It is forward-only and idempotent at the object
-- level.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Append-only enforcement helper.  Raises an error on any UPDATE or DELETE
-- against tables that must only grow.
CREATE OR REPLACE FUNCTION rc_wsman_append_only_protect()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is append-only and does not allow UPDATE or DELETE', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Caller Access: principals.
CREATE TABLE IF NOT EXISTS principals (
    principal_id VARCHAR(128) PRIMARY KEY,
    kind VARCHAR(32) NOT NULL CHECK (kind IN ('caller', 'operator')),
    status VARCHAR(32) NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
    vendor_scope VARCHAR(128),
    owning_scope VARCHAR(128),
    capabilities TEXT[] NOT NULL DEFAULT '{}',
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Caller Access: access_keys.
-- The pepper_id label is non-secret; the actual pepper value is a deployment
-- secret loaded at startup and never persisted here.
CREATE TABLE IF NOT EXISTS access_keys (
    key_id VARCHAR(128) PRIMARY KEY,
    principal_id VARCHAR(128) NOT NULL REFERENCES principals(principal_id),
    secret_hash BYTEA NOT NULL,
    pepper_id VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT access_keys_secret_hash_unique UNIQUE (secret_hash)
);
CREATE INDEX IF NOT EXISTS access_keys_principal_status_idx
    ON access_keys (principal_id, status);

-- Vendor Registry: vendors.
CREATE TABLE IF NOT EXISTS vendors (
    vendor_id VARCHAR(64) PRIMARY KEY,
    owning_scope VARCHAR(128) NOT NULL,
    lifecycle VARCHAR(32) NOT NULL CHECK (lifecycle IN ('draft', 'active', 'disabled')),
    record_revision BIGINT NOT NULL DEFAULT 1 CHECK (record_revision >= 1),
    current_config_version BIGINT NOT NULL DEFAULT 1 CHECK (current_config_version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ,
    disabled_reason TEXT
);
CREATE INDEX IF NOT EXISTS vendors_created_at_idx
    ON vendors (created_at, vendor_id);
CREATE INDEX IF NOT EXISTS vendors_scope_created_at_idx
    ON vendors (owning_scope, created_at, vendor_id);

-- Vendor Registry: endpoint_versions (append-only immutable configurations).
CREATE TABLE IF NOT EXISTS endpoint_versions (
    vendor_id VARCHAR(64) NOT NULL REFERENCES vendors(vendor_id),
    config_version BIGINT NOT NULL CHECK (config_version >= 1),
    config_schema_version BIGINT NOT NULL DEFAULT 1 CHECK (config_schema_version >= 1),
    canonical_url TEXT NOT NULL,
    method VARCHAR(16) NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH')),
    transport_kind VARCHAR(32) NOT NULL CHECK (transport_kind IN ('https_public', 'https_private')),
    auth_strategy VARCHAR(32) NOT NULL CHECK (auth_strategy IN ('bearer', 'hmac', 'mTLS', 'aws_sig_v4', 'custom')),
    credential_ref_scheme VARCHAR(16) NOT NULL CHECK (credential_ref_scheme IN ('env')),
    credential_ref_handle VARCHAR(128) NOT NULL,
    credential_ref_version VARCHAR(128),
    transport_auth_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
    outbound_idempotency_mapping JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb,
    endpoint_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by_actor VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vendor_id, config_version)
);
CREATE TRIGGER endpoint_versions_append_only
    BEFORE UPDATE OR DELETE ON endpoint_versions
    FOR EACH ROW EXECUTE FUNCTION rc_wsman_append_only_protect();

-- Vendor Registry: admin_command_receipts (immutable idempotency receipts).
CREATE TABLE IF NOT EXISTS admin_command_receipts (
    receipt_id VARCHAR(128) PRIMARY KEY,
    actor_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    command_fingerprint_hash BYTEA NOT NULL,
    result JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_command_receipts_actor_idempotency_unique
        UNIQUE (actor_id, idempotency_key)
);
CREATE TRIGGER admin_command_receipts_append_only
    BEFORE UPDATE OR DELETE ON admin_command_receipts
    FOR EACH ROW EXECUTE FUNCTION rc_wsman_append_only_protect();

-- Vendor Registry: admin_audit_events (append-only sanitized audit trail).
-- Credential locators, secrets, command fingerprints and raw caller fields are
-- forbidden here by design.
CREATE TABLE IF NOT EXISTS admin_audit_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_seq BIGSERIAL UNIQUE NOT NULL,
    vendor_id VARCHAR(64) NOT NULL REFERENCES vendors(vendor_id),
    owning_scope VARCHAR(128) NOT NULL,
    actor_id VARCHAR(128) NOT NULL,
    authorization_basis VARCHAR(32) NOT NULL
        CHECK (authorization_basis IN ('all', 'vendor_id', 'owning_scope')),
    operation VARCHAR(64) NOT NULL,
    outcome VARCHAR(32) NOT NULL CHECK (outcome IN ('success', 'rejected')),
    expected_record_revision_before BIGINT,
    record_revision_after BIGINT,
    sanitized_request_digest VARCHAR(128) NOT NULL,
    receipt_id VARCHAR(128) REFERENCES admin_command_receipts(receipt_id),
    reject_reason TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_events_seq_idx
    ON admin_audit_events (audit_seq DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_vendor_seq_idx
    ON admin_audit_events (vendor_id, audit_seq DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_scope_seq_idx
    ON admin_audit_events (owning_scope, audit_seq DESC);
CREATE TRIGGER admin_audit_events_append_only
    BEFORE UPDATE OR DELETE ON admin_audit_events
    FOR EACH ROW EXECUTE FUNCTION rc_wsman_append_only_protect();

-- Notification Store: notifications.
-- Pending rows are the outbox; dead rows are the DLQ.  No second table exists.
CREATE TABLE IF NOT EXISTS notifications (
    notification_id VARCHAR(128) PRIMARY KEY,
    caller_id VARCHAR(128) NOT NULL,
    vendor_id VARCHAR(64) NOT NULL REFERENCES vendors(vendor_id),
    idempotency_key VARCHAR(255) NOT NULL,
    request_fingerprint BYTEA NOT NULL,
    payload_bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    state VARCHAR(32) NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'in_flight', 'delivered', 'dead')),
    version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    delivery_cycle_started_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    lease_id VARCHAR(128),
    lease_expires_at TIMESTAMPTZ,
    lease_actor_id VARCHAR(128),
    delivered_at TIMESTAMPTZ,
    dead_at TIMESTAMPTZ,
    dead_reason VARCHAR(128),
    replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
    replayed_at TIMESTAMPTZ,
    replay_actor VARCHAR(128),
    replay_reason TEXT,
    last_outcome_class VARCHAR(32)
        CHECK (last_outcome_class IN ('success', 'retryable_failure', 'permanent_failure')),
    last_error_code VARCHAR(128),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT notifications_caller_idempotency_unique
        UNIQUE (caller_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS notifications_eligible_idx
    ON notifications (next_attempt_at, delivery_cycle_started_at, created_at, notification_id)
    WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS notifications_lease_recovery_idx
    ON notifications (lease_expires_at, notification_id)
    WHERE state = 'in_flight';

CREATE INDEX IF NOT EXISTS notifications_dead_list_idx
    ON notifications (vendor_id, dead_at, notification_id)
    WHERE state = 'dead';

CREATE INDEX IF NOT EXISTS notifications_state_created_idx
    ON notifications (state, created_at, notification_id);

-- Notification Store: delivery_attempts (append-only history).
CREATE TABLE IF NOT EXISTS delivery_attempts (
    attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id VARCHAR(128) NOT NULL REFERENCES notifications(notification_id),
    attempt_seq BIGINT NOT NULL CHECK (attempt_seq >= 1),
    event_kind VARCHAR(32) NOT NULL
        CHECK (event_kind IN ('claimed', 'outcome', 'recovery', 'replay')),
    claimed_at TIMESTAMPTZ,
    outcome_class VARCHAR(32)
        CHECK (outcome_class IN ('success', 'retryable_failure', 'permanent_failure')),
    result_kind VARCHAR(32)
        CHECK (result_kind IN ('http_response', 'transport_failure', 'unknown_result', 'policy_termination')),
    http_status INTEGER,
    error_code VARCHAR(128),
    reason VARCHAR(255),
    actor_id VARCHAR(128),
    lease_id VARCHAR(128),
    lease_expires_at TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT delivery_attempts_notification_seq_unique
        UNIQUE (notification_id, attempt_seq)
);
CREATE INDEX IF NOT EXISTS delivery_attempts_history_idx
    ON delivery_attempts (notification_id, attempt_seq, attempt_id);
CREATE TRIGGER delivery_attempts_append_only
    BEFORE UPDATE OR DELETE ON delivery_attempts
    FOR EACH ROW EXECUTE FUNCTION rc_wsman_append_only_protect();

COMMIT;
