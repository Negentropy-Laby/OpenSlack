-- Explicit, append-only recovery. No historical binding, event, receipt or ACK
-- is rewritten. These fences remain installed when rolling back application code.
BEGIN;

CREATE TABLE workflow_control_source_fences (
    binding_id TEXT PRIMARY KEY REFERENCES workflow_runner_authority_bindings(binding_id),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    stage_hash BYTEA NOT NULL CHECK (octet_length(stage_hash)=32),
    correlation_id TEXT NOT NULL,
    expected_resume_generation BIGINT NOT NULL CHECK (expected_resume_generation>=0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(workspace_id,run_id,correlation_id)
);

CREATE TABLE workflow_runner_binding_settlements (
    binding_id TEXT PRIMARY KEY REFERENCES workflow_runner_authority_bindings(binding_id),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    stage_hash BYTEA NOT NULL CHECK (octet_length(stage_hash)=32),
    outcome TEXT NOT NULL CHECK (outcome IN ('committed','not_committed')),
    proof_kind TEXT NOT NULL CHECK (proof_kind IN ('resolution','source_receipt','source_fence','budget_source_result')),
    exact_proof_bytes BYTEA NOT NULL CHECK (octet_length(exact_proof_bytes)>0),
    idempotency_key TEXT NOT NULL UNIQUE,
    exact_request_bytes BYTEA NOT NULL,
    request_hash BYTEA NOT NULL CHECK (request_hash=sha256(exact_request_bytes)),
    exact_receipt_bytes BYTEA NOT NULL,
    receipt_hash BYTEA NOT NULL CHECK (receipt_hash=sha256(exact_receipt_bytes)),
    caller_id TEXT NOT NULL,
    rules_version INTEGER NOT NULL CHECK (rules_version=1),
    committed_at TIMESTAMPTZ NOT NULL,
    CHECK ((outcome='not_committed')=(proof_kind='source_fence'))
);
CREATE INDEX workflow_runner_binding_settlements_run_idx
 ON workflow_runner_binding_settlements(workspace_id,run_id,binding_id);

CREATE TABLE workflow_control_recovery_pauses (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    expected_revision BIGINT NOT NULL,
    accepted_revision BIGINT NOT NULL CHECK (accepted_revision=expected_revision+1),
    resume_generation BIGINT NOT NULL,
    prior_record_hash BYTEA NOT NULL CHECK (octet_length(prior_record_hash)=32),
    exact_record_bytes BYTEA NOT NULL,
    record_hash BYTEA NOT NULL CHECK (record_hash=sha256(exact_record_bytes)),
    exact_receipt_bytes BYTEA NOT NULL,
    transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
    committed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(workspace_id,run_id,accepted_revision)
);

-- Source fences match the immutable operation correlation, not an entire
-- generation (a later legitimate resume binding may start at the same generation).
CREATE FUNCTION workflow_control_check_source_fence() RETURNS trigger AS $$
BEGIN
    -- A pre-existing REPEATABLE READ snapshot could miss a fence committed
    -- before this transaction acquired the advisory lock. Old binaries must
    -- also fail closed, so enforce isolation at the database write boundary.
    IF current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='workflow_control_source_fence_isolation',
        MESSAGE='source fenced writes require read committed isolation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      octet_length(NEW.workspace_id)::text||':'||NEW.workspace_id||
      octet_length(NEW.run_id)::text||':'||NEW.run_id,628239560154202));
    IF TG_TABLE_NAME='workflow_control_transition_receipts' THEN
      IF NEW.status<>'accepted' THEN RETURN NEW; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM workflow_control_source_fences f
        WHERE f.workspace_id=NEW.workspace_id AND f.run_id=NEW.run_id
          AND f.correlation_id=NEW.correlation_id) THEN
        RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='workflow_control_source_fenced',
          MESSAGE='source operation has a durable recovery fence';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_control_source_event_fence BEFORE INSERT ON workflow_control_transition_events
 FOR EACH ROW EXECUTE FUNCTION workflow_control_check_source_fence();
CREATE TRIGGER workflow_control_source_receipt_fence BEFORE INSERT ON workflow_control_transition_receipts
 FOR EACH ROW EXECUTE FUNCTION workflow_control_check_source_fence();

CREATE FUNCTION workflow_control_install_source_fence() RETURNS trigger AS $$
DECLARE b workflow_runner_authority_bindings%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      octet_length(NEW.workspace_id)::text||':'||NEW.workspace_id||
      octet_length(NEW.run_id)::text||':'||NEW.run_id,628239560154202));
    SELECT * INTO STRICT b FROM workflow_runner_authority_bindings WHERE binding_id=NEW.binding_id;
    IF b.operation<>'resume_advance' OR b.workspace_id<>NEW.workspace_id OR b.run_id<>NEW.run_id
       OR b.stage_hash<>NEW.stage_hash OR NEW.correlation_id<>'resume.'||encode(b.stage_hash,'hex')
       OR b.expected_resume_generation<>NEW.expected_resume_generation
       OR EXISTS (SELECT 1 FROM workflow_control_transition_receipts r
         WHERE r.workspace_id=NEW.workspace_id AND r.run_id=NEW.run_id
           AND r.correlation_id=NEW.correlation_id AND r.status='accepted')
       OR EXISTS (SELECT 1 FROM workflow_runner_leases l WHERE l.lease_id=b.lease_id
         AND l.state IN ('offered','active','cancelling') AND l.lease_expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION 'source fence has no exclusive uncommitted operation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_control_source_fences_insert BEFORE INSERT ON workflow_control_source_fences
 FOR EACH ROW EXECUTE FUNCTION workflow_control_install_source_fence();

CREATE FUNCTION workflow_runner_binding_settlement_guard() RETURNS trigger AS $$
DECLARE b workflow_runner_authority_bindings%ROWTYPE; r JSONB; p JSONB; source_receipt TEXT;
BEGIN
    SELECT * INTO STRICT b FROM workflow_runner_authority_bindings WHERE binding_id=NEW.binding_id;
    r:=convert_from(NEW.exact_receipt_bytes,'UTF8')::jsonb;
    p:=convert_from(NEW.exact_proof_bytes,'UTF8')::jsonb;
    IF NEW.proof_kind='budget_source_result' THEN
      source_receipt:=CASE WHEN b.operation='budget_reserve' THEN (p->>'sourceResult')::jsonb->>'durableReceiptBytes' ELSE p->>'sourceResult' END;
      IF b.operation NOT IN ('budget_reserve','budget_settle')
        OR p->>'schema' IS DISTINCT FROM 'openslack.workflow_runner_budget_settlement_proof.v1'
        OR p->>'resolution' IS DISTINCT FROM convert_from(b.exact_resolution_bytes,'UTF8')
        OR NOT EXISTS(SELECT 1 FROM workflow_control_budget_receipts s WHERE s.workspace_id=b.workspace_id AND s.run_id=b.run_id
          AND s.idempotency_key=convert_from(b.exact_resolution_bytes,'UTF8')::jsonb#>>'{evidence,preparedRequest,idempotencyKey}'
          AND s.status='accepted' AND s.exact_receipt_bytes=convert_to(source_receipt,'UTF8')) THEN
        RAISE EXCEPTION 'budget settlement has no matching immutable source receipt';
      END IF;
    END IF;
    IF b.workspace_id<>NEW.workspace_id OR b.run_id<>NEW.run_id OR b.stage_hash<>NEW.stage_hash
      OR r->>'schema' IS DISTINCT FROM 'openslack.workflow_runner_binding_settlement_receipt.v1'
      OR r->>'bindingId' IS DISTINCT FROM NEW.binding_id
      OR r->>'workspaceId' IS DISTINCT FROM NEW.workspace_id OR r->>'runId' IS DISTINCT FROM NEW.run_id
      OR r->>'stageHash' IS DISTINCT FROM encode(NEW.stage_hash,'hex')
      OR r->>'outcome' IS DISTINCT FROM NEW.outcome OR r->>'proofKind' IS DISTINCT FROM NEW.proof_kind
      OR r->>'proof' IS DISTINCT FROM convert_from(NEW.exact_proof_bytes,'UTF8')
      OR r->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
      OR (r->>'committedAt')::timestamptz IS DISTINCT FROM NEW.committed_at
      OR EXISTS (SELECT 1 FROM workflow_runner_leases l WHERE l.lease_id=b.lease_id
        AND l.state IN ('offered','active','cancelling') AND l.lease_expires_at>clock_timestamp())
      OR (NEW.proof_kind='source_fence' AND NOT EXISTS (
        SELECT 1 FROM workflow_control_source_fences f WHERE f.binding_id=b.binding_id))
      OR (NEW.proof_kind='resolution' AND (b.operation IN ('budget_reserve','budget_settle') OR NEW.exact_proof_bytes IS DISTINCT FROM b.exact_resolution_bytes))
      OR (NEW.proof_kind='source_receipt' AND NOT EXISTS (
        SELECT 1 FROM workflow_control_transition_receipts s WHERE s.workspace_id=b.workspace_id
          AND s.run_id=b.run_id AND s.correlation_id='resume.'||encode(b.stage_hash,'hex')
          AND s.status='accepted' AND s.exact_receipt_bytes=NEW.exact_proof_bytes)) THEN
        RAISE EXCEPTION 'binding settlement does not match exact historical evidence';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_runner_binding_settlements_insert BEFORE INSERT ON workflow_runner_binding_settlements
 FOR EACH ROW EXECUTE FUNCTION workflow_runner_binding_settlement_guard();

CREATE FUNCTION workflow_runner_reject_settled_binding_write() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM workflow_runner_binding_settlements s WHERE s.binding_id=OLD.binding_id)
       AND OLD IS DISTINCT FROM NEW THEN
      RAISE EXCEPTION 'settled binding history is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_runner_binding_settled BEFORE UPDATE ON workflow_runner_authority_bindings
 FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_settled_binding_write();

CREATE FUNCTION workflow_runner_recovery_lease_guard() RETURNS trigger AS $$
DECLARE j workflow_runner_jobs%ROWTYPE;
BEGIN
    IF current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='workflow_runner_recovery_lease_isolation',
        MESSAGE='recovery-fenced leases require read committed isolation';
    END IF;
    SELECT * INTO STRICT j FROM workflow_runner_jobs WHERE workspace_id=NEW.workspace_id AND job_id=NEW.job_id;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      octet_length(j.workspace_id)::text||':'||j.workspace_id||
      octet_length(j.workflow_run_id)::text||':'||j.workflow_run_id,628239560154202));
    IF NEW.state IN ('offered','active','cancelling') AND
      (EXISTS(SELECT 1 FROM workflow_runner_authority_bindings b JOIN workflow_runner_binding_settlements s USING(binding_id)
         WHERE b.attempt_id=NEW.attempt_id)
       OR EXISTS(SELECT 1 FROM workflow_control_recovery_pauses p WHERE p.workspace_id=j.workspace_id
         AND p.run_id=j.workflow_run_id AND p.committed_at>=j.created_at)) THEN
      RAISE EXCEPTION 'old execution identity is fenced by explicit recovery';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_runner_recovery_lease_fence BEFORE INSERT OR UPDATE ON workflow_runner_leases
 FOR EACH ROW EXECUTE FUNCTION workflow_runner_recovery_lease_guard();

CREATE FUNCTION workflow_runner_recovery_stage_guard() RETURNS trigger AS $$
BEGIN
    IF current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION 'recovery-fenced stages require read committed isolation';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      octet_length(NEW.workspace_id)::text||':'||NEW.workspace_id||
      octet_length(NEW.run_id)::text||':'||NEW.run_id,628239560154202));
    IF NOT EXISTS(SELECT 1 FROM workflow_runner_leases l WHERE l.lease_id=NEW.lease_id
      AND l.attempt_id=NEW.attempt_id AND l.workspace_id=NEW.workspace_id AND l.job_id=NEW.job_id
      AND l.fencing_token=NEW.fencing_token AND l.state IN ('offered','active') AND l.lease_expires_at>clock_timestamp())
      OR EXISTS(SELECT 1 FROM workflow_runner_authority_bindings b JOIN workflow_runner_binding_settlements s USING(binding_id)
        WHERE b.attempt_id=NEW.attempt_id)
      OR EXISTS(SELECT 1 FROM workflow_control_recovery_pauses p JOIN workflow_runner_jobs j
        ON j.workspace_id=p.workspace_id AND j.workflow_run_id=p.run_id
        WHERE j.workspace_id=NEW.workspace_id AND j.job_id=NEW.job_id AND p.committed_at>=j.created_at) THEN
      RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='workflow_runner_recovery_stage_fenced',
        MESSAGE='old execution identity cannot stage another source operation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_runner_recovery_stage_fence BEFORE INSERT ON workflow_runner_authority_bindings
 FOR EACH ROW EXECUTE FUNCTION workflow_runner_recovery_stage_guard();

-- Pausing an orphan is a separate exact-head CAS. Its proof must have been
-- inserted in this transaction; normal state transitions retain their rules.
CREATE FUNCTION workflow_control_check_recovery_pause() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM workflow_control_recovery_pauses p WHERE p.workspace_id=NEW.workspace_id
      AND p.run_id=NEW.run_id AND p.accepted_revision=NEW.revision) THEN
      IF NOT EXISTS (SELECT 1 FROM workflow_control_recovery_pauses p WHERE p.workspace_id=NEW.workspace_id
        AND p.run_id=NEW.run_id AND p.expected_revision=OLD.revision AND p.accepted_revision=NEW.revision
        AND p.transaction_id=pg_current_xact_id() AND p.prior_record_hash=OLD.record_hash
        AND p.exact_record_bytes=NEW.canonical_record_bytes AND p.record_hash=NEW.record_hash
        AND p.resume_generation=OLD.resume_generation)
        OR OLD.state NOT IN ('running','resuming') OR NEW.state<>'paused'
        OR OLD.resume_generation<>NEW.resume_generation
        OR OLD.current_phase_id IS DISTINCT FROM NEW.current_phase_id
        OR OLD.current_phase_index IS DISTINCT FROM NEW.current_phase_index THEN
          RAISE EXCEPTION 'recovery pause must preserve the exact authority head';
      END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER workflow_control_recovery_pause_guard BEFORE UPDATE ON workflow_control_runs
 FOR EACH ROW EXECUTE FUNCTION workflow_control_check_recovery_pause();

CREATE TRIGGER workflow_runner_binding_settlements_immutable BEFORE UPDATE OR DELETE ON workflow_runner_binding_settlements
 FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_control_source_fences_immutable BEFORE UPDATE OR DELETE ON workflow_control_source_fences
 FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_control_recovery_pauses_immutable BEFORE UPDATE OR DELETE ON workflow_control_recovery_pauses
 FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();

-- The runtime pool must not evade fences through a replication-role setting.
ALTER TABLE workflow_control_transition_events ENABLE ALWAYS TRIGGER workflow_control_source_event_fence;
ALTER TABLE workflow_control_transition_receipts ENABLE ALWAYS TRIGGER workflow_control_source_receipt_fence;
ALTER TABLE workflow_control_runs ENABLE ALWAYS TRIGGER workflow_control_recovery_pause_guard;
ALTER TABLE workflow_runner_leases ENABLE ALWAYS TRIGGER workflow_runner_recovery_lease_fence;
ALTER TABLE workflow_runner_authority_bindings ENABLE ALWAYS TRIGGER workflow_runner_binding_settled;
ALTER TABLE workflow_runner_authority_bindings ENABLE ALWAYS TRIGGER workflow_runner_recovery_stage_fence;
ALTER TABLE workflow_runner_binding_settlements ENABLE ALWAYS TRIGGER workflow_runner_binding_settlements_insert;
ALTER TABLE workflow_runner_binding_settlements ENABLE ALWAYS TRIGGER workflow_runner_binding_settlements_immutable;
ALTER TABLE workflow_control_source_fences ENABLE ALWAYS TRIGGER workflow_control_source_fences_insert;
ALTER TABLE workflow_control_source_fences ENABLE ALWAYS TRIGGER workflow_control_source_fences_immutable;
ALTER TABLE workflow_control_recovery_pauses ENABLE ALWAYS TRIGGER workflow_control_recovery_pauses_immutable;

-- Resolve protected relations in the migration's actual schema, even when an
-- old connection changes search_path or creates a same-named temporary table.
DO $$ DECLARE function_name text; owner_schema text:=current_schema(); BEGIN
 FOREACH function_name IN ARRAY ARRAY['workflow_control_check_source_fence',
  'workflow_control_install_source_fence','workflow_runner_binding_settlement_guard',
  'workflow_runner_reject_settled_binding_write','workflow_runner_recovery_lease_guard','workflow_runner_recovery_stage_guard',
  'workflow_control_check_recovery_pause'] LOOP
  EXECUTE format('ALTER FUNCTION %I.%I() SET search_path TO pg_catalog,%I,pg_temp',owner_schema,function_name,owner_schema);
 END LOOP;
END $$;

COMMIT;
