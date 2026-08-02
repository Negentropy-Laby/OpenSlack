-- GS5 Governance Control PostgreSQL shadow namespace.
-- TypeScript remains the sole governed-plan writer and execution authority.
BEGIN;

CREATE OR REPLACE FUNCTION governance_shadow_reject_immutable_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is immutable and does not allow UPDATE or DELETE', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE governance_shadow_heads (
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 1),
    matched_record_revision BIGINT CHECK (matched_record_revision >= 1),
    matched_record_hash BYTEA CHECK (matched_record_hash IS NULL OR octet_length(matched_record_hash) = 32),
    matched_state TEXT CHECK (matched_state IS NULL OR matched_state IN (
        'pending', 'executing', 'succeeded', 'blocked', 'failed',
        'reconciliation_required', 'cancelled', 'expired'
    )),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, plan_id),
    CHECK ((matched_record_revision IS NULL) = (matched_record_hash IS NULL)),
    CHECK ((matched_record_revision IS NULL) = (matched_state IS NULL))
);

CREATE TABLE governance_shadow_observations (
    observation_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('record', 'confirmation', 'audit')),
    parity TEXT NOT NULL CHECK (parity IN ('matched', 'mismatched')),
    mismatch_code TEXT,
    record_revision BIGINT CHECK (record_revision IS NULL OR record_revision >= 1),
    record_hash BYTEA CHECK (record_hash IS NULL OR octet_length(record_hash) = 32),
    canonical_bytes BYTEA NOT NULL CHECK (octet_length(canonical_bytes) > 0),
    body_digest BYTEA NOT NULL CHECK (octet_length(body_digest) = 32),
    projection_bytes BYTEA,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, plan_id, source_sequence),
    CHECK ((parity = 'matched' AND mismatch_code IS NULL) OR
           (parity = 'mismatched' AND mismatch_code IS NOT NULL))
);

CREATE TABLE governance_shadow_record_versions (
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    observation_id TEXT NOT NULL UNIQUE REFERENCES governance_shadow_observations (observation_id),
    state TEXT NOT NULL CHECK (state IN (
        'pending', 'executing', 'succeeded', 'blocked', 'failed',
        'reconciliation_required', 'cancelled', 'expired'
    )),
    record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
    canonical_record_bytes BYTEA NOT NULL CHECK (octet_length(canonical_record_bytes) > 0),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, plan_id, revision)
);

CREATE TABLE governance_shadow_receipts (
    receipt_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation = 'observation_ingest'),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'reconciliation_required')),
    parity TEXT NOT NULL CHECK (parity IN ('matched', 'mismatched', 'unknown')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    workspace_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    source_sequence BIGINT NOT NULL CHECK (source_sequence >= 1),
    observation_kind TEXT NOT NULL CHECK (observation_kind IN ('record', 'confirmation', 'audit')),
    observation_digest BYTEA NOT NULL CHECK (octet_length(observation_digest) = 32),
    observation_id TEXT REFERENCES governance_shadow_observations (observation_id),
    mismatch_code TEXT,
    committed_at TIMESTAMPTZ,
    reconciliation_token TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (mismatch_code IS NULL OR (char_length(mismatch_code) BETWEEN 1 AND 256)),
    CHECK (
        (status = 'accepted' AND committed_at IS NOT NULL AND reconciliation_token IS NULL AND observation_id IS NOT NULL
            AND ((parity = 'matched' AND mismatch_code IS NULL)
                OR (parity = 'mismatched' AND mismatch_code IS NOT NULL)))
        OR
        (status = 'reconciliation_required' AND parity = 'unknown' AND mismatch_code IS NULL
            AND committed_at IS NULL AND observation_id IS NULL
            AND reconciliation_token IS NOT NULL AND char_length(reconciliation_token) > 0)
    )
);

CREATE INDEX governance_shadow_observations_plan_idx
    ON governance_shadow_observations (workspace_id, plan_id, source_sequence);
CREATE INDEX governance_shadow_observations_parity_idx
    ON governance_shadow_observations (parity, kind);
CREATE INDEX governance_shadow_receipts_status_idx
    ON governance_shadow_receipts (status);

CREATE TRIGGER governance_shadow_observations_immutable
BEFORE UPDATE OR DELETE ON governance_shadow_observations
FOR EACH ROW EXECUTE FUNCTION governance_shadow_reject_immutable_mutation();

CREATE TRIGGER governance_shadow_record_versions_immutable
BEFORE UPDATE OR DELETE ON governance_shadow_record_versions
FOR EACH ROW EXECUTE FUNCTION governance_shadow_reject_immutable_mutation();

CREATE TRIGGER governance_shadow_receipts_immutable
BEFORE UPDATE OR DELETE ON governance_shadow_receipts
FOR EACH ROW EXECUTE FUNCTION governance_shadow_reject_immutable_mutation();

COMMIT;
