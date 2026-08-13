BEGIN;
-- GS9-D observes the exact three-step TypeScript-owned effect approval/audit
-- lifecycle. These tables are independent from every authority and runner
-- namespace and confer no effect decision or execution authority.
CREATE TABLE workflow_control_effect_shadow_heads (
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    occurrence_id text NOT NULL,
    approval_id text NOT NULL,
    last_source_sequence bigint NOT NULL CHECK (last_source_sequence BETWEEN 1 AND 3),
    last_operation text NOT NULL CHECK (last_operation IN ('approval_created','approval_decided','audit_recorded')),
    last_observation_hash bytea NOT NULL CHECK (octet_length(last_observation_hash) = 32),
    matched_source_sequence bigint CHECK (matched_source_sequence BETWEEN 1 AND 3 AND matched_source_sequence <= last_source_sequence),
    matched_operation text CHECK (matched_operation IN ('approval_created','approval_decided','audit_recorded')),
    matched_observation_hash bytea,
    exact_matched_observation_bytes bytea,
    mismatch_latched boolean NOT NULL,
    mismatch_code text,
    service_build_hash bytea NOT NULL CHECK (octet_length(service_build_hash) = 32),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (workspace_id, run_id, occurrence_id, approval_id),
    CHECK ((matched_source_sequence IS NULL) = (matched_operation IS NULL)),
    CHECK ((matched_operation IS NULL) = (matched_observation_hash IS NULL)),
    CHECK ((matched_observation_hash IS NULL) = (exact_matched_observation_bytes IS NULL)),
    CHECK (matched_source_sequence IS NOT NULL OR mismatch_latched),
    CHECK (matched_observation_hash IS NULL OR octet_length(matched_observation_hash) = 32),
    CHECK (exact_matched_observation_bytes IS NULL OR octet_length(exact_matched_observation_bytes) BETWEEN 1 AND 262144),
    CHECK ((mismatch_latched AND mismatch_code IS NOT NULL) OR (NOT mismatch_latched AND mismatch_code IS NULL))
);

CREATE TABLE workflow_control_effect_shadow_observations (
    observation_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    occurrence_id text NOT NULL,
    approval_id text NOT NULL,
    source_sequence bigint NOT NULL CHECK (source_sequence BETWEEN 1 AND 3),
    operation text NOT NULL CHECK (operation IN ('approval_created','approval_decided','audit_recorded')),
    parity text NOT NULL CHECK (parity IN ('matched','mismatched')),
    mismatch_code text,
    envelope_hash bytea NOT NULL CHECK (octet_length(envelope_hash) = 32),
    exact_envelope_bytes bytea NOT NULL CHECK (octet_length(exact_envelope_bytes) BETWEEN 2 AND 524288),
    observation_hash bytea NOT NULL CHECK (octet_length(observation_hash) = 32),
    exact_observation_bytes bytea NOT NULL CHECK (octet_length(exact_observation_bytes) BETWEEN 1 AND 262144),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id, run_id, occurrence_id, approval_id, source_sequence),
    CHECK ((parity='matched' AND mismatch_code IS NULL) OR (parity='mismatched' AND mismatch_code IS NOT NULL))
);

CREATE TABLE workflow_control_effect_shadow_receipts (
    receipt_id text PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    occurrence_id text NOT NULL,
    approval_id text NOT NULL,
    source_sequence bigint NOT NULL CHECK (source_sequence BETWEEN 1 AND 3),
    operation text NOT NULL CHECK (operation IN ('approval_created','approval_decided','audit_recorded')),
    status text NOT NULL CHECK (status IN ('accepted','reconciliation_required')),
    parity text NOT NULL CHECK (parity IN ('matched','mismatched','unknown')),
    mismatch_code text,
    observation_id text REFERENCES workflow_control_effect_shadow_observations(observation_id),
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

-- Read-only qualification outbox. It records only matched terminal decision
-- and audit observations; it has no publisher, acknowledgement, retry or
-- effect-authorization surface.
CREATE TABLE workflow_control_effect_shadow_outbox (
    event_id text PRIMARY KEY,
    event_type text NOT NULL CHECK (event_type IN ('effect_decision_observed','effect_audit_recorded')),
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    occurrence_id text NOT NULL,
    approval_id text NOT NULL,
    source_sequence bigint NOT NULL CHECK (source_sequence BETWEEN 2 AND 3),
    operation text NOT NULL CHECK (operation IN ('approval_decided','audit_recorded')),
    observation_id text NOT NULL UNIQUE REFERENCES workflow_control_effect_shadow_observations(observation_id),
    observation_hash bytea NOT NULL CHECK (octet_length(observation_hash) = 32),
    payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
    canonical_payload_bytes bytea NOT NULL CHECK (octet_length(canonical_payload_bytes) BETWEEN 1 AND 65536),
    status text NOT NULL DEFAULT 'pending' CHECK (status='pending'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (workspace_id,run_id,occurrence_id,approval_id,source_sequence),
    CHECK ((source_sequence=2 AND operation='approval_decided' AND event_type='effect_decision_observed') OR
           (source_sequence=3 AND operation='audit_recorded' AND event_type='effect_audit_recorded'))
);

CREATE TABLE workflow_control_effect_shadow_reconciliations (
    reconciliation_token text PRIMARY KEY,
    receipt_id text NOT NULL UNIQUE REFERENCES workflow_control_effect_shadow_receipts(receipt_id),
    idempotency_key text NOT NULL UNIQUE,
    request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    workspace_id text NOT NULL,
    run_id text NOT NULL,
    occurrence_id text NOT NULL,
    approval_id text NOT NULL,
    source_sequence bigint NOT NULL CHECK (source_sequence BETWEEN 1 AND 3),
    observation_hash bytea NOT NULL CHECK (octet_length(observation_hash) = 32),
    commit_error_hash bytea NOT NULL CHECK (octet_length(commit_error_hash) = 32),
    status text NOT NULL DEFAULT 'open' CHECK (status='open'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX workflow_control_effect_shadow_observations_scope_idx
  ON workflow_control_effect_shadow_observations (workspace_id,run_id,occurrence_id,approval_id,source_sequence);
CREATE INDEX workflow_control_effect_shadow_receipts_scope_idx
  ON workflow_control_effect_shadow_receipts (workspace_id,run_id,occurrence_id,approval_id,source_sequence);
CREATE INDEX workflow_control_effect_shadow_outbox_pending_idx
  ON workflow_control_effect_shadow_outbox (workspace_id,status,recorded_at,event_id);
CREATE INDEX workflow_control_effect_shadow_reconciliations_scope_idx
  ON workflow_control_effect_shadow_reconciliations (workspace_id,run_id,occurrence_id,approval_id,source_sequence);

CREATE FUNCTION workflow_control_effect_shadow_head_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.run_id<>OLD.run_id OR
     NEW.occurrence_id<>OLD.occurrence_id OR NEW.approval_id<>OLD.approval_id OR
     NEW.last_source_sequence<>OLD.last_source_sequence+1 OR
     (OLD.mismatch_latched AND NOT NEW.mismatch_latched) THEN
    RAISE EXCEPTION 'invalid effect shadow head transition';
  END IF;
  IF NEW.matched_source_sequence IS NOT DISTINCT FROM OLD.matched_source_sequence THEN
    IF NEW.matched_operation IS DISTINCT FROM OLD.matched_operation OR
       NEW.matched_observation_hash IS DISTINCT FROM OLD.matched_observation_hash OR
       NEW.exact_matched_observation_bytes IS DISTINCT FROM OLD.exact_matched_observation_bytes THEN
      RAISE EXCEPTION 'unmatched transition changed effect shadow matched prefix';
    END IF;
  ELSIF NEW.matched_source_sequence IS DISTINCT FROM NEW.last_source_sequence OR OLD.mismatch_latched THEN
    RAISE EXCEPTION 'invalid matched effect shadow transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_control_effect_shadow_head_transition
BEFORE UPDATE ON workflow_control_effect_shadow_heads
FOR EACH ROW EXECUTE FUNCTION workflow_control_effect_shadow_head_transition();

CREATE FUNCTION workflow_control_effect_shadow_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME; END;
$$;
CREATE TRIGGER workflow_control_effect_shadow_observations_immutable BEFORE UPDATE OR DELETE ON workflow_control_effect_shadow_observations FOR EACH ROW EXECUTE FUNCTION workflow_control_effect_shadow_immutable();
CREATE TRIGGER workflow_control_effect_shadow_receipts_immutable BEFORE UPDATE OR DELETE ON workflow_control_effect_shadow_receipts FOR EACH ROW EXECUTE FUNCTION workflow_control_effect_shadow_immutable();
CREATE TRIGGER workflow_control_effect_shadow_outbox_immutable BEFORE UPDATE OR DELETE ON workflow_control_effect_shadow_outbox FOR EACH ROW EXECUTE FUNCTION workflow_control_effect_shadow_immutable();
CREATE TRIGGER workflow_control_effect_shadow_reconciliations_immutable BEFORE UPDATE OR DELETE ON workflow_control_effect_shadow_reconciliations FOR EACH ROW EXECUTE FUNCTION workflow_control_effect_shadow_immutable();
COMMIT;
