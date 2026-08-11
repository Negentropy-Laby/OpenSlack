BEGIN;
-- GS9-C observes TypeScript-owned checkpoint commits. These tables are
-- intentionally independent from GS7 shadow, GS8 runner, and GS9-B authority.
CREATE TABLE workflow_control_checkpoint_shadow_heads (
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    source_sequence bigint NOT NULL CHECK (source_sequence BETWEEN 1 AND 9007199254740990),
    operation text NOT NULL CHECK (operation IN ('checkpoint_commit', 'resume_advance')),
    matched_source_sequence bigint CHECK (matched_source_sequence BETWEEN 1 AND 9007199254740990 AND matched_source_sequence <= source_sequence),
    mismatch_latched boolean NOT NULL,
    observation_hash bytea,
    exact_observation_bytes bytea,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, run_id),
    CHECK ((matched_source_sequence IS NULL) = (observation_hash IS NULL)),
    CHECK ((observation_hash IS NULL) = (exact_observation_bytes IS NULL)),
    CHECK (observation_hash IS NULL OR octet_length(observation_hash) = 32),
    CHECK (exact_observation_bytes IS NULL OR octet_length(exact_observation_bytes) BETWEEN 1 AND 524288)
);

CREATE TABLE workflow_control_checkpoint_shadow_observations (
    observation_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    source_sequence bigint NOT NULL CHECK (source_sequence BETWEEN 1 AND 9007199254740990),
    operation text NOT NULL CHECK (operation IN ('checkpoint_commit', 'resume_advance')),
    parity text NOT NULL CHECK (parity IN ('matched', 'mismatched')),
    mismatch_code text,
    envelope_hash bytea NOT NULL CHECK (octet_length(envelope_hash) = 32),
    exact_envelope_bytes bytea NOT NULL CHECK (octet_length(exact_envelope_bytes) BETWEEN 1 AND 524288),
    observation_hash bytea NOT NULL CHECK (octet_length(observation_hash) = 32),
    exact_observation_bytes bytea NOT NULL CHECK (octet_length(exact_observation_bytes) BETWEEN 1 AND 524288),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, run_id, source_sequence),
    CHECK ((parity = 'matched' AND mismatch_code IS NULL) OR (parity = 'mismatched' AND mismatch_code IS NOT NULL))
);

CREATE TABLE workflow_control_checkpoint_shadow_receipts (
    receipt_id text PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    source_sequence bigint NOT NULL CHECK (source_sequence BETWEEN 1 AND 9007199254740990),
    operation text NOT NULL CHECK (operation IN ('checkpoint_commit', 'resume_advance')),
    status text NOT NULL CHECK (status IN ('accepted', 'reconciliation_required')),
    parity text NOT NULL CHECK (parity IN ('matched', 'mismatched', 'unknown')),
    mismatch_code text,
    observation_id text REFERENCES workflow_control_checkpoint_shadow_observations(observation_id),
    envelope_hash bytea NOT NULL CHECK (octet_length(envelope_hash) = 32),
    observation_hash bytea NOT NULL CHECK (octet_length(observation_hash) = 32),
    service_build_hash bytea NOT NULL CHECK (octet_length(service_build_hash) = 32),
    reconciliation_token text,
    exact_receipt_bytes bytea NOT NULL CHECK (octet_length(exact_receipt_bytes) BETWEEN 1 AND 65536),
    committed_at timestamptz,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((status='accepted' AND parity IN ('matched','mismatched') AND observation_id IS NOT NULL AND committed_at IS NOT NULL AND reconciliation_token IS NULL AND ((parity='matched' AND mismatch_code IS NULL) OR (parity='mismatched' AND mismatch_code IS NOT NULL))) OR
           (status='reconciliation_required' AND parity='unknown' AND observation_id IS NULL AND committed_at IS NULL AND reconciliation_token IS NOT NULL AND mismatch_code IS NULL))
);

CREATE TABLE workflow_control_checkpoint_shadow_reconciliations (
    reconciliation_token text PRIMARY KEY,
    receipt_id text NOT NULL UNIQUE REFERENCES workflow_control_checkpoint_shadow_receipts(receipt_id),
    idempotency_key text NOT NULL UNIQUE,
    request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    source_sequence bigint NOT NULL CHECK (source_sequence BETWEEN 1 AND 9007199254740990),
    observation_hash bytea NOT NULL CHECK (octet_length(observation_hash) = 32),
    commit_error_hash bytea NOT NULL CHECK (octet_length(commit_error_hash) = 32),
    status text NOT NULL DEFAULT 'open' CHECK (status = 'open'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX workflow_control_checkpoint_shadow_observations_run_idx
    ON workflow_control_checkpoint_shadow_observations (workspace_id, run_id, source_sequence);
CREATE INDEX workflow_control_checkpoint_shadow_receipts_run_idx
    ON workflow_control_checkpoint_shadow_receipts (workspace_id, run_id, source_sequence);
CREATE INDEX workflow_control_checkpoint_shadow_reconciliations_run_idx
    ON workflow_control_checkpoint_shadow_reconciliations (workspace_id, run_id, source_sequence);

CREATE FUNCTION workflow_control_checkpoint_shadow_head_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.workspace_id <> OLD.workspace_id OR NEW.run_id <> OLD.run_id OR
       NEW.source_sequence <> OLD.source_sequence + 1 OR
       (OLD.mismatch_latched AND NOT NEW.mismatch_latched) THEN
        RAISE EXCEPTION 'invalid checkpoint shadow head transition';
    END IF;
    IF NEW.matched_source_sequence IS NOT DISTINCT FROM OLD.matched_source_sequence THEN
        IF NEW.observation_hash IS DISTINCT FROM OLD.observation_hash OR
           NEW.exact_observation_bytes IS DISTINCT FROM OLD.exact_observation_bytes THEN
            RAISE EXCEPTION 'unmatched transition changed checkpoint shadow head';
        END IF;
    ELSIF NEW.matched_source_sequence <> NEW.source_sequence OR OLD.mismatch_latched THEN
        RAISE EXCEPTION 'invalid matched checkpoint shadow transition';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_control_checkpoint_shadow_head_transition
BEFORE UPDATE ON workflow_control_checkpoint_shadow_heads
FOR EACH ROW EXECUTE FUNCTION workflow_control_checkpoint_shadow_head_transition();

CREATE FUNCTION workflow_control_checkpoint_shadow_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER workflow_control_checkpoint_shadow_observations_immutable
BEFORE UPDATE OR DELETE ON workflow_control_checkpoint_shadow_observations
FOR EACH ROW EXECUTE FUNCTION workflow_control_checkpoint_shadow_immutable();
CREATE TRIGGER workflow_control_checkpoint_shadow_receipts_immutable
BEFORE UPDATE OR DELETE ON workflow_control_checkpoint_shadow_receipts
FOR EACH ROW EXECUTE FUNCTION workflow_control_checkpoint_shadow_immutable();
CREATE TRIGGER workflow_control_checkpoint_shadow_reconciliations_immutable
BEFORE UPDATE OR DELETE ON workflow_control_checkpoint_shadow_reconciliations
FOR EACH ROW EXECUTE FUNCTION workflow_control_checkpoint_shadow_immutable();
COMMIT;
