-- GS9-B default-off Workflow Control authority qualification namespace.
-- This schema does not activate routing or transfer TypeScript-owned runs.
BEGIN;

CREATE OR REPLACE FUNCTION workflow_control_authority_reject_immutable_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is immutable and does not allow UPDATE or DELETE', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION workflow_control_authority_run_head_transition()
RETURNS trigger AS $$
BEGIN
    IF OLD.workspace_id <> NEW.workspace_id
       OR OLD.run_id <> NEW.run_id
       OR OLD.workflow_id <> NEW.workflow_id
       OR OLD.workflow_version <> NEW.workflow_version
       OR OLD.workflow_source_hash <> NEW.workflow_source_hash
       OR OLD.manifest_hash <> NEW.manifest_hash
       OR OLD.input_hash <> NEW.input_hash
       OR OLD.backend <> NEW.backend
       OR OLD.authority <> NEW.authority
       OR OLD.routing_epoch <> NEW.routing_epoch
       OR OLD.authority_build_hash <> NEW.authority_build_hash
       OR OLD.created_at <> NEW.created_at
       OR NEW.revision <> OLD.revision + 1
       OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'workflow authority run head update violates immutable route or monotonic revision';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION workflow_control_authority_outbox_transition()
RETURNS trigger AS $$
BEGIN
    IF OLD.outbox_id <> NEW.outbox_id
       OR OLD.event_id <> NEW.event_id
       OR OLD.workspace_id <> NEW.workspace_id
       OR OLD.run_id <> NEW.run_id
       OR OLD.run_revision <> NEW.run_revision
       OR OLD.event_type <> NEW.event_type
       OR OLD.idempotency_key <> NEW.idempotency_key
       OR OLD.payload_hash <> NEW.payload_hash
       OR OLD.canonical_payload_bytes <> NEW.canonical_payload_bytes
       OR OLD.created_at <> NEW.created_at
       OR OLD.status <> 'pending'
       OR NEW.status NOT IN ('pending', 'published', 'dead')
       OR NEW.attempt_count < OLD.attempt_count
       OR NEW.attempt_count > OLD.attempt_count + 1 THEN
        RAISE EXCEPTION 'workflow authority outbox update violates immutable payload or delivery transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE workflow_control_authority_epochs (
    workspace_id TEXT NOT NULL,
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    backend TEXT NOT NULL CHECK (backend = 'go'),
    authority TEXT NOT NULL CHECK (authority = 'workflow-control'),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash) = 32),
    registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, routing_epoch),
    UNIQUE (workspace_id, routing_epoch, backend, authority, authority_build_hash)
);

CREATE TABLE workflow_control_runs (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    workflow_source_hash BYTEA NOT NULL CHECK (octet_length(workflow_source_hash) = 32),
    manifest_hash BYTEA NOT NULL CHECK (octet_length(manifest_hash) = 32),
    input_hash BYTEA NOT NULL CHECK (octet_length(input_hash) = 32),
    backend TEXT NOT NULL CHECK (backend = 'go'),
    authority TEXT NOT NULL CHECK (authority = 'workflow-control'),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash) = 32),
    state TEXT NOT NULL CHECK (state IN (
        'created', 'previewed', 'confirmed', 'running', 'paused',
        'paused_waiting_approval', 'resuming', 'completed', 'failed',
        'cancelled', 'reconciliation_required'
    )),
    revision BIGINT NOT NULL CHECK (revision >= 1),
    current_phase_id TEXT,
    current_phase_index BIGINT CHECK (current_phase_index IS NULL OR current_phase_index >= 0),
    resume_generation BIGINT NOT NULL CHECK (resume_generation >= 0),
    record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
    canonical_record_bytes BYTEA NOT NULL CHECK (octet_length(canonical_record_bytes) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, run_id),
    FOREIGN KEY (workspace_id, routing_epoch, backend, authority, authority_build_hash)
        REFERENCES workflow_control_authority_epochs (
            workspace_id, routing_epoch, backend, authority, authority_build_hash
        ),
    CHECK ((current_phase_id IS NULL) = (current_phase_index IS NULL))
);

CREATE TABLE workflow_control_transition_receipts (
    receipt_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation = 'run_transition'),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'reconciliation_required')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
    accepted_revision BIGINT CHECK (accepted_revision IS NULL OR accepted_revision >= 1),
    resume_generation BIGINT NOT NULL CHECK (resume_generation >= 0),
    backend TEXT NOT NULL CHECK (backend = 'go'),
    authority TEXT NOT NULL CHECK (authority = 'workflow-control'),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash) = 32),
    record_hash BYTEA CHECK (record_hash IS NULL OR octet_length(record_hash) = 32),
    correlation_id TEXT NOT NULL,
    service_build_hash BYTEA NOT NULL CHECK (octet_length(service_build_hash) = 32),
    committed_at TIMESTAMPTZ,
    reconciliation_token TEXT,
    exact_receipt_bytes BYTEA NOT NULL CHECK (octet_length(exact_receipt_bytes) > 0),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (status = 'accepted' AND accepted_revision = expected_revision + 1
            AND record_hash IS NOT NULL AND committed_at IS NOT NULL
            AND reconciliation_token IS NULL)
        OR
        (status = 'reconciliation_required' AND accepted_revision IS NULL
            AND record_hash IS NULL AND committed_at IS NULL
            AND reconciliation_token IS NOT NULL AND char_length(reconciliation_token) > 0)
    )
);

CREATE TABLE workflow_control_transition_events (
    event_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    from_revision BIGINT NOT NULL CHECK (from_revision >= 0),
    to_revision BIGINT NOT NULL CHECK (to_revision = from_revision + 1),
    from_state TEXT CHECK (from_state IS NULL OR from_state IN (
        'created', 'previewed', 'confirmed', 'running', 'paused',
        'paused_waiting_approval', 'resuming', 'completed', 'failed',
        'cancelled', 'reconciliation_required'
    )),
    to_state TEXT NOT NULL CHECK (to_state IN (
        'created', 'previewed', 'confirmed', 'running', 'paused',
        'paused_waiting_approval', 'resuming', 'completed', 'failed',
        'cancelled', 'reconciliation_required'
    )),
    from_phase_id TEXT,
    from_phase_index BIGINT CHECK (from_phase_index IS NULL OR from_phase_index >= 0),
    to_phase_id TEXT,
    to_phase_index BIGINT CHECK (to_phase_index IS NULL OR to_phase_index >= 0),
    from_resume_generation BIGINT NOT NULL CHECK (from_resume_generation >= 0),
    to_resume_generation BIGINT NOT NULL CHECK (to_resume_generation >= 0),
    backend TEXT NOT NULL CHECK (backend = 'go'),
    authority TEXT NOT NULL CHECK (authority = 'workflow-control'),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash) = 32),
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
    correlation_id TEXT NOT NULL,
    canonical_record_bytes BYTEA NOT NULL CHECK (octet_length(canonical_record_bytes) > 0),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, run_id, to_revision),
    FOREIGN KEY (receipt_id) REFERENCES workflow_control_transition_receipts (receipt_id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK ((from_phase_id IS NULL) = (from_phase_index IS NULL)),
    CHECK ((to_phase_id IS NULL) = (to_phase_index IS NULL)),
    CHECK ((from_revision = 0 AND from_state IS NULL) OR (from_revision >= 1 AND from_state IS NOT NULL))
);

CREATE TABLE workflow_control_outbox (
    outbox_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE REFERENCES workflow_control_transition_events (event_id)
        DEFERRABLE INITIALLY DEFERRED,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    run_revision BIGINT NOT NULL CHECK (run_revision >= 1),
    event_type TEXT NOT NULL CHECK (event_type = 'workflow_control.run_transitioned'),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'dead')),
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
    canonical_payload_bytes BYTEA NOT NULL CHECK (octet_length(canonical_payload_bytes) > 0),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, run_id, run_revision),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE TABLE workflow_control_reconciliations (
    reconciliation_token TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL UNIQUE REFERENCES workflow_control_transition_receipts (receipt_id),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    evidence_hash BYTEA NOT NULL CHECK (octet_length(evidence_hash) = 32),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
    expected_state TEXT CHECK (expected_state IS NULL OR expected_state IN (
        'created', 'previewed', 'confirmed', 'running', 'paused',
        'paused_waiting_approval', 'resuming', 'completed', 'failed',
        'cancelled', 'reconciliation_required'
    )),
    expected_phase_id TEXT,
    expected_phase_index BIGINT CHECK (expected_phase_index IS NULL OR expected_phase_index >= 0),
    expected_resume_generation BIGINT NOT NULL CHECK (expected_resume_generation >= 0),
    target_revision BIGINT NOT NULL CHECK (target_revision = expected_revision + 1),
    target_state TEXT NOT NULL CHECK (target_state IN (
        'created', 'previewed', 'confirmed', 'running', 'paused',
        'paused_waiting_approval', 'resuming', 'completed', 'failed',
        'cancelled', 'reconciliation_required'
    )),
    target_phase_id TEXT,
    target_phase_index BIGINT CHECK (target_phase_index IS NULL OR target_phase_index >= 0),
    target_resume_generation BIGINT NOT NULL CHECK (target_resume_generation >= 0),
    backend TEXT NOT NULL CHECK (backend = 'go'),
    authority TEXT NOT NULL CHECK (authority = 'workflow-control'),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash) = 32),
    requested_record_hash BYTEA NOT NULL CHECK (octet_length(requested_record_hash) = 32),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status = 'open'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((expected_phase_id IS NULL) = (expected_phase_index IS NULL)),
    CHECK ((target_phase_id IS NULL) = (target_phase_index IS NULL)),
    CHECK ((expected_revision = 0 AND expected_state IS NULL) OR (expected_revision >= 1 AND expected_state IS NOT NULL))
);

CREATE INDEX workflow_control_transition_receipts_run_idx
    ON workflow_control_transition_receipts (workspace_id, run_id, recorded_at);
CREATE INDEX workflow_control_transition_receipts_status_idx
    ON workflow_control_transition_receipts (status, recorded_at);
CREATE INDEX workflow_control_transition_events_run_idx
    ON workflow_control_transition_events (workspace_id, run_id, to_revision);
CREATE INDEX workflow_control_outbox_pending_idx
    ON workflow_control_outbox (status, available_at, created_at);
CREATE INDEX workflow_control_reconciliations_run_idx
    ON workflow_control_reconciliations (workspace_id, run_id, created_at);
CREATE UNIQUE INDEX workflow_control_reconciliations_one_open_run_idx
    ON workflow_control_reconciliations (workspace_id, run_id) WHERE status = 'open';

CREATE TRIGGER workflow_control_authority_epochs_immutable
BEFORE UPDATE OR DELETE ON workflow_control_authority_epochs
FOR EACH ROW EXECUTE FUNCTION workflow_control_authority_reject_immutable_mutation();

CREATE TRIGGER workflow_control_runs_transition
BEFORE UPDATE ON workflow_control_runs
FOR EACH ROW EXECUTE FUNCTION workflow_control_authority_run_head_transition();

CREATE TRIGGER workflow_control_runs_no_delete
BEFORE DELETE ON workflow_control_runs
FOR EACH ROW EXECUTE FUNCTION workflow_control_authority_reject_immutable_mutation();

CREATE TRIGGER workflow_control_transition_events_immutable
BEFORE UPDATE OR DELETE ON workflow_control_transition_events
FOR EACH ROW EXECUTE FUNCTION workflow_control_authority_reject_immutable_mutation();

CREATE TRIGGER workflow_control_transition_receipts_immutable
BEFORE UPDATE OR DELETE ON workflow_control_transition_receipts
FOR EACH ROW EXECUTE FUNCTION workflow_control_authority_reject_immutable_mutation();

CREATE TRIGGER workflow_control_reconciliations_immutable
BEFORE UPDATE OR DELETE ON workflow_control_reconciliations
FOR EACH ROW EXECUTE FUNCTION workflow_control_authority_reject_immutable_mutation();

CREATE TRIGGER workflow_control_outbox_transition
BEFORE UPDATE ON workflow_control_outbox
FOR EACH ROW EXECUTE FUNCTION workflow_control_authority_outbox_transition();

CREATE TRIGGER workflow_control_outbox_no_delete
BEFORE DELETE ON workflow_control_outbox
FOR EACH ROW EXECUTE FUNCTION workflow_control_authority_reject_immutable_mutation();

COMMIT;
