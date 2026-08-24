-- GS9-F2b default-off Workflow Runner v2 authority-binding delivery.
-- This migration is additive to 000007. It does not activate production
-- routing and it never promotes checkpoint/effect shadow receipts to authority.
BEGIN;

CREATE TABLE workflow_runner_v2_runtime_admissions (
    attempt_id TEXT PRIMARY KEY REFERENCES workflow_runner_attempts(attempt_id),
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    workflow_run_id TEXT NOT NULL,
    lease_id TEXT NOT NULL REFERENCES workflow_runner_leases(lease_id),
    fencing_token BIGINT NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
    job_spec_hash BYTEA NOT NULL CHECK (octet_length(job_spec_hash)=32),
    admission_disposition TEXT NOT NULL CHECK (admission_disposition IN ('initial','resume')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint)=32),
    exact_request_bytes BYTEA NOT NULL CHECK (octet_length(exact_request_bytes) BETWEEN 1 AND 65536),
    exact_receipt_bytes BYTEA NOT NULL CHECK (octet_length(exact_receipt_bytes) BETWEEN 1 AND 65536),
    admitted_at TIMESTAMPTZ NOT NULL,
    UNIQUE(attempt_id,workspace_id,job_id,admission_disposition,job_spec_hash),
    FOREIGN KEY(workspace_id,workflow_run_id,job_id)
        REFERENCES workflow_runner_jobs(workspace_id,workflow_run_id,job_id),
    UNIQUE(attempt_id,lease_id,fencing_token)
);

CREATE FUNCTION workflow_runner_v2_runtime_admission_guard()
RETURNS trigger AS $$
DECLARE
    exact_request JSONB;
    exact_receipt JSONB;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'workflow runner v2 runtime admissions are immutable';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM workflow_runner_jobs job
        JOIN workflow_runner_attempts attempt ON attempt.attempt_id=NEW.attempt_id
        JOIN workflow_runner_leases lease ON lease.lease_id=NEW.lease_id
        WHERE job.workspace_id=NEW.workspace_id
          AND job.job_id=NEW.job_id
          AND job.workflow_run_id=NEW.workflow_run_id
          AND job.job_spec_hash=NEW.job_spec_hash
          AND job.required_protocol_version='openslack.workflow_runner.v2'
          AND job.authority_backend='go'
          AND job.workflow_authority='workflow-control'
          AND job.current_attempt_id=attempt.attempt_id
          AND attempt.workspace_id=job.workspace_id
          AND attempt.job_id=job.job_id
          AND attempt.state='offered'
          AND attempt.worker_sequence=0
          AND attempt.fencing_token=NEW.fencing_token
          AND lease.attempt_id=attempt.attempt_id
          AND lease.workspace_id=job.workspace_id
          AND lease.job_id=job.job_id
          AND lease.fencing_token=NEW.fencing_token
          AND lease.state='offered'
    ) THEN
        RAISE EXCEPTION 'workflow runner v2 runtime admission lacks an exact offered lease anchor';
    END IF;
    exact_request := convert_from(NEW.exact_request_bytes,'UTF8')::JSONB;
    exact_receipt := convert_from(NEW.exact_receipt_bytes,'UTF8')::JSONB;
    IF (SELECT count(*) FROM jsonb_object_keys(exact_request))<>9
       OR exact_request->>'schema' IS DISTINCT FROM 'openslack.workflow_runner_v2_runtime_admission.v1'
       OR exact_request->>'workspaceId' IS DISTINCT FROM NEW.workspace_id
       OR exact_request->>'jobId' IS DISTINCT FROM NEW.job_id
       OR exact_request->>'workflowRunId' IS DISTINCT FROM NEW.workflow_run_id
       OR exact_request->>'attemptId' IS DISTINCT FROM NEW.attempt_id
       OR exact_request->>'leaseId' IS DISTINCT FROM NEW.lease_id
       OR (exact_request->>'fencingToken')::BIGINT IS DISTINCT FROM NEW.fencing_token
       OR exact_request->>'jobSpecHash' IS DISTINCT FROM encode(NEW.job_spec_hash,'hex')
       OR exact_request->>'disposition' IS DISTINCT FROM NEW.admission_disposition
       OR (SELECT count(*) FROM jsonb_object_keys(exact_receipt))<>13
       OR exact_receipt->>'schema' IS DISTINCT FROM 'openslack.workflow_runner_v2_runtime_admission_receipt.v1'
       OR exact_receipt->>'status' IS DISTINCT FROM 'accepted'
       OR exact_receipt->>'workspaceId' IS DISTINCT FROM exact_request->>'workspaceId'
       OR exact_receipt->>'jobId' IS DISTINCT FROM exact_request->>'jobId'
       OR exact_receipt->>'workflowRunId' IS DISTINCT FROM exact_request->>'workflowRunId'
       OR exact_receipt->>'attemptId' IS DISTINCT FROM exact_request->>'attemptId'
       OR exact_receipt->>'leaseId' IS DISTINCT FROM exact_request->>'leaseId'
       OR exact_receipt->>'fencingToken' IS DISTINCT FROM exact_request->>'fencingToken'
       OR exact_receipt->>'jobSpecHash' IS DISTINCT FROM exact_request->>'jobSpecHash'
       OR exact_receipt->>'disposition' IS DISTINCT FROM exact_request->>'disposition'
       OR exact_receipt->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
       OR exact_receipt->>'requestFingerprint' IS DISTINCT FROM 'sha256:'||encode(NEW.request_fingerprint,'hex')
       OR (exact_receipt->>'committedAt')::TIMESTAMPTZ IS DISTINCT FROM NEW.admitted_at THEN
        RAISE EXCEPTION 'workflow runner v2 runtime admission exact request/receipt identity is cross-spliced';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_runner_v2_runtime_admissions_guard
BEFORE INSERT OR UPDATE OR DELETE ON workflow_runner_v2_runtime_admissions
FOR EACH ROW EXECUTE FUNCTION workflow_runner_v2_runtime_admission_guard();

ALTER TABLE workflow_runner_v2_attempt_bindings
    ADD COLUMN admission_disposition TEXT,
    ADD COLUMN admission_job_spec_hash BYTEA,
    ADD CONSTRAINT workflow_runner_v2_attempt_binding_admission_check
        CHECK (
            (admission_disposition IS NULL AND admission_job_spec_hash IS NULL)
            OR (admission_disposition IN ('initial','resume')
                AND admission_job_spec_hash IS NOT NULL
                AND octet_length(admission_job_spec_hash)=32)
        ),
    ADD CONSTRAINT workflow_runner_v2_attempt_binding_admission_fk
        FOREIGN KEY(attempt_id,workspace_id,job_id,admission_disposition,admission_job_spec_hash)
        REFERENCES workflow_runner_v2_runtime_admissions(attempt_id,workspace_id,job_id,admission_disposition,job_spec_hash);

ALTER TABLE workflow_runner_v2_attempt_bindings
    DROP CONSTRAINT workflow_runner_v2_attempt_bindi_last_authority_operation_check;
ALTER TABLE workflow_runner_v2_attempt_bindings
    ADD CONSTRAINT workflow_runner_v2_attempt_bindi_last_authority_operation_check CHECK (
        last_authority_operation IS NULL OR last_authority_operation IN (
            'checkpoint_commit','effect_authorize','effect_complete',
            'budget_reserve','budget_settle','resume_advance'
        )
    );

CREATE OR REPLACE FUNCTION workflow_runner_v2_attempt_binding_transition()
RETURNS trigger AS $$
BEGIN
    IF OLD.admission_disposition IS NULL
       AND OLD.admission_job_spec_hash IS NULL
       AND NEW.admission_disposition IS NOT NULL
       AND NEW.admission_job_spec_hash IS NOT NULL
       AND OLD.attempt_id IS NOT DISTINCT FROM NEW.attempt_id
       AND OLD.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
       AND OLD.job_id IS NOT DISTINCT FROM NEW.job_id
       AND OLD.authority_backend IS NOT DISTINCT FROM NEW.authority_backend
       AND OLD.workflow_authority IS NOT DISTINCT FROM NEW.workflow_authority
       AND OLD.routing_epoch IS NOT DISTINCT FROM NEW.routing_epoch
       AND OLD.authority_build_hash IS NOT DISTINCT FROM NEW.authority_build_hash
       AND OLD.initial_run_revision IS NOT DISTINCT FROM NEW.initial_run_revision
       AND OLD.initial_resume_generation IS NOT DISTINCT FROM NEW.initial_resume_generation
       AND OLD.current_run_revision IS NOT DISTINCT FROM NEW.current_run_revision
       AND OLD.current_resume_generation IS NOT DISTINCT FROM NEW.current_resume_generation
       AND OLD.last_authority_operation IS NOT DISTINCT FROM NEW.last_authority_operation
       AND OLD.last_authority_event_id IS NOT DISTINCT FROM NEW.last_authority_event_id
       AND OLD.required_capabilities IS NOT DISTINCT FROM NEW.required_capabilities
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at THEN
        RETURN NEW;
    END IF;
    IF OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
       OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
       OR OLD.job_id IS DISTINCT FROM NEW.job_id
       OR OLD.authority_backend IS DISTINCT FROM NEW.authority_backend
       OR OLD.workflow_authority IS DISTINCT FROM NEW.workflow_authority
       OR OLD.routing_epoch IS DISTINCT FROM NEW.routing_epoch
       OR OLD.authority_build_hash IS DISTINCT FROM NEW.authority_build_hash
       OR OLD.initial_run_revision IS DISTINCT FROM NEW.initial_run_revision
       OR OLD.initial_resume_generation IS DISTINCT FROM NEW.initial_resume_generation
       OR OLD.admission_disposition IS DISTINCT FROM NEW.admission_disposition
       OR OLD.admission_job_spec_hash IS DISTINCT FROM NEW.admission_job_spec_hash
       OR OLD.required_capabilities IS DISTINCT FROM NEW.required_capabilities
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR NEW.last_authority_operation IS NULL
       OR NEW.last_authority_event_id IS NULL
       OR NEW.last_authority_event_id IS NOT DISTINCT FROM OLD.last_authority_event_id
       OR NOT (
          (NEW.last_authority_operation IN (
                'checkpoint_commit','effect_authorize','budget_reserve','budget_settle'
           )
             AND NEW.current_run_revision=OLD.current_run_revision+1
             AND NEW.current_resume_generation=OLD.current_resume_generation)
          OR (NEW.last_authority_operation='effect_complete'
             AND NEW.current_run_revision=OLD.current_run_revision
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

ALTER TABLE workflow_runner_v2_event_inbox
    DROP CONSTRAINT workflow_runner_v2_event_inbox_kind_check;
ALTER TABLE workflow_runner_v2_event_inbox
    ADD CONSTRAINT workflow_runner_v2_event_inbox_kind_check CHECK (kind IN (
        'lease_accept','effect_intent','effect_outcome','checkpoint_commit',
        'budget_reserve_request','budget_usage_report'
    ));

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM workflow_runner_v2_event_inbox
         WHERE state IN ('authority_committed','runner_committed')
           AND (
               authority_operation IS NULL
               OR authority_receipt_hash IS NULL
               OR exact_authority_receipt_bytes IS NULL
               OR authority_receipt_hash IS DISTINCT FROM sha256(exact_authority_receipt_bytes)
               OR NOT (
                   (kind='checkpoint_commit' AND authority_operation='checkpoint_commit')
                   OR (kind='effect_intent' AND authority_operation='effect_authorize')
                   OR (kind='budget_reserve_request' AND authority_operation='budget_reserve')
                   OR (kind='budget_usage_report' AND authority_operation='budget_settle')
                   OR (kind='lease_accept' AND authority_operation='resume_advance')
               )
           )
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE='23514',
            CONSTRAINT='workflow_runner_v2_event_inbox_f2b_upgrade_check',
            MESSAGE='schema-7 v2 event inbox contains an incomplete or cross-spliced authority outcome';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_runner_v2_event_inbox_transition_f2b()
RETURNS trigger AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'workflow runner v2 event inbox is append-only';
    END IF;
    IF OLD.event_id IS DISTINCT FROM NEW.event_id
       OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
       OR OLD.job_id IS DISTINCT FROM NEW.job_id
       OR OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
       OR OLD.lease_id IS DISTINCT FROM NEW.lease_id
       OR OLD.fencing_token IS DISTINCT FROM NEW.fencing_token
       OR OLD.worker_sequence IS DISTINCT FROM NEW.worker_sequence
       OR OLD.kind IS DISTINCT FROM NEW.kind
       OR OLD.run_revision IS DISTINCT FROM NEW.run_revision
       OR OLD.resume_generation IS DISTINCT FROM NEW.resume_generation
       OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
       OR OLD.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
       OR OLD.message_digest IS DISTINCT FROM NEW.message_digest
       OR OLD.exact_event_bytes IS DISTINCT FROM NEW.exact_event_bytes
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'workflow runner v2 event inbox immutable identity cannot change';
    END IF;
    IF OLD.authority_operation IS NOT NULL AND (
       OLD.authority_operation IS DISTINCT FROM NEW.authority_operation
       OR OLD.authority_receipt_hash IS DISTINCT FROM NEW.authority_receipt_hash
       OR OLD.exact_authority_receipt_bytes IS DISTINCT FROM NEW.exact_authority_receipt_bytes) THEN
        RAISE EXCEPTION 'workflow runner v2 event inbox authority outcome is append-once';
    END IF;
    IF OLD.reconciliation_id IS NOT NULL AND (
       OLD.reconciliation_id IS DISTINCT FROM NEW.reconciliation_id
       OR NEW.state<>'reconciliation_required') THEN
        RAISE EXCEPTION 'workflow runner v2 event inbox reconciliation is append-only';
    END IF;
    IF OLD.state='reconciliation_required' AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'workflow runner v2 event inbox reconciliation row is frozen';
    END IF;
    IF OLD.state IS DISTINCT FROM NEW.state AND NOT (
       (OLD.state='pending_authority' AND NEW.state IN ('authority_committed','reconciliation_required'))
       OR (OLD.state='authority_committed' AND NEW.state IN ('runner_committed','reconciliation_required'))
       OR (OLD.state='runner_committed' AND NEW.state='reconciliation_required')
    ) THEN
        RAISE EXCEPTION 'workflow runner v2 event inbox state transition is not monotonic';
    END IF;
    IF NEW.state IN ('authority_committed','runner_committed') AND (
       NEW.authority_operation IS NULL
       OR NEW.authority_receipt_hash IS NULL
       OR NEW.exact_authority_receipt_bytes IS NULL
       OR NEW.authority_receipt_hash IS DISTINCT FROM sha256(NEW.exact_authority_receipt_bytes)
       OR NOT (
           (NEW.kind='checkpoint_commit' AND NEW.authority_operation='checkpoint_commit')
           OR (NEW.kind='effect_intent' AND NEW.authority_operation='effect_authorize')
           OR (NEW.kind='effect_outcome' AND NEW.authority_operation='effect_complete')
           OR (NEW.kind='budget_reserve_request' AND NEW.authority_operation='budget_reserve')
           OR (NEW.kind='budget_usage_report' AND NEW.authority_operation='budget_settle')
           OR (NEW.kind='lease_accept' AND NEW.authority_operation='resume_advance')
       )) THEN
        RAISE EXCEPTION 'workflow runner v2 event inbox authority outcome is cross-spliced';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_runner_v2_event_inbox_transition_f2b
BEFORE UPDATE OR DELETE ON workflow_runner_v2_event_inbox
FOR EACH ROW EXECUTE FUNCTION workflow_runner_v2_event_inbox_transition_f2b();

ALTER TABLE workflow_runner_control_messages
    DROP CONSTRAINT workflow_runner_control_messages_delivery_phase_check,
    DROP CONSTRAINT workflow_runner_control_messages_delivery_state_check;
ALTER TABLE workflow_runner_control_messages
    ADD CONSTRAINT workflow_runner_control_messages_delivery_state_check CHECK (
        delivery_state IN (
            'pending','delivering','awaiting_ack','delivered','abandoned',
            'reconciliation_required'
        )
    ),
    ADD CONSTRAINT workflow_runner_control_messages_delivery_phase_check CHECK (
        (delivery_state='pending' AND delivery_started_at IS NULL AND delivered_at IS NULL)
        OR (delivery_state IN ('delivering','awaiting_ack','reconciliation_required')
            AND delivery_started_at IS NOT NULL AND delivered_at IS NULL)
        OR (delivery_state='delivered' AND delivery_started_at IS NOT NULL AND delivered_at IS NOT NULL)
        OR (delivery_state='abandoned' AND delivered_at IS NULL)
    );

CREATE TABLE workflow_runner_authority_bindings (
    binding_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN (
        'checkpoint_commit','effect_authorize','effect_complete',
        'budget_reserve','budget_settle','resume_advance'
    )),
    state TEXT NOT NULL CHECK (state IN (
        'staged','resolved','runner_committed','completed','reconciliation_required'
    )),
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES workflow_runner_attempts(attempt_id),
    lease_id TEXT NOT NULL REFERENCES workflow_runner_leases(lease_id),
    fencing_token BIGINT NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
    authority_backend TEXT NOT NULL CHECK (authority_backend='go'),
    workflow_authority TEXT NOT NULL CHECK (workflow_authority='workflow-control'),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash)=32),
    expected_run_revision BIGINT NOT NULL CHECK (expected_run_revision BETWEEN 1 AND 9007199254740991),
    accepted_run_revision BIGINT NOT NULL CHECK (accepted_run_revision BETWEEN 1 AND 9007199254740991),
    expected_resume_generation BIGINT NOT NULL CHECK (expected_resume_generation BETWEEN 0 AND 9007199254740991),
    accepted_resume_generation BIGINT NOT NULL CHECK (accepted_resume_generation BETWEEN 0 AND 9007199254740991),
    target_event_id TEXT NOT NULL UNIQUE,
    target_kind TEXT NOT NULL CHECK (target_kind IN (
        'checkpoint_commit','effect_intent','effect_outcome',
        'budget_reserve_request','budget_usage_report','lease_accept'
    )),
    target_sequence BIGINT NOT NULL CHECK (target_sequence BETWEEN 1 AND 9007199254740991),
    target_body_hash BYTEA NOT NULL CHECK (octet_length(target_body_hash)=32),
    target_idempotency_key TEXT NOT NULL UNIQUE,
    target_request_fingerprint BYTEA NOT NULL CHECK (octet_length(target_request_fingerprint)=32),
    exact_target_bytes BYTEA NOT NULL CHECK (octet_length(exact_target_bytes) BETWEEN 1 AND 1048576),
    stage_idempotency_key TEXT NOT NULL UNIQUE,
    stage_request_fingerprint BYTEA NOT NULL CHECK (octet_length(stage_request_fingerprint)=32),
    stage_hash BYTEA NOT NULL CHECK (octet_length(stage_hash)=32),
    exact_stage_bytes BYTEA NOT NULL CHECK (octet_length(exact_stage_bytes) BETWEEN 1 AND 1048576),
    stage_receipt_hash BYTEA NOT NULL CHECK (octet_length(stage_receipt_hash)=32),
    exact_stage_receipt_bytes BYTEA NOT NULL CHECK (octet_length(exact_stage_receipt_bytes) BETWEEN 1 AND 65536),
    stage_committed_at TIMESTAMPTZ NOT NULL,
    resolution_idempotency_key TEXT UNIQUE,
    resolution_request_fingerprint BYTEA CHECK (
        resolution_request_fingerprint IS NULL OR octet_length(resolution_request_fingerprint)=32
    ),
    resolution_hash BYTEA CHECK (resolution_hash IS NULL OR octet_length(resolution_hash)=32),
    exact_resolution_bytes BYTEA CHECK (
        exact_resolution_bytes IS NULL OR octet_length(exact_resolution_bytes) BETWEEN 1 AND 1048576
    ),
    resolution_receipt_hash BYTEA CHECK (
        resolution_receipt_hash IS NULL OR octet_length(resolution_receipt_hash)=32
    ),
    exact_resolution_receipt_bytes BYTEA CHECK (
        exact_resolution_receipt_bytes IS NULL OR octet_length(exact_resolution_receipt_bytes) BETWEEN 1 AND 65536
    ),
    resolution_committed_at TIMESTAMPTZ,
    source_plane TEXT,
    source_evidence_state TEXT,
    source_expected_revision BIGINT,
    source_accepted_revision BIGINT,
    source_expected_resume_generation BIGINT,
    source_accepted_resume_generation BIGINT,
    source_request_hash BYTEA CHECK (source_request_hash IS NULL OR octet_length(source_request_hash)=32),
    source_receipt_hash BYTEA CHECK (source_receipt_hash IS NULL OR octet_length(source_receipt_hash)=32),
    source_record_hash BYTEA CHECK (source_record_hash IS NULL OR octet_length(source_record_hash)=32),
    source_authority_build_hash BYTEA CHECK (
        source_authority_build_hash IS NULL OR octet_length(source_authority_build_hash)=32
    ),
    exact_source_result_bytes BYTEA CHECK (
        exact_source_result_bytes IS NULL OR octet_length(exact_source_result_bytes) BETWEEN 1 AND 1048576
    ),
    source_result_hash BYTEA CHECK (source_result_hash IS NULL OR octet_length(source_result_hash)=32),
    reconciliation_id TEXT,
    reconciliation_reason TEXT CHECK (reconciliation_reason IS NULL OR reconciliation_reason IN (
        'stage_commit_unknown','resolution_commit_unknown','source_outcome_unknown',
        'runner_commit_unknown','control_delivery_unknown','process_crash',
        'cancelled_with_outstanding_authority','terminal_with_outstanding_authority'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(attempt_id,target_sequence),
    FOREIGN KEY(workspace_id,job_id) REFERENCES workflow_runner_jobs(workspace_id,job_id),
    CHECK (
        (operation IN ('checkpoint_commit','effect_authorize','budget_reserve','budget_settle')
            AND accepted_run_revision=expected_run_revision+1
            AND accepted_resume_generation=expected_resume_generation)
        OR (operation='effect_complete'
            AND accepted_run_revision=expected_run_revision
            AND accepted_resume_generation=expected_resume_generation)
        OR (operation='resume_advance'
            AND accepted_run_revision=expected_run_revision+1
            AND accepted_resume_generation=expected_resume_generation+1)
    ),
    CHECK (
        (state='staged'
            AND resolution_idempotency_key IS NULL
            AND resolution_request_fingerprint IS NULL
            AND resolution_hash IS NULL
            AND exact_resolution_bytes IS NULL
            AND resolution_receipt_hash IS NULL
            AND exact_resolution_receipt_bytes IS NULL
            AND resolution_committed_at IS NULL
            AND source_plane IS NULL
            AND source_evidence_state IS NULL
            AND source_expected_revision IS NULL
            AND source_accepted_revision IS NULL
            AND source_expected_resume_generation IS NULL
            AND source_accepted_resume_generation IS NULL
            AND source_request_hash IS NULL
            AND source_receipt_hash IS NULL
            AND source_record_hash IS NULL
            AND source_authority_build_hash IS NULL
            AND exact_source_result_bytes IS NULL
            AND source_result_hash IS NULL
            AND reconciliation_id IS NULL
            AND reconciliation_reason IS NULL)
        OR (state IN ('resolved','runner_committed','completed')
            AND resolution_idempotency_key IS NOT NULL
            AND resolution_request_fingerprint IS NOT NULL
            AND resolution_hash IS NOT NULL
            AND exact_resolution_bytes IS NOT NULL
            AND resolution_receipt_hash IS NOT NULL
            AND exact_resolution_receipt_bytes IS NOT NULL
            AND resolution_committed_at IS NOT NULL
            AND source_plane IS NOT NULL
            AND source_evidence_state IS NOT NULL
            AND source_expected_revision IS NOT NULL
            AND source_expected_resume_generation IS NOT NULL
            AND source_accepted_resume_generation IS NOT NULL
            AND source_request_hash IS NOT NULL
            AND source_authority_build_hash IS NOT NULL
            AND reconciliation_id IS NULL
            AND reconciliation_reason IS NULL)
        OR (state='reconciliation_required'
            AND reconciliation_id IS NOT NULL
            AND reconciliation_reason IS NOT NULL)
    ),
    CHECK (
        (source_plane IS NULL
            AND source_evidence_state IS NULL
            AND source_expected_revision IS NULL
            AND source_accepted_revision IS NULL
            AND source_expected_resume_generation IS NULL
            AND source_accepted_resume_generation IS NULL
            AND source_request_hash IS NULL
            AND source_receipt_hash IS NULL
            AND source_record_hash IS NULL
            AND source_authority_build_hash IS NULL
            AND exact_source_result_bytes IS NULL
            AND source_result_hash IS NULL)
        OR (operation='checkpoint_commit'
            AND source_plane='checkpoint_control'
            AND source_evidence_state='committed'
            AND source_expected_revision IS NOT NULL AND source_expected_revision>=0
            AND source_accepted_revision IS NOT NULL
            AND source_accepted_revision=source_expected_revision+1
            AND source_expected_resume_generation IS NOT NULL AND source_expected_resume_generation>=0
            AND source_accepted_resume_generation IS NOT NULL
            AND source_accepted_resume_generation=source_expected_resume_generation
            AND source_request_hash IS NOT NULL AND source_receipt_hash IS NOT NULL
            AND source_record_hash IS NOT NULL AND source_authority_build_hash IS NOT NULL)
        OR (operation IN ('effect_authorize','effect_complete')
            AND source_plane='effect_v2_sibling'
            AND source_evidence_state='committed'
            AND source_expected_revision IS NOT NULL AND source_expected_revision>=0
            AND source_accepted_revision IS NOT NULL
            AND source_accepted_revision=source_expected_revision+1
            AND source_expected_resume_generation IS NOT NULL AND source_expected_resume_generation>=0
            AND source_accepted_resume_generation IS NOT NULL
            AND source_accepted_resume_generation=source_expected_resume_generation
            AND source_request_hash IS NOT NULL AND source_receipt_hash IS NOT NULL
            AND source_record_hash IS NOT NULL AND source_authority_build_hash IS NOT NULL)
        OR (operation IN ('budget_reserve','budget_settle')
            AND source_plane='budget_account'
            AND source_evidence_state='prepared'
            AND source_expected_revision IS NOT NULL AND source_expected_revision>=0
            AND source_accepted_revision IS NULL
            AND source_expected_resume_generation IS NOT NULL AND source_expected_resume_generation>=0
            AND source_accepted_resume_generation IS NOT NULL
            AND source_accepted_resume_generation=source_expected_resume_generation
            AND source_request_hash IS NOT NULL AND source_receipt_hash IS NULL
            AND source_record_hash IS NULL AND source_authority_build_hash IS NOT NULL)
        OR (operation='resume_advance'
            AND source_plane='resume_control'
            AND source_evidence_state='committed'
            AND source_expected_revision IS NOT NULL AND source_expected_revision>=0
            AND source_accepted_revision IS NOT NULL
            AND source_accepted_revision=source_expected_revision+1
            AND source_expected_resume_generation IS NOT NULL AND source_expected_resume_generation>=0
            AND source_accepted_resume_generation IS NOT NULL
            AND source_accepted_resume_generation=source_expected_resume_generation+1
            AND source_request_hash IS NOT NULL AND source_receipt_hash IS NOT NULL
            AND source_record_hash IS NOT NULL AND source_authority_build_hash IS NOT NULL)
    ),
    CHECK (
        (resolution_idempotency_key IS NULL
            AND resolution_request_fingerprint IS NULL
            AND resolution_hash IS NULL
            AND exact_resolution_bytes IS NULL
            AND resolution_receipt_hash IS NULL
            AND exact_resolution_receipt_bytes IS NULL
            AND resolution_committed_at IS NULL
            AND source_plane IS NULL)
        OR (resolution_idempotency_key IS NOT NULL
            AND resolution_request_fingerprint IS NOT NULL
            AND resolution_hash IS NOT NULL
            AND exact_resolution_bytes IS NOT NULL
            AND resolution_receipt_hash IS NOT NULL
            AND exact_resolution_receipt_bytes IS NOT NULL
            AND resolution_committed_at IS NOT NULL
            AND source_plane IS NOT NULL)
    ),
    CHECK ((exact_source_result_bytes IS NULL)=(source_result_hash IS NULL)),
    CONSTRAINT workflow_runner_authority_source_result_hash_check
        CHECK (exact_source_result_bytes IS NULL OR source_result_hash=sha256(exact_source_result_bytes)),
    CHECK (
        (operation NOT IN ('budget_reserve','budget_settle')
            AND exact_source_result_bytes IS NULL AND source_result_hash IS NULL)
        OR (operation IN ('budget_reserve','budget_settle')
            AND state IN ('staged','resolved')
            AND exact_source_result_bytes IS NULL AND source_result_hash IS NULL)
        OR (operation IN ('budget_reserve','budget_settle')
            AND state IN ('runner_committed','completed')
            AND exact_source_result_bytes IS NOT NULL
            AND source_result_hash IS NOT NULL)
        OR (operation IN ('budget_reserve','budget_settle')
            AND state='reconciliation_required')
    )
);

CREATE TABLE workflow_runner_authority_control_acks (
    control_event_id TEXT PRIMARY KEY REFERENCES workflow_runner_control_messages(control_event_id),
    binding_id TEXT NOT NULL REFERENCES workflow_runner_authority_bindings(binding_id),
    control_kind TEXT NOT NULL CHECK (control_kind IN (
        'event_receipt','budget_authorization','effect_authorization','resume_offer','cancel_request'
    )),
    control_sequence BIGINT NOT NULL CHECK (control_sequence BETWEEN 1 AND 9007199254740991),
    companion_sequence BIGINT NOT NULL CHECK (companion_sequence IN (3,4)),
    message_digest BYTEA NOT NULL CHECK (octet_length(message_digest)=32),
    attempt_id TEXT NOT NULL REFERENCES workflow_runner_attempts(attempt_id),
    lease_id TEXT NOT NULL REFERENCES workflow_runner_leases(lease_id),
    fencing_token BIGINT NOT NULL CHECK (fencing_token BETWEEN 1 AND 9007199254740991),
    disposition TEXT NOT NULL CHECK (disposition IN ('accepted','reconciliation_required')),
    ack_idempotency_key TEXT NOT NULL UNIQUE,
    ack_request_fingerprint BYTEA NOT NULL CHECK (octet_length(ack_request_fingerprint)=32),
    ack_hash BYTEA NOT NULL CHECK (octet_length(ack_hash)=32),
    exact_ack_bytes BYTEA NOT NULL CHECK (octet_length(exact_ack_bytes) BETWEEN 1 AND 65536),
    prior_control_event_id TEXT REFERENCES workflow_runner_authority_control_acks(control_event_id),
    processed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(attempt_id,control_sequence),
    UNIQUE(binding_id,control_kind),
    UNIQUE(binding_id,companion_sequence),
    CONSTRAINT workflow_runner_authority_control_ack_hash_check
        CHECK (ack_hash=sha256(exact_ack_bytes)),
    CHECK (
        (companion_sequence=3 AND control_kind='event_receipt' AND prior_control_event_id IS NULL)
        OR (companion_sequence=4 AND control_kind<>'event_receipt' AND prior_control_event_id IS NOT NULL)
    )
);

CREATE TABLE workflow_runner_authority_reconciliations (
    reconciliation_id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES workflow_runner_attempts(attempt_id),
    reason TEXT NOT NULL CHECK (reason IN (
        'stage_commit_unknown','resolution_commit_unknown','source_outcome_unknown',
        'runner_commit_unknown','control_delivery_unknown','process_crash',
        'cancelled_with_outstanding_authority','terminal_with_outstanding_authority'
    )),
    evidence_hash BYTEA NOT NULL CHECK (octet_length(evidence_hash)=32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(workspace_id,job_id) REFERENCES workflow_runner_jobs(workspace_id,job_id),
    FOREIGN KEY(binding_id) REFERENCES workflow_runner_authority_bindings(binding_id)
        DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(reconciliation_id,binding_id,reason)
);

ALTER TABLE workflow_runner_authority_bindings
    ADD CONSTRAINT workflow_runner_authority_bindings_reconciliation_fk
    FOREIGN KEY(reconciliation_id,binding_id,reconciliation_reason)
    REFERENCES workflow_runner_authority_reconciliations(reconciliation_id,binding_id,reason)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION workflow_runner_authority_binding_transition()
RETURNS trigger AS $$
DECLARE
    exact_runner_event BOOLEAN;
    exact_runner_receipt BOOLEAN;
    event_ack_count BIGINT;
    decision_ack_count BIGINT;
    cancel_ack_count BIGINT;
BEGIN
    IF OLD.binding_id IS DISTINCT FROM NEW.binding_id
       OR OLD.operation IS DISTINCT FROM NEW.operation
       OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
       OR OLD.job_id IS DISTINCT FROM NEW.job_id
       OR OLD.run_id IS DISTINCT FROM NEW.run_id
       OR OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
       OR OLD.lease_id IS DISTINCT FROM NEW.lease_id
       OR OLD.fencing_token IS DISTINCT FROM NEW.fencing_token
       OR OLD.authority_backend IS DISTINCT FROM NEW.authority_backend
       OR OLD.workflow_authority IS DISTINCT FROM NEW.workflow_authority
       OR OLD.routing_epoch IS DISTINCT FROM NEW.routing_epoch
       OR OLD.authority_build_hash IS DISTINCT FROM NEW.authority_build_hash
       OR OLD.expected_run_revision IS DISTINCT FROM NEW.expected_run_revision
       OR OLD.accepted_run_revision IS DISTINCT FROM NEW.accepted_run_revision
       OR OLD.expected_resume_generation IS DISTINCT FROM NEW.expected_resume_generation
       OR OLD.accepted_resume_generation IS DISTINCT FROM NEW.accepted_resume_generation
       OR OLD.target_event_id IS DISTINCT FROM NEW.target_event_id
       OR OLD.target_kind IS DISTINCT FROM NEW.target_kind
       OR OLD.target_sequence IS DISTINCT FROM NEW.target_sequence
       OR OLD.target_body_hash IS DISTINCT FROM NEW.target_body_hash
       OR OLD.target_idempotency_key IS DISTINCT FROM NEW.target_idempotency_key
       OR OLD.target_request_fingerprint IS DISTINCT FROM NEW.target_request_fingerprint
       OR OLD.exact_target_bytes IS DISTINCT FROM NEW.exact_target_bytes
       OR OLD.stage_idempotency_key IS DISTINCT FROM NEW.stage_idempotency_key
       OR OLD.stage_request_fingerprint IS DISTINCT FROM NEW.stage_request_fingerprint
       OR OLD.stage_hash IS DISTINCT FROM NEW.stage_hash
       OR OLD.exact_stage_bytes IS DISTINCT FROM NEW.exact_stage_bytes
       OR OLD.stage_receipt_hash IS DISTINCT FROM NEW.stage_receipt_hash
       OR OLD.exact_stage_receipt_bytes IS DISTINCT FROM NEW.exact_stage_receipt_bytes
       OR OLD.stage_committed_at IS DISTINCT FROM NEW.stage_committed_at
       OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'workflow runner authority binding immutable stage fields cannot change';
    END IF;
    IF OLD.resolution_idempotency_key IS NOT NULL AND (
       OLD.resolution_idempotency_key IS DISTINCT FROM NEW.resolution_idempotency_key
       OR OLD.resolution_request_fingerprint IS DISTINCT FROM NEW.resolution_request_fingerprint
       OR OLD.resolution_hash IS DISTINCT FROM NEW.resolution_hash
       OR OLD.exact_resolution_bytes IS DISTINCT FROM NEW.exact_resolution_bytes
       OR OLD.resolution_receipt_hash IS DISTINCT FROM NEW.resolution_receipt_hash
       OR OLD.exact_resolution_receipt_bytes IS DISTINCT FROM NEW.exact_resolution_receipt_bytes
       OR OLD.resolution_committed_at IS DISTINCT FROM NEW.resolution_committed_at
       OR OLD.source_plane IS DISTINCT FROM NEW.source_plane
       OR OLD.source_evidence_state IS DISTINCT FROM NEW.source_evidence_state
       OR OLD.source_expected_revision IS DISTINCT FROM NEW.source_expected_revision
       OR OLD.source_accepted_revision IS DISTINCT FROM NEW.source_accepted_revision
       OR OLD.source_expected_resume_generation IS DISTINCT FROM NEW.source_expected_resume_generation
       OR OLD.source_accepted_resume_generation IS DISTINCT FROM NEW.source_accepted_resume_generation
       OR OLD.source_request_hash IS DISTINCT FROM NEW.source_request_hash
       OR OLD.source_receipt_hash IS DISTINCT FROM NEW.source_receipt_hash
       OR OLD.source_record_hash IS DISTINCT FROM NEW.source_record_hash
       OR OLD.source_authority_build_hash IS DISTINCT FROM NEW.source_authority_build_hash) THEN
        RAISE EXCEPTION 'workflow runner authority binding immutable resolution fields cannot change';
    END IF;
    IF OLD.source_plane IS NOT NULL AND (
       OLD.source_plane IS DISTINCT FROM NEW.source_plane
       OR OLD.source_evidence_state IS DISTINCT FROM NEW.source_evidence_state
       OR OLD.source_expected_revision IS DISTINCT FROM NEW.source_expected_revision
       OR OLD.source_accepted_revision IS DISTINCT FROM NEW.source_accepted_revision
       OR OLD.source_expected_resume_generation IS DISTINCT FROM NEW.source_expected_resume_generation
       OR OLD.source_accepted_resume_generation IS DISTINCT FROM NEW.source_accepted_resume_generation
       OR OLD.source_request_hash IS DISTINCT FROM NEW.source_request_hash
       OR OLD.source_receipt_hash IS DISTINCT FROM NEW.source_receipt_hash
       OR OLD.source_record_hash IS DISTINCT FROM NEW.source_record_hash
       OR OLD.source_authority_build_hash IS DISTINCT FROM NEW.source_authority_build_hash) THEN
        RAISE EXCEPTION 'workflow runner authority binding source identity is append-once';
    END IF;
    IF OLD.exact_source_result_bytes IS NOT NULL AND (
       OLD.exact_source_result_bytes IS DISTINCT FROM NEW.exact_source_result_bytes
       OR OLD.source_result_hash IS DISTINCT FROM NEW.source_result_hash) THEN
        RAISE EXCEPTION 'workflow runner authority binding source result is append-once';
    END IF;
    IF OLD.reconciliation_id IS NOT NULL AND (
       OLD.reconciliation_id IS DISTINCT FROM NEW.reconciliation_id
       OR OLD.reconciliation_reason IS DISTINCT FROM NEW.reconciliation_reason
       OR NEW.state<>'reconciliation_required') THEN
        RAISE EXCEPTION 'workflow runner authority binding reconciliation is append-only';
    END IF;
    IF OLD.state='reconciliation_required' AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'workflow runner authority binding reconciliation row is frozen';
    END IF;
    IF OLD.state IS DISTINCT FROM NEW.state AND NOT (
       (OLD.state='staged' AND NEW.state IN ('resolved','reconciliation_required'))
       OR (OLD.state='resolved' AND NEW.state IN ('runner_committed','reconciliation_required'))
       OR (OLD.state='runner_committed' AND NEW.state IN ('completed','reconciliation_required'))
    ) THEN
        RAISE EXCEPTION 'workflow runner authority binding state transition is not monotonic';
    END IF;
    IF OLD.state IS DISTINCT FROM 'reconciliation_required'
       AND NEW.state='reconciliation_required'
       AND NOT (
           (OLD.state='staged' AND NEW.reconciliation_reason='stage_commit_unknown')
           OR (OLD.state='resolved' AND NEW.reconciliation_reason IN (
               'resolution_commit_unknown','source_outcome_unknown','runner_commit_unknown'
           ))
           OR (OLD.state='runner_committed' AND NEW.reconciliation_reason IN (
               'runner_commit_unknown','control_delivery_unknown'
           ))
           OR (OLD.state IN ('staged','resolved','runner_committed')
               AND NEW.reconciliation_reason IN (
                   'process_crash','cancelled_with_outstanding_authority',
                   'terminal_with_outstanding_authority'
               ))
       ) THEN
        RAISE EXCEPTION 'workflow runner authority reconciliation reason does not match its predecessor phase';
    END IF;
    IF OLD.state='resolved' AND NEW.state='runner_committed' THEN
        SELECT EXISTS (
            SELECT 1 FROM workflow_runner_worker_events e
            JOIN workflow_runner_v2_event_inbox i ON i.event_id=e.event_id
            WHERE e.event_id=NEW.target_event_id
              AND e.attempt_id=NEW.attempt_id
              AND e.lease_id=NEW.lease_id
              AND e.fencing_token=NEW.fencing_token
              AND e.sequence=NEW.target_sequence
              AND e.kind=NEW.target_kind
              AND e.idempotency_key=NEW.target_idempotency_key
              AND e.request_fingerprint=NEW.target_request_fingerprint
              AND e.message_digest=NEW.target_body_hash
              AND e.exact_event_bytes=NEW.exact_target_bytes
              AND i.state='runner_committed'
              AND i.authority_operation=NEW.operation
              AND i.exact_authority_receipt_bytes=NEW.exact_resolution_receipt_bytes
              AND i.authority_receipt_hash IS NOT NULL
        ) INTO exact_runner_event;
        SELECT EXISTS (
            SELECT 1 FROM workflow_runner_event_receipts r
            JOIN workflow_runner_v2_decision_bindings d ON d.received_event_id=r.received_event_id
            WHERE r.received_event_id=NEW.target_event_id
              AND r.status='accepted'
              AND r.reconciliation_id IS NULL
              AND d.receipt_control_event_id=r.receipt_event_id
        ) INTO exact_runner_receipt;
        IF NOT exact_runner_event OR NOT exact_runner_receipt THEN
            RAISE EXCEPTION 'workflow runner authority binding lacks exact durable runner event/receipt';
        END IF;
    END IF;
    IF OLD.state='runner_committed' AND NEW.state='completed' THEN
        SELECT count(*) FILTER (
                   WHERE companion_sequence=3 AND control_kind='event_receipt'
                     AND disposition='accepted'
               ),
               count(*) FILTER (
                   WHERE companion_sequence=4
                     AND control_kind IN ('effect_authorization','budget_authorization','resume_offer')
                     AND disposition='accepted'
               ),
               count(*) FILTER (WHERE companion_sequence=4 AND control_kind='cancel_request')
          INTO event_ack_count,decision_ack_count,cancel_ack_count
          FROM workflow_runner_authority_control_acks
         WHERE binding_id=NEW.binding_id;
        IF event_ack_count<>1 OR cancel_ack_count<>0
           OR (NEW.operation IN ('effect_authorize','budget_reserve','resume_advance')
               AND decision_ack_count<>1)
           OR (NEW.operation IN ('checkpoint_commit','effect_complete','budget_settle')
               AND decision_ack_count<>0) THEN
            RAISE EXCEPTION 'workflow runner authority binding cannot complete before its exact accepted ACK set';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION workflow_runner_authority_control_ack_insert()
RETURNS trigger AS $$
DECLARE
    ack_text TEXT;
    canonical_ack_text TEXT;
    ack_document JSONB;
    ack_key_count BIGINT;
    ack_committed_at TIMESTAMPTZ;
    ack_processed_at TIMESTAMPTZ;
    control_document JSONB;
    control_sent_at TIMESTAMPTZ;
    stored_attempt TEXT;
    stored_kind TEXT;
    stored_sequence BIGINT;
    stored_digest BYTEA;
    stored_exact BYTEA;
    stored_state TEXT;
    binding_attempt TEXT;
    binding_lease TEXT;
    binding_fence BIGINT;
    binding_operation TEXT;
    binding_build_hash BYTEA;
    binding_state TEXT;
    prior_binding TEXT;
    prior_kind TEXT;
    prior_companion BIGINT;
    received_event TEXT;
    paired_received_event TEXT;
    paired_receipt_control TEXT;
    paired_decision_control TEXT;
    cancel_control_event TEXT;
    received_status TEXT;
BEGIN
    IF NEW.ack_hash IS DISTINCT FROM sha256(NEW.exact_ack_bytes) THEN
        RAISE EXCEPTION USING
            ERRCODE='23514',
            CONSTRAINT='workflow_runner_authority_control_ack_hash_check',
            MESSAGE='workflow runner authority control ACK hash is invalid';
    END IF;
    BEGIN
        ack_text := convert_from(NEW.exact_ack_bytes,'UTF8');
        ack_document := ack_text::JSONB;
        IF jsonb_typeof(ack_document) IS DISTINCT FROM 'object'
           OR right(ack_text,1) IS DISTINCT FROM E'\n'
           OR position(E'\r' IN ack_text)<>0
           OR position(E'\n' IN left(ack_text,length(ack_text)-1))<>0 THEN
            RAISE EXCEPTION 'workflow runner authority control ACK exact bytes are not one canonical LF-terminated object';
        END IF;
        SELECT count(*) INTO ack_key_count FROM jsonb_object_keys(ack_document);
        IF ack_key_count<>21
           OR ack_document->'schema' IS DISTINCT FROM to_jsonb('openslack.workflow_runner_authority_binding_receipt.v1'::TEXT)
           OR ack_document->'contractVersion' IS DISTINCT FROM to_jsonb('openslack.workflow_runner_authority_binding.v1'::TEXT)
           OR ack_document->'profile' IS DISTINCT FROM to_jsonb('workflow-control-runner-v2-runtime-delivery-v1'::TEXT)
           OR ack_document->'direction' IS DISTINCT FROM to_jsonb('runner-to-control'::TEXT)
           OR ack_document->'phase' IS DISTINCT FROM to_jsonb('control_delivery'::TEXT)
           OR ack_document->'status' IS DISTINCT FROM to_jsonb('accepted'::TEXT)
           OR ack_document->'reconciliationToken' IS DISTINCT FROM 'null'::JSONB
           OR ack_document->>'committedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
           OR ack_document->>'processedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
            RAISE EXCEPTION 'workflow runner authority control ACK exact bytes have an open or invalid envelope';
        END IF;
        canonical_ack_text :=
            '{"bindingId":' || to_json(ack_document->>'bindingId')::TEXT ||
            ',"committedAt":' || to_json(ack_document->>'committedAt')::TEXT ||
            ',"companionSequence":' || to_json((ack_document->>'companionSequence')::BIGINT)::TEXT ||
            ',"contractVersion":' || to_json(ack_document->>'contractVersion')::TEXT ||
            ',"controlBuildHash":' || to_json(ack_document->>'controlBuildHash')::TEXT ||
            ',"controlEventId":' || to_json(ack_document->>'controlEventId')::TEXT ||
            ',"controlKind":' || to_json(ack_document->>'controlKind')::TEXT ||
            ',"controlSequence":' || to_json((ack_document->>'controlSequence')::BIGINT)::TEXT ||
            ',"direction":' || to_json(ack_document->>'direction')::TEXT ||
            ',"disposition":' || to_json(ack_document->>'disposition')::TEXT ||
            ',"fencingToken":' || to_json((ack_document->>'fencingToken')::BIGINT)::TEXT ||
            ',"leaseId":' || to_json(ack_document->>'leaseId')::TEXT ||
            ',"messageDigest":' || to_json(ack_document->>'messageDigest')::TEXT ||
            ',"operation":' || to_json(ack_document->>'operation')::TEXT ||
            ',"phase":' || to_json(ack_document->>'phase')::TEXT ||
            ',"processedAt":' || to_json(ack_document->>'processedAt')::TEXT ||
            ',"profile":' || to_json(ack_document->>'profile')::TEXT ||
            ',"reconciliationToken":null' ||
            ',"runnerAttemptId":' || to_json(ack_document->>'runnerAttemptId')::TEXT ||
            ',"schema":' || to_json(ack_document->>'schema')::TEXT ||
            ',"status":' || to_json(ack_document->>'status')::TEXT || E'}\n';
        IF ack_text IS DISTINCT FROM canonical_ack_text THEN
            RAISE EXCEPTION 'workflow runner authority control ACK exact bytes are not canonical';
        END IF;
        ack_committed_at := (ack_document->>'committedAt')::TIMESTAMPTZ;
        ack_processed_at := (ack_document->>'processedAt')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION USING
            ERRCODE='23514',
            CONSTRAINT='workflow_runner_authority_control_ack_bytes_check',
            MESSAGE='workflow runner authority control ACK exact bytes are invalid';
    END;
    SELECT c.attempt_id,c.kind,c.sequence,
           CASE WHEN c.kind='cancel_request' THEN vc.v2_message_digest ELSE c.message_digest END,
           CASE WHEN c.kind='cancel_request' THEN vc.exact_v2_message_bytes ELSE c.exact_message_bytes END,
           c.delivery_state,
           b.attempt_id,b.lease_id,b.fencing_token,b.operation,b.authority_build_hash,b.state
      INTO stored_attempt,stored_kind,stored_sequence,stored_digest,stored_exact,stored_state,
           binding_attempt,binding_lease,binding_fence,binding_operation,binding_build_hash,binding_state
      FROM workflow_runner_control_messages c
      LEFT JOIN workflow_runner_v2_cancel_bindings vc ON vc.control_event_id=c.control_event_id
      JOIN workflow_runner_authority_bindings b ON b.binding_id=NEW.binding_id
     WHERE c.control_event_id=NEW.control_event_id
     FOR SHARE OF c,b;
    IF NOT FOUND
       OR stored_attempt IS DISTINCT FROM NEW.attempt_id
       OR binding_attempt IS DISTINCT FROM NEW.attempt_id
       OR binding_lease IS DISTINCT FROM NEW.lease_id
       OR binding_fence IS DISTINCT FROM NEW.fencing_token
       OR stored_kind IS DISTINCT FROM NEW.control_kind
       OR stored_sequence IS DISTINCT FROM NEW.control_sequence
       OR stored_digest IS DISTINCT FROM NEW.message_digest
       OR stored_state IS DISTINCT FROM 'awaiting_ack'
       OR binding_state IS DISTINCT FROM 'runner_committed' THEN
        RAISE EXCEPTION 'workflow runner authority control ACK is cross-spliced';
    END IF;
    BEGIN
        control_document := convert_from(stored_exact,'UTF8')::JSONB;
        control_sent_at := (control_document->>'sentAt')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION USING
            ERRCODE='23514',
            CONSTRAINT='workflow_runner_authority_control_ack_bytes_check',
            MESSAGE='workflow runner authority control ACK predecessor bytes are invalid';
    END;
    IF ack_document->'bindingId' IS DISTINCT FROM to_jsonb(NEW.binding_id)
       OR ack_document->'operation' IS DISTINCT FROM to_jsonb(binding_operation)
       OR ack_document->'controlBuildHash' IS DISTINCT FROM to_jsonb(encode(binding_build_hash,'hex'))
       OR ack_document->'controlEventId' IS DISTINCT FROM to_jsonb(NEW.control_event_id)
       OR ack_document->'controlKind' IS DISTINCT FROM to_jsonb(NEW.control_kind)
       OR ack_document->'controlSequence' IS DISTINCT FROM to_jsonb(NEW.control_sequence)
       OR ack_document->'companionSequence' IS DISTINCT FROM to_jsonb(NEW.companion_sequence)
       OR ack_document->'messageDigest' IS DISTINCT FROM to_jsonb(encode(NEW.message_digest,'hex'))
       OR ack_document->'runnerAttemptId' IS DISTINCT FROM to_jsonb(NEW.attempt_id)
       OR ack_document->'leaseId' IS DISTINCT FROM to_jsonb(NEW.lease_id)
       OR ack_document->'fencingToken' IS DISTINCT FROM to_jsonb(NEW.fencing_token)
       OR ack_document->'disposition' IS DISTINCT FROM to_jsonb(NEW.disposition)
       OR ack_processed_at IS DISTINCT FROM NEW.processed_at
       OR ack_processed_at IS DISTINCT FROM ack_committed_at
       OR ack_committed_at<control_sent_at
       OR control_document->'eventId' IS DISTINCT FROM ack_document->'controlEventId'
       OR control_document->'kind' IS DISTINCT FROM ack_document->'controlKind'
       OR control_document->'sequence' IS DISTINCT FROM ack_document->'controlSequence'
       OR control_document->'attemptId' IS DISTINCT FROM ack_document->'runnerAttemptId'
       OR control_document->'leaseId' IS DISTINCT FROM ack_document->'leaseId'
       OR control_document->'fencingToken' IS DISTINCT FROM ack_document->'fencingToken'
       OR control_document->'authorityBuildHash' IS DISTINCT FROM ack_document->'controlBuildHash' THEN
        RAISE EXCEPTION USING
            ERRCODE='23514',
            CONSTRAINT='workflow_runner_authority_control_ack_bytes_check',
            MESSAGE='workflow runner authority control ACK exact bytes are cross-spliced';
    END IF;
    IF NEW.companion_sequence=4 THEN
        SELECT binding_id,control_kind,companion_sequence
          INTO prior_binding,prior_kind,prior_companion
          FROM workflow_runner_authority_control_acks
         WHERE control_event_id=NEW.prior_control_event_id;
        IF NOT FOUND OR prior_binding IS DISTINCT FROM NEW.binding_id
           OR prior_kind IS DISTINCT FROM 'event_receipt'
           OR prior_companion IS DISTINCT FROM 3 THEN
            RAISE EXCEPTION 'workflow runner authority decision ACK predecessor is invalid';
        END IF;
        IF NEW.control_kind='cancel_request' THEN
            SELECT vb.control_event_id INTO cancel_control_event
              FROM workflow_runner_v2_cancel_bindings vb
              JOIN workflow_runner_cancel_controls cc ON cc.cancel_id=vb.cancel_id
              JOIN workflow_runner_authority_bindings ab ON ab.binding_id=NEW.binding_id
             WHERE vb.control_event_id=NEW.control_event_id AND vb.attempt_id=NEW.attempt_id
               AND vb.authority_backend=ab.authority_backend
               AND vb.workflow_authority=ab.workflow_authority
               AND vb.routing_epoch=ab.routing_epoch
               AND vb.authority_build_hash=ab.authority_build_hash
               AND vb.run_revision=ab.accepted_run_revision
               AND vb.resume_generation=ab.accepted_resume_generation
               AND cc.attempt_id=ab.attempt_id AND cc.lease_id=ab.lease_id
               AND cc.fencing_token=ab.fencing_token;
            IF NOT FOUND OR cancel_control_event IS DISTINCT FROM NEW.control_event_id THEN
                RAISE EXCEPTION 'workflow runner authority cancel ACK is cross-spliced';
            END IF;
        ELSE
            IF NEW.control_kind IS DISTINCT FROM (CASE binding_operation
                WHEN 'effect_authorize' THEN 'effect_authorization'
                WHEN 'budget_reserve' THEN 'budget_authorization'
                WHEN 'resume_advance' THEN 'resume_offer'
                ELSE NULL
            END) THEN
                RAISE EXCEPTION 'workflow runner authority decision ACK kind is invalid';
            END IF;
            SELECT received_event_id,receipt_control_event_id,decision_control_event_id
              INTO paired_received_event,paired_receipt_control,paired_decision_control
              FROM workflow_runner_v2_decision_bindings
             WHERE decision_control_event_id=NEW.control_event_id;
            IF NOT FOUND OR paired_received_event IS DISTINCT FROM (
                    SELECT target_event_id FROM workflow_runner_authority_bindings WHERE binding_id=NEW.binding_id
               ) OR paired_receipt_control IS DISTINCT FROM NEW.prior_control_event_id
                 OR paired_decision_control IS DISTINCT FROM NEW.control_event_id THEN
                RAISE EXCEPTION 'workflow runner authority decision ACK is cross-spliced';
            END IF;
        END IF;
    ELSE
        SELECT received_event_id,status INTO received_event,received_status
          FROM workflow_runner_event_receipts
         WHERE receipt_event_id=NEW.control_event_id;
        IF NOT FOUND OR received_event IS DISTINCT FROM (
                SELECT target_event_id FROM workflow_runner_authority_bindings WHERE binding_id=NEW.binding_id
           ) OR received_status IS DISTINCT FROM NEW.disposition THEN
            RAISE EXCEPTION 'workflow runner authority event-receipt ACK is cross-spliced';
        END IF;
    END IF;
    UPDATE workflow_runner_control_messages
       SET delivery_state='delivered',delivered_at=NEW.processed_at
     WHERE control_event_id=NEW.control_event_id AND delivery_state='awaiting_ack';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'workflow runner authority ACK could not finalize exact control delivery';
    END IF;
    IF NEW.control_kind='cancel_request' THEN
        UPDATE workflow_runner_cancel_controls
           SET state='sent'
         WHERE control_event_id=NEW.control_event_id AND state='pending';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'workflow runner authority cancel ACK could not finalize exact cancel delivery';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_runner_authority_bindings_transition
BEFORE UPDATE ON workflow_runner_authority_bindings
FOR EACH ROW EXECUTE FUNCTION workflow_runner_authority_binding_transition();
CREATE TRIGGER workflow_runner_authority_bindings_no_delete
BEFORE DELETE ON workflow_runner_authority_bindings
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_runner_authority_control_acks_insert
BEFORE INSERT ON workflow_runner_authority_control_acks
FOR EACH ROW EXECUTE FUNCTION workflow_runner_authority_control_ack_insert();
CREATE TRIGGER workflow_runner_authority_control_acks_immutable
BEFORE UPDATE OR DELETE ON workflow_runner_authority_control_acks
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();
CREATE TRIGGER workflow_runner_authority_reconciliations_immutable
BEFORE UPDATE OR DELETE ON workflow_runner_authority_reconciliations
FOR EACH ROW EXECUTE FUNCTION workflow_runner_reject_immutable_mutation();

CREATE INDEX workflow_runner_authority_bindings_recovery_idx
    ON workflow_runner_authority_bindings(state,created_at,binding_id);
CREATE INDEX workflow_runner_authority_bindings_attempt_idx
    ON workflow_runner_authority_bindings(attempt_id,state,target_sequence);
CREATE INDEX workflow_runner_authority_control_acks_binding_idx
    ON workflow_runner_authority_control_acks(binding_id,control_sequence);
CREATE INDEX workflow_runner_authority_reconciliations_job_idx
    ON workflow_runner_authority_reconciliations(workspace_id,job_id,created_at);

COMMIT;
