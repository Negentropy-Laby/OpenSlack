-- GS7-B Workflow Control PostgreSQL shadow namespace.
-- TypeScript remains the sole workflow writer and execution authority.
BEGIN;

CREATE OR REPLACE FUNCTION workflow_control_shadow_reject_immutable_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is immutable and does not allow UPDATE or DELETE', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE workflow_control_shadow_heads (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 1),
    matched_source_sequence BIGINT CHECK (matched_source_sequence IS NULL OR matched_source_sequence >= 1),
    matched_observation_id TEXT,
    matched_observation_hash BYTEA CHECK (
        matched_observation_hash IS NULL OR octet_length(matched_observation_hash) = 32
    ),
    matched_status TEXT CHECK (matched_status IS NULL OR matched_status IN (
        'created', 'previewed', 'confirmed', 'running', 'paused',
        'paused_waiting_approval', 'resuming', 'completed', 'failed', 'cancelled'
    )),
    matched_envelope_bytes BYTEA,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, run_id),
    CHECK (matched_source_sequence IS NULL OR matched_source_sequence <= source_sequence),
    CHECK (
        (matched_source_sequence IS NULL AND matched_observation_id IS NULL
            AND matched_observation_hash IS NULL AND matched_status IS NULL
            AND matched_envelope_bytes IS NULL)
        OR
        (matched_source_sequence IS NOT NULL AND matched_observation_id IS NOT NULL
            AND matched_observation_hash IS NOT NULL AND matched_status IS NOT NULL
            AND matched_envelope_bytes IS NOT NULL AND octet_length(matched_envelope_bytes) > 0)
    )
);

CREATE TABLE workflow_control_shadow_observations (
    observation_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 1),
    parity TEXT NOT NULL CHECK (parity IN ('matched', 'mismatched')),
    mismatch_code TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'created', 'previewed', 'confirmed', 'running', 'paused',
        'paused_waiting_approval', 'resuming', 'completed', 'failed', 'cancelled'
    )),
    canonical_envelope_bytes BYTEA NOT NULL CHECK (octet_length(canonical_envelope_bytes) > 0),
    body_digest BYTEA NOT NULL CHECK (octet_length(body_digest) = 32),
    observation_hash BYTEA NOT NULL CHECK (octet_length(observation_hash) = 32),
    projection_bytes BYTEA NOT NULL CHECK (octet_length(projection_bytes) > 0),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, run_id, source_sequence),
    CHECK (mismatch_code IS NULL OR char_length(mismatch_code) BETWEEN 1 AND 256),
    CHECK ((parity = 'matched' AND mismatch_code IS NULL) OR
           (parity = 'mismatched' AND mismatch_code IS NOT NULL))
);

CREATE TABLE workflow_control_shadow_receipts (
    receipt_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation = 'observation_ingest'),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'reconciliation_required')),
    parity TEXT NOT NULL CHECK (parity IN ('matched', 'mismatched', 'unknown')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 1),
    observation_digest BYTEA NOT NULL CHECK (octet_length(observation_digest) = 32),
    observation_hash BYTEA CHECK (observation_hash IS NULL OR octet_length(observation_hash) = 32),
    observation_id TEXT REFERENCES workflow_control_shadow_observations (observation_id),
    mismatch_code TEXT,
    committed_at TIMESTAMPTZ,
    reconciliation_token TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (mismatch_code IS NULL OR char_length(mismatch_code) BETWEEN 1 AND 256),
    CHECK (
        (status = 'accepted' AND committed_at IS NOT NULL AND reconciliation_token IS NULL
            AND observation_id IS NOT NULL AND observation_hash IS NOT NULL
            AND ((parity = 'matched' AND mismatch_code IS NULL)
                OR (parity = 'mismatched' AND mismatch_code IS NOT NULL)))
        OR
        (status = 'reconciliation_required' AND parity = 'unknown' AND mismatch_code IS NULL
            AND committed_at IS NULL AND observation_id IS NULL AND observation_hash IS NULL
            AND reconciliation_token IS NOT NULL AND char_length(reconciliation_token) > 0)
    )
);

CREATE INDEX workflow_control_shadow_observations_run_idx
    ON workflow_control_shadow_observations (workspace_id, run_id, source_sequence);
CREATE INDEX workflow_control_shadow_observations_parity_idx
    ON workflow_control_shadow_observations (parity, status);
CREATE INDEX workflow_control_shadow_receipts_status_idx
    ON workflow_control_shadow_receipts (status);

CREATE TRIGGER workflow_control_shadow_observations_immutable
BEFORE UPDATE OR DELETE ON workflow_control_shadow_observations
FOR EACH ROW EXECUTE FUNCTION workflow_control_shadow_reject_immutable_mutation();

CREATE TRIGGER workflow_control_shadow_receipts_immutable
BEFORE UPDATE OR DELETE ON workflow_control_shadow_receipts
FOR EACH ROW EXECUTE FUNCTION workflow_control_shadow_reject_immutable_mutation();

COMMIT;
