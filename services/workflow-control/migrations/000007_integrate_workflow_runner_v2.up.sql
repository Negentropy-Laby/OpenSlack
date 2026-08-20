-- GS9-F default-off Workflow Runner v2 qualification transport.
-- This migration preserves every v1 byte and row; it does not activate routing.
BEGIN;

ALTER TABLE workflow_runner_jobs
    ADD COLUMN required_protocol_version TEXT NOT NULL DEFAULT 'openslack.workflow_runner.v1',
    ADD COLUMN required_capabilities TEXT[] NOT NULL DEFAULT ARRAY['cancel_ack','effect_receipts','lease_heartbeat']::TEXT[],
    ADD COLUMN authority_backend TEXT,
    ADD COLUMN workflow_authority TEXT,
    ADD COLUMN routing_epoch BIGINT,
    ADD COLUMN authority_build_hash BYTEA,
    ADD COLUMN required_run_revision BIGINT,
    ADD COLUMN required_resume_generation BIGINT;

ALTER TABLE workflow_runner_jobs ADD CONSTRAINT workflow_runner_jobs_protocol_binding_check CHECK (
    (required_protocol_version = 'openslack.workflow_runner.v1'
        AND authority_backend IS NULL AND workflow_authority IS NULL AND routing_epoch IS NULL
        AND authority_build_hash IS NULL AND required_run_revision IS NULL AND required_resume_generation IS NULL)
    OR
    (required_protocol_version = 'openslack.workflow_runner.v2'
        AND authority_backend IN ('ts-local','go')
        AND workflow_authority IN ('typescript','workflow-control')
        AND ((authority_backend='ts-local' AND workflow_authority='typescript')
          OR (authority_backend='go' AND workflow_authority='workflow-control'))
        AND routing_epoch BETWEEN 1 AND 9007199254740991
        AND octet_length(authority_build_hash)=32
        AND required_run_revision BETWEEN 1 AND 9007199254740991
        AND required_resume_generation BETWEEN 0 AND 9007199254740991)
);
ALTER TABLE workflow_runner_jobs ADD CONSTRAINT workflow_runner_jobs_required_capabilities_check CHECK (
    required_capabilities = ARRAY['cancel_ack','effect_receipts','lease_heartbeat']::TEXT[]
);

CREATE OR REPLACE FUNCTION workflow_runner_reject_binding_mutation()
RETURNS trigger AS $$
BEGIN
    IF OLD.required_protocol_version IS DISTINCT FROM NEW.required_protocol_version
       OR OLD.required_capabilities IS DISTINCT FROM NEW.required_capabilities
       OR OLD.authority_backend IS DISTINCT FROM NEW.authority_backend
       OR OLD.workflow_authority IS DISTINCT FROM NEW.workflow_authority
       OR OLD.routing_epoch IS DISTINCT FROM NEW.routing_epoch
       OR OLD.authority_build_hash IS DISTINCT FROM NEW.authority_build_hash
       OR OLD.required_run_revision IS DISTINCT FROM NEW.required_run_revision
       OR OLD.required_resume_generation IS DISTINCT FROM NEW.required_resume_generation THEN
        RAISE EXCEPTION 'workflow runner immutable execution binding cannot change';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_runner_jobs_binding_immutable
BEFORE UPDATE ON workflow_runner_jobs
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_binding_mutation();

ALTER TABLE workflow_runner_process_sessions
    DROP CONSTRAINT workflow_runner_process_sessions_protocol_version_check,
    DROP CONSTRAINT workflow_runner_process_sessions_capabilities_check;
ALTER TABLE workflow_runner_process_sessions
    ADD CONSTRAINT workflow_runner_process_sessions_protocol_version_check CHECK (
        protocol_version IN ('openslack.workflow_runner.v1','openslack.workflow_runner.v2')
    ),
    ADD CONSTRAINT workflow_runner_process_sessions_capabilities_check CHECK (
        capabilities = ARRAY['cancel_ack','effect_receipts','lease_heartbeat']::TEXT[]
    );

ALTER TABLE workflow_runner_worker_events DROP CONSTRAINT workflow_runner_worker_events_kind_check;
ALTER TABLE workflow_runner_worker_events ADD CONSTRAINT workflow_runner_worker_events_kind_check CHECK (kind IN (
    'lease_accept','lease_reject','heartbeat','effect_intent','effect_outcome','cancel_ack','terminal',
    'checkpoint_commit','budget_reserve_request','budget_usage_report'
));

ALTER TABLE workflow_runner_control_messages DROP CONSTRAINT workflow_runner_control_messages_kind_check;
ALTER TABLE workflow_runner_control_messages DROP CONSTRAINT workflow_runner_control_messages_delivery_state_check;
ALTER TABLE workflow_runner_control_messages
    ADD COLUMN delivery_started_at TIMESTAMPTZ;
UPDATE workflow_runner_control_messages SET delivery_started_at=delivered_at WHERE delivery_state='delivered';
ALTER TABLE workflow_runner_control_messages
    ADD CONSTRAINT workflow_runner_control_messages_kind_check CHECK (kind IN (
        'hello_ack','lease_offer','cancel_request','event_receipt',
        'budget_authorization','effect_authorization','resume_offer'
    )),
    ADD CONSTRAINT workflow_runner_control_messages_delivery_state_check CHECK (
        delivery_state IN ('pending','delivering','delivered','abandoned','reconciliation_required')
    ),
    ADD CONSTRAINT workflow_runner_control_messages_delivery_phase_check CHECK (
        (delivery_state='pending' AND delivery_started_at IS NULL AND delivered_at IS NULL)
        OR (delivery_state IN ('delivering','reconciliation_required') AND delivery_started_at IS NOT NULL AND delivered_at IS NULL)
        OR (delivery_state='delivered' AND delivered_at IS NOT NULL)
        OR (delivery_state='abandoned' AND delivered_at IS NULL)
    );

CREATE TABLE workflow_runner_v2_attempt_bindings (
    attempt_id TEXT PRIMARY KEY REFERENCES workflow_runner_attempts(attempt_id),
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    authority_backend TEXT NOT NULL CHECK (authority_backend IN ('ts-local','go')),
    workflow_authority TEXT NOT NULL CHECK (workflow_authority IN ('typescript','workflow-control')),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash)=32),
    initial_run_revision BIGINT NOT NULL CHECK (initial_run_revision BETWEEN 1 AND 9007199254740991),
    initial_resume_generation BIGINT NOT NULL CHECK (initial_resume_generation BETWEEN 0 AND 9007199254740991),
    current_run_revision BIGINT NOT NULL CHECK (current_run_revision BETWEEN 1 AND 9007199254740991),
    current_resume_generation BIGINT NOT NULL CHECK (current_resume_generation BETWEEN 0 AND 9007199254740991),
    last_authority_operation TEXT CHECK (last_authority_operation IS NULL OR last_authority_operation IN (
        'checkpoint_commit','effect_authorize','budget_reserve','budget_settle','resume_advance'
    )),
    last_authority_event_id TEXT,
    required_capabilities TEXT[] NOT NULL CHECK (required_capabilities=ARRAY['cancel_ack','effect_receipts','lease_heartbeat']::TEXT[]),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(workspace_id,job_id,attempt_id),
    FOREIGN KEY(workspace_id,job_id) REFERENCES workflow_runner_jobs(workspace_id,job_id),
    CHECK ((authority_backend='ts-local' AND workflow_authority='typescript')
        OR (authority_backend='go' AND workflow_authority='workflow-control')),
    CHECK ((last_authority_operation IS NULL AND last_authority_event_id IS NULL)
        OR (last_authority_operation IS NOT NULL AND last_authority_event_id IS NOT NULL))
);

CREATE OR REPLACE FUNCTION workflow_runner_v2_attempt_binding_transition()
RETURNS trigger AS $$
BEGIN
    IF OLD.attempt_id <> NEW.attempt_id OR OLD.workspace_id <> NEW.workspace_id OR OLD.job_id <> NEW.job_id
       OR OLD.authority_backend <> NEW.authority_backend OR OLD.workflow_authority <> NEW.workflow_authority
       OR OLD.routing_epoch <> NEW.routing_epoch OR OLD.authority_build_hash <> NEW.authority_build_hash
       OR OLD.initial_run_revision <> NEW.initial_run_revision
       OR OLD.initial_resume_generation <> NEW.initial_resume_generation
       OR OLD.required_capabilities <> NEW.required_capabilities OR OLD.created_at <> NEW.created_at
       OR NEW.last_authority_operation IS NULL OR NEW.last_authority_event_id IS NULL
       OR NEW.last_authority_event_id IS NOT DISTINCT FROM OLD.last_authority_event_id
       OR NOT (
          (NEW.last_authority_operation IN ('checkpoint_commit','effect_authorize')
             AND NEW.current_run_revision=OLD.current_run_revision
             AND NEW.current_resume_generation=OLD.current_resume_generation)
          OR (NEW.last_authority_operation IN ('budget_reserve','budget_settle')
             AND NEW.current_run_revision=OLD.current_run_revision+1
             AND NEW.current_resume_generation=OLD.current_resume_generation)
          OR (NEW.last_authority_operation='resume_advance'
             AND NEW.current_run_revision=OLD.current_run_revision+1
             AND NEW.current_resume_generation=OLD.current_resume_generation+1)
       ) THEN
        RAISE EXCEPTION 'workflow runner v2 attempt binding transition is invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE workflow_runner_v2_event_inbox (
    event_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES workflow_runner_attempts(attempt_id),
    lease_id TEXT NOT NULL REFERENCES workflow_runner_leases(lease_id),
    fencing_token BIGINT NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
    worker_sequence BIGINT NOT NULL CHECK (worker_sequence BETWEEN 1 AND 9007199254740991),
    kind TEXT NOT NULL CHECK (kind IN ('lease_accept','effect_intent','checkpoint_commit','budget_reserve_request','budget_usage_report')),
    run_revision BIGINT NOT NULL CHECK (run_revision BETWEEN 1 AND 9007199254740991),
    resume_generation BIGINT NOT NULL CHECK (resume_generation BETWEEN 0 AND 9007199254740991),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint)=32),
    message_digest BYTEA NOT NULL CHECK (octet_length(message_digest)=32),
    exact_event_bytes BYTEA NOT NULL CHECK (octet_length(exact_event_bytes) BETWEEN 1 AND 262144),
    state TEXT NOT NULL CHECK (state IN ('pending_authority','authority_committed','runner_committed','reconciliation_required')),
    authority_operation TEXT,
    authority_receipt_hash BYTEA CHECK (authority_receipt_hash IS NULL OR octet_length(authority_receipt_hash)=32),
    exact_authority_receipt_bytes BYTEA CHECK (exact_authority_receipt_bytes IS NULL OR octet_length(exact_authority_receipt_bytes) BETWEEN 1 AND 1048576),
    reconciliation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(attempt_id,worker_sequence),
    CHECK ((state='pending_authority' AND authority_receipt_hash IS NULL AND exact_authority_receipt_bytes IS NULL AND reconciliation_id IS NULL)
        OR (state IN ('authority_committed','runner_committed') AND authority_receipt_hash IS NOT NULL AND exact_authority_receipt_bytes IS NOT NULL AND reconciliation_id IS NULL)
        OR (state='reconciliation_required' AND reconciliation_id IS NOT NULL))
);

CREATE TABLE workflow_runner_v2_decision_bindings (
    received_event_id TEXT PRIMARY KEY REFERENCES workflow_runner_worker_events(event_id),
    receipt_control_event_id TEXT NOT NULL UNIQUE REFERENCES workflow_runner_event_receipts(receipt_event_id),
    decision_control_event_id TEXT UNIQUE REFERENCES workflow_runner_control_messages(control_event_id),
    authority_receipt_hash BYTEA CHECK (authority_receipt_hash IS NULL OR octet_length(authority_receipt_hash)=32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (decision_control_event_id IS NULL OR authority_receipt_hash IS NOT NULL)
);

CREATE TABLE workflow_runner_v2_cancel_bindings (
    cancel_id TEXT PRIMARY KEY REFERENCES workflow_runner_cancel_controls(cancel_id),
    control_event_id TEXT NOT NULL UNIQUE REFERENCES workflow_runner_control_messages(control_event_id),
    attempt_id TEXT NOT NULL REFERENCES workflow_runner_attempts(attempt_id),
    authority_backend TEXT NOT NULL,
    workflow_authority TEXT NOT NULL,
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash)=32),
    run_revision BIGINT NOT NULL CHECK (run_revision BETWEEN 1 AND 9007199254740991),
    resume_generation BIGINT NOT NULL CHECK (resume_generation BETWEEN 0 AND 9007199254740991),
    exact_v1_message_hash BYTEA NOT NULL CHECK (octet_length(exact_v1_message_hash)=32),
    v2_message_digest BYTEA NOT NULL CHECK (octet_length(v2_message_digest)=32),
    exact_v2_message_bytes BYTEA NOT NULL CHECK (octet_length(exact_v2_message_bytes) BETWEEN 1 AND 262144),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((authority_backend='ts-local' AND workflow_authority='typescript')
        OR (authority_backend='go' AND workflow_authority='workflow-control'))
);

CREATE TRIGGER workflow_runner_v2_attempt_bindings_transition
BEFORE UPDATE ON workflow_runner_v2_attempt_bindings
FOR EACH ROW EXECUTE FUNCTION workflow_runner_v2_attempt_binding_transition();
CREATE TRIGGER workflow_runner_v2_attempt_bindings_no_delete
BEFORE DELETE ON workflow_runner_v2_attempt_bindings
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_runner_v2_decision_bindings_immutable
BEFORE UPDATE OR DELETE ON workflow_runner_v2_decision_bindings
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_runner_v2_cancel_bindings_immutable
BEFORE UPDATE OR DELETE ON workflow_runner_v2_cancel_bindings
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();

CREATE INDEX workflow_runner_v2_inbox_state_idx ON workflow_runner_v2_event_inbox(state,created_at,event_id);
CREATE INDEX workflow_runner_jobs_protocol_dispatch_idx ON workflow_runner_jobs(required_protocol_version,state,dispatch_not_before,created_at,workspace_id,job_id);

COMMIT;
