-- GS6 Governance Control authority namespace for records explicitly routed to Go.
BEGIN;

CREATE OR REPLACE FUNCTION governance_authority_reject_immutable_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is immutable and does not allow UPDATE or DELETE', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE governance_authority_routes (
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    backend TEXT NOT NULL CHECK (backend = 'go'),
    authority TEXT NOT NULL CHECK (authority = 'governance-control'),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch >= 1 AND routing_epoch <= 9007199254740991),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, plan_id)
);

CREATE TABLE governance_authority_heads (
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL CHECK (state IN (
        'pending', 'executing', 'succeeded', 'blocked', 'failed',
        'reconciliation_required', 'cancelled', 'expired'
    )),
    record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
    service_build_sha BYTEA NOT NULL CHECK (octet_length(service_build_sha) = 32),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, plan_id),
    FOREIGN KEY (workspace_id, plan_id)
        REFERENCES governance_authority_routes (workspace_id, plan_id)
);

CREATE TABLE governance_authority_record_versions (
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL CHECK (state IN (
        'pending', 'executing', 'succeeded', 'blocked', 'failed',
        'reconciliation_required', 'cancelled', 'expired'
    )),
    record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
    canonical_record_bytes BYTEA NOT NULL CHECK (octet_length(canonical_record_bytes) > 0),
    idempotency_key TEXT NOT NULL UNIQUE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, plan_id, revision),
    FOREIGN KEY (workspace_id, plan_id)
        REFERENCES governance_authority_routes (workspace_id, plan_id)
);

CREATE TABLE governance_authority_receipts (
    receipt_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN (
        'accept', 'claim_execution', 'complete_execution', 'cancel', 'expire',
        'require_reconciliation'
    )),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'reconciliation_required')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
    accepted_revision BIGINT CHECK (accepted_revision IS NULL OR accepted_revision >= 1),
    accepted_state TEXT CHECK (accepted_state IS NULL OR accepted_state IN (
        'pending', 'executing', 'succeeded', 'blocked', 'failed',
        'reconciliation_required', 'cancelled', 'expired'
    )),
    target_revision BIGINT CHECK (target_revision IS NULL OR target_revision >= 1),
    target_state TEXT CHECK (target_state IS NULL OR target_state IN (
        'pending', 'executing', 'succeeded', 'blocked', 'failed',
        'reconciliation_required', 'cancelled', 'expired'
    )),
    backend TEXT NOT NULL CHECK (backend = 'go'),
    authority TEXT NOT NULL CHECK (authority = 'governance-control'),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch >= 1 AND routing_epoch <= 9007199254740991),
    record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
    correlation_id TEXT NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 256),
    caller_id TEXT NOT NULL CHECK (char_length(caller_id) BETWEEN 1 AND 256),
    execution_id TEXT,
    service_build_sha BYTEA NOT NULL CHECK (octet_length(service_build_sha) = 32),
    canonical_record_bytes BYTEA,
    committed_at TIMESTAMPTZ,
    reconciliation_token TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (status = 'accepted' AND accepted_revision IS NOT NULL AND accepted_state IS NOT NULL
            AND target_revision IS NULL AND target_state IS NULL
            AND canonical_record_bytes IS NOT NULL AND committed_at IS NOT NULL
            AND reconciliation_token IS NULL)
        OR
        (status = 'reconciliation_required' AND accepted_revision IS NULL AND accepted_state IS NULL
            AND target_revision IS NOT NULL AND target_state IS NOT NULL
            AND canonical_record_bytes IS NULL AND committed_at IS NULL
            AND reconciliation_token IS NOT NULL AND char_length(reconciliation_token) > 0)
    )
);

CREATE TABLE governance_authority_events (
    event_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL UNIQUE REFERENCES governance_authority_receipts (receipt_id),
    operation TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL,
    record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE governance_authority_audit_deliveries (
    receipt_id TEXT PRIMARY KEY REFERENCES governance_authority_receipts (receipt_id),
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    status TEXT NOT NULL CHECK (status IN ('pending', 'recorded')),
    audit_event_id TEXT,
    audit_event_hash BYTEA CHECK (audit_event_hash IS NULL OR octet_length(audit_event_hash) = 32),
    canonical_audit_bytes BYTEA,
    idempotency_key TEXT UNIQUE,
    request_fingerprint BYTEA CHECK (request_fingerprint IS NULL OR octet_length(request_fingerprint) = 32),
    recorded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, plan_id, revision),
    CHECK (
        (status = 'pending' AND audit_event_id IS NULL AND audit_event_hash IS NULL
            AND canonical_audit_bytes IS NULL AND idempotency_key IS NULL
            AND request_fingerprint IS NULL AND recorded_at IS NULL)
        OR
        (status = 'recorded' AND audit_event_id IS NOT NULL AND audit_event_hash IS NOT NULL
            AND canonical_audit_bytes IS NOT NULL AND idempotency_key IS NOT NULL
            AND request_fingerprint IS NOT NULL AND recorded_at IS NOT NULL)
    )
);

CREATE OR REPLACE FUNCTION governance_authority_audit_delivery_transition()
RETURNS trigger AS $$
BEGIN
    IF OLD.status <> 'pending' OR NEW.status <> 'recorded'
       OR OLD.receipt_id <> NEW.receipt_id
       OR OLD.workspace_id <> NEW.workspace_id
       OR OLD.plan_id <> NEW.plan_id
       OR OLD.revision <> NEW.revision
       OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'authority audit delivery only permits pending to recorded';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX governance_authority_receipts_plan_idx
    ON governance_authority_receipts (workspace_id, plan_id, recorded_at);
CREATE INDEX governance_authority_receipts_status_idx
    ON governance_authority_receipts (status);
CREATE INDEX governance_authority_events_plan_idx
    ON governance_authority_events (workspace_id, plan_id, revision);
CREATE INDEX governance_authority_audit_deliveries_status_idx
    ON governance_authority_audit_deliveries (status, created_at);
CREATE UNIQUE INDEX governance_authority_audit_deliveries_one_pending_plan_idx
    ON governance_authority_audit_deliveries (workspace_id, plan_id)
    WHERE status = 'pending';

CREATE TRIGGER governance_authority_routes_immutable
BEFORE UPDATE OR DELETE ON governance_authority_routes
FOR EACH ROW EXECUTE FUNCTION governance_authority_reject_immutable_mutation();

CREATE TRIGGER governance_authority_record_versions_immutable
BEFORE UPDATE OR DELETE ON governance_authority_record_versions
FOR EACH ROW EXECUTE FUNCTION governance_authority_reject_immutable_mutation();

CREATE TRIGGER governance_authority_receipts_immutable
BEFORE UPDATE OR DELETE ON governance_authority_receipts
FOR EACH ROW EXECUTE FUNCTION governance_authority_reject_immutable_mutation();

CREATE TRIGGER governance_authority_events_immutable
BEFORE UPDATE OR DELETE ON governance_authority_events
FOR EACH ROW EXECUTE FUNCTION governance_authority_reject_immutable_mutation();

CREATE TRIGGER governance_authority_audit_deliveries_transition
BEFORE UPDATE ON governance_authority_audit_deliveries
FOR EACH ROW EXECUTE FUNCTION governance_authority_audit_delivery_transition();

CREATE TRIGGER governance_authority_audit_deliveries_no_delete
BEFORE DELETE ON governance_authority_audit_deliveries
FOR EACH ROW EXECUTE FUNCTION governance_authority_reject_immutable_mutation();

COMMIT;
