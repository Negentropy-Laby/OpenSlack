-- GS8-B default-off Workflow Runner control namespace.
-- Go owns only job/attempt/lease/fence/cancel/protocol receipt records.
-- TypeScript remains the Workflow/RunStore/checkpoint/resume/approval/budget authority.
BEGIN;

CREATE OR REPLACE FUNCTION workflow_runner_reject_immutable_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is immutable and does not allow UPDATE or DELETE', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE workflow_runner_jobs (
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    workflow_run_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    execution_descriptor_ref TEXT NOT NULL,
    execution_descriptor_hash BYTEA NOT NULL CHECK (octet_length(execution_descriptor_hash) = 32),
    job_spec_hash BYTEA NOT NULL CHECK (octet_length(job_spec_hash) = 32),
    exact_spec_bytes BYTEA NOT NULL CHECK (octet_length(exact_spec_bytes) BETWEEN 1 AND 65536),
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    workflow_source_hash BYTEA NOT NULL CHECK (octet_length(workflow_source_hash) = 32),
    manifest_hash BYTEA NOT NULL CHECK (octet_length(manifest_hash) = 32),
    input_hash BYTEA NOT NULL CHECK (octet_length(input_hash) = 32),
    whole_deadline TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'queued', 'offered', 'running', 'cancelling', 'terminal', 'reconciliation_required'
    )),
    revision BIGINT NOT NULL CHECK (revision >= 1),
    current_fence BIGINT NOT NULL DEFAULT 0 CHECK (current_fence BETWEEN 0 AND 9007199254740991),
    current_attempt_id TEXT,
	dispatch_failures BIGINT NOT NULL DEFAULT 0 CHECK (dispatch_failures BETWEEN 0 AND 5),
	dispatch_not_before TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
	dispatch_state TEXT NOT NULL DEFAULT 'ready' CHECK (dispatch_state IN ('ready', 'backoff', 'dead')),
	last_dispatch_error TEXT CHECK (last_dispatch_error IS NULL OR last_dispatch_error IN (
		'launch_failed', 'lease_rejected', 'process_crash', 'termination_uncertain'
	)),
    terminal_status TEXT CHECK (terminal_status IS NULL OR terminal_status IN (
        'completed', 'failed', 'cancelled', 'timed_out', 'reconciliation_required'
    )),
    terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN (
        'workflow_failed', 'process_crash', 'cancelled_by_control', 'timeout', 'commit_outcome_unknown'
    )),
    result_hash BYTEA CHECK (result_hash IS NULL OR octet_length(result_hash) = 32),
    reconciliation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, job_id),
    UNIQUE (workspace_id, workflow_run_id, job_id),
    CHECK (whole_deadline > created_at),
    CHECK (
        (state = 'terminal' AND terminal_status IS NOT NULL AND reconciliation_id IS NULL)
        OR (state = 'reconciliation_required' AND terminal_status = 'reconciliation_required'
            AND terminal_reason = 'commit_outcome_unknown' AND reconciliation_id IS NOT NULL)
        OR (state NOT IN ('terminal', 'reconciliation_required')
            AND terminal_status IS NULL AND terminal_reason IS NULL
            AND result_hash IS NULL AND reconciliation_id IS NULL)
    ),
    CHECK (
        (terminal_status = 'completed' AND terminal_reason IS NULL AND result_hash IS NOT NULL)
        OR (terminal_status IS DISTINCT FROM 'completed' AND result_hash IS NULL)
    )
);

CREATE TABLE workflow_runner_job_receipts (
    receipt_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('submit_job', 'request_cancel')),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'reconciliation_required')),
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    job_spec_hash BYTEA NOT NULL CHECK (octet_length(job_spec_hash) = 32),
    exact_receipt_bytes BYTEA NOT NULL CHECK (octet_length(exact_receipt_bytes) BETWEEN 1 AND 65536),
    reconciliation_id TEXT,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (workspace_id, job_id) REFERENCES workflow_runner_jobs (workspace_id, job_id),
    CHECK ((status = 'accepted' AND reconciliation_id IS NULL)
        OR (status = 'reconciliation_required' AND reconciliation_id IS NOT NULL))
);

CREATE TABLE workflow_runner_attempts (
    attempt_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    ordinal BIGINT NOT NULL CHECK (ordinal >= 1),
    supervisor_instance_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'offered', 'accepted', 'running', 'cancelling', 'terminal',
        'rejected', 'expired', 'crashed', 'reconciliation_required'
    )),
    fencing_token BIGINT NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
    worker_sequence BIGINT NOT NULL DEFAULT 0 CHECK (worker_sequence BETWEEN 0 AND 9007199254740991),
    control_sequence BIGINT NOT NULL DEFAULT 0 CHECK (control_sequence BETWEEN 0 AND 9007199254740991),
    execution_started BOOLEAN NOT NULL DEFAULT FALSE,
    open_effect_count BIGINT NOT NULL DEFAULT 0 CHECK (open_effect_count >= 0),
    process_exit_class TEXT CHECK (process_exit_class IS NULL OR process_exit_class IN ('clean', 'crashed', 'forced')),
    offered_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, job_id, ordinal),
    UNIQUE (workspace_id, job_id, fencing_token),
    FOREIGN KEY (workspace_id, job_id) REFERENCES workflow_runner_jobs (workspace_id, job_id),
    CHECK (accepted_at IS NULL OR accepted_at >= offered_at),
    CHECK (started_at IS NULL OR accepted_at IS NOT NULL),
    CHECK (finished_at IS NULL OR finished_at >= offered_at)
);

ALTER TABLE workflow_runner_jobs
    ADD CONSTRAINT workflow_runner_jobs_current_attempt_fk
    FOREIGN KEY (current_attempt_id) REFERENCES workflow_runner_attempts (attempt_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX workflow_runner_one_active_attempt_idx
    ON workflow_runner_attempts (workspace_id, job_id)
    WHERE state IN ('offered', 'accepted', 'running', 'cancelling');

CREATE TABLE workflow_runner_leases (
    lease_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES workflow_runner_attempts (attempt_id),
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    fencing_token BIGINT NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
    state TEXT NOT NULL CHECK (state IN ('offered', 'active', 'cancelling', 'expired', 'released', 'superseded')),
    offer_expires_at TIMESTAMPTZ NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    last_heartbeat_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, job_id, fencing_token),
    CHECK (offer_expires_at > created_at),
    CHECK (lease_expires_at >= offer_expires_at)
);

CREATE UNIQUE INDEX workflow_runner_one_active_lease_idx
    ON workflow_runner_leases (workspace_id, job_id)
    WHERE state IN ('offered', 'active', 'cancelling');

CREATE TABLE workflow_runner_process_sessions (
    process_session_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE REFERENCES workflow_runner_attempts (attempt_id),
    runner_build_hash BYTEA NOT NULL CHECK (octet_length(runner_build_hash) = 32),
    control_build_hash BYTEA NOT NULL CHECK (octet_length(control_build_hash) = 32),
    runtime_name TEXT NOT NULL CHECK (runtime_name = 'node'),
    runtime_version TEXT NOT NULL,
    protocol_version TEXT NOT NULL CHECK (protocol_version = 'openslack.workflow_runner.v1'),
    capabilities TEXT[] NOT NULL,
    negotiated_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    CHECK (capabilities = ARRAY['cancel_ack', 'effect_receipts', 'lease_heartbeat']::TEXT[])
);

CREATE TABLE workflow_runner_worker_events (
    event_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES workflow_runner_attempts (attempt_id),
    lease_id TEXT NOT NULL REFERENCES workflow_runner_leases (lease_id),
    fencing_token BIGINT NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
    sequence BIGINT NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
    kind TEXT NOT NULL CHECK (kind IN (
        'lease_accept', 'lease_reject', 'heartbeat', 'effect_intent',
        'effect_outcome', 'cancel_ack', 'terminal'
    )),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    message_digest BYTEA NOT NULL CHECK (octet_length(message_digest) = 32),
    exact_event_bytes BYTEA NOT NULL CHECK (octet_length(exact_event_bytes) BETWEEN 1 AND 262144),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (attempt_id, sequence),
    UNIQUE (attempt_id, event_id)
);

CREATE TABLE workflow_runner_control_messages (
    control_event_id TEXT PRIMARY KEY,
    attempt_id TEXT REFERENCES workflow_runner_attempts (attempt_id),
    kind TEXT NOT NULL CHECK (kind IN ('hello_ack', 'lease_offer', 'cancel_request', 'event_receipt')),
    sequence BIGINT CHECK (sequence IS NULL OR sequence BETWEEN 1 AND 9007199254740991),
    exact_message_bytes BYTEA NOT NULL CHECK (octet_length(exact_message_bytes) BETWEEN 1 AND 262144),
    message_digest BYTEA NOT NULL CHECK (octet_length(message_digest) = 32),
    delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'delivered', 'abandoned')),
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (attempt_id, sequence),
    CHECK ((delivery_state = 'delivered' AND delivered_at IS NOT NULL)
        OR (delivery_state <> 'delivered' AND delivered_at IS NULL))
);

CREATE TABLE workflow_runner_event_receipts (
    receipt_event_id TEXT PRIMARY KEY REFERENCES workflow_runner_control_messages (control_event_id),
    received_event_id TEXT NOT NULL UNIQUE REFERENCES workflow_runner_worker_events (event_id),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'reconciliation_required')),
    exact_receipt_bytes BYTEA NOT NULL CHECK (octet_length(exact_receipt_bytes) BETWEEN 1 AND 262144),
    receipt_digest BYTEA NOT NULL CHECK (octet_length(receipt_digest) = 32),
    reconciliation_id TEXT,
    committed_at TIMESTAMPTZ NOT NULL,
    CHECK ((status = 'accepted' AND reconciliation_id IS NULL)
        OR (status = 'reconciliation_required' AND reconciliation_id IS NOT NULL))
);

CREATE TABLE workflow_runner_cancel_controls (
    cancel_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES workflow_runner_attempts (attempt_id),
    lease_id TEXT NOT NULL REFERENCES workflow_runner_leases (lease_id),
    fencing_token BIGINT NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
    reason TEXT NOT NULL CHECK (reason IN ('operator', 'lease_expired', 'shutdown', 'superseded', 'timeout')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'acknowledged', 'expired')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    control_event_id TEXT NOT NULL UNIQUE REFERENCES workflow_runner_control_messages (control_event_id),
    ack_event_id TEXT UNIQUE REFERENCES workflow_runner_worker_events (event_id) DEFERRABLE INITIALLY DEFERRED,
    requested_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    acknowledged_at TIMESTAMPTZ,
    CHECK (expires_at > requested_at),
    CHECK ((state = 'acknowledged' AND ack_event_id IS NOT NULL AND acknowledged_at IS NOT NULL)
        OR (state <> 'acknowledged' AND ack_event_id IS NULL AND acknowledged_at IS NULL))
);

CREATE TABLE workflow_runner_effect_boundaries (
    attempt_id TEXT NOT NULL REFERENCES workflow_runner_attempts (attempt_id),
    effect_id TEXT NOT NULL,
    intent_event_id TEXT NOT NULL UNIQUE REFERENCES workflow_runner_worker_events (event_id),
    intent_hash BYTEA NOT NULL CHECK (octet_length(intent_hash) = 32),
    outcome_event_id TEXT UNIQUE REFERENCES workflow_runner_worker_events (event_id),
    outcome_hash BYTEA CHECK (outcome_hash IS NULL OR octet_length(outcome_hash) = 32),
    outcome_status TEXT CHECK (outcome_status IS NULL OR outcome_status IN (
        'executed', 'rejected', 'failed', 'reconciliation_required'
    )),
    opened_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    PRIMARY KEY (attempt_id, effect_id),
    CHECK ((outcome_event_id IS NULL AND outcome_hash IS NULL AND outcome_status IS NULL AND closed_at IS NULL)
        OR (outcome_event_id IS NOT NULL AND outcome_hash IS NOT NULL AND outcome_status IS NOT NULL AND closed_at IS NOT NULL))
);

CREATE TABLE workflow_runner_reconciliations (
    reconciliation_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    attempt_id TEXT REFERENCES workflow_runner_attempts (attempt_id),
    code TEXT NOT NULL CHECK (code IN (
        'WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN', 'WORKFLOW_RUNNER_RECONCILIATION_REQUIRED'
    )),
    evidence_hash BYTEA NOT NULL CHECK (octet_length(evidence_hash) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (workspace_id, job_id) REFERENCES workflow_runner_jobs (workspace_id, job_id)
);

CREATE INDEX workflow_runner_jobs_dispatch_idx ON workflow_runner_jobs (state, dispatch_not_before, created_at, workspace_id, job_id);
CREATE INDEX workflow_runner_attempts_recovery_idx ON workflow_runner_attempts (state, updated_at);
CREATE INDEX workflow_runner_leases_expiry_idx ON workflow_runner_leases (state, lease_expires_at);
CREATE INDEX workflow_runner_controls_pending_idx ON workflow_runner_cancel_controls (state, expires_at);
CREATE INDEX workflow_runner_reconciliations_job_idx ON workflow_runner_reconciliations (workspace_id, job_id, created_at);

CREATE TRIGGER workflow_runner_job_receipts_immutable
BEFORE UPDATE OR DELETE ON workflow_runner_job_receipts
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_runner_worker_events_immutable
BEFORE UPDATE OR DELETE ON workflow_runner_worker_events
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_runner_event_receipts_immutable
BEFORE UPDATE OR DELETE ON workflow_runner_event_receipts
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_runner_effect_boundaries_no_delete
BEFORE DELETE ON workflow_runner_effect_boundaries
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_runner_reconciliations_immutable
BEFORE UPDATE OR DELETE ON workflow_runner_reconciliations
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();

COMMIT;
