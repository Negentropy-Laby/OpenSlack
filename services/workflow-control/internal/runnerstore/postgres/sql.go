package postgres

const (
	jobReceiptByKeySQL = `
SELECT request_fingerprint, exact_receipt_bytes
FROM workflow_runner_job_receipts
WHERE idempotency_key=$1`

	jobInsertSQL = `
INSERT INTO workflow_runner_jobs (
    workspace_id, job_id, workflow_run_id, correlation_id,
    execution_descriptor_ref, execution_descriptor_hash, job_spec_hash, exact_spec_bytes,
    workflow_id, workflow_version, workflow_source_hash, manifest_hash, input_hash,
    whole_deadline, state, revision, created_at, updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',1,$15,$15)`

	jobReceiptInsertSQL = `
INSERT INTO workflow_runner_job_receipts (
    receipt_id, operation, status, workspace_id, job_id, idempotency_key,
    request_fingerprint, job_spec_hash, exact_receipt_bytes, reconciliation_id, committed_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`

	claimJobSQL = `
SELECT workspace_id, job_id, workflow_run_id, correlation_id,
       execution_descriptor_ref, execution_descriptor_hash, job_spec_hash,
	       workflow_id, workflow_version, workflow_source_hash, manifest_hash, input_hash,
	       whole_deadline, revision, current_fence,
	       required_protocol_version, required_capabilities,
	       authority_backend, workflow_authority, routing_epoch,
	       authority_build_hash, required_run_revision, required_resume_generation
	FROM workflow_runner_jobs j
	WHERE workspace_id=$1 AND state='queued' AND dispatch_state <> 'dead'
	  AND dispatch_not_before <= $2 AND whole_deadline > $2
	  AND required_protocol_version = ANY($3::TEXT[])
	  AND (required_protocol_version <> 'openslack.workflow_runner.v2'
	       OR ($4::BOOLEAN AND authority_backend='go' AND workflow_authority='workflow-control')
	       OR (NOT $4::BOOLEAN AND authority_backend='ts-local' AND workflow_authority='typescript'))
ORDER BY created_at, workspace_id, job_id
FOR UPDATE SKIP LOCKED
LIMIT 1`

	attemptOrdinalSQL = `
SELECT COALESCE(MAX(ordinal),0)+1
FROM workflow_runner_attempts
WHERE workspace_id=$1 AND job_id=$2`

	attemptInsertSQL = `
INSERT INTO workflow_runner_attempts (
    attempt_id, workspace_id, job_id, ordinal, supervisor_instance_id, state,
    fencing_token, worker_sequence, control_sequence, execution_started,
    open_effect_count, offered_at, created_at, updated_at
) VALUES ($1,$2,$3,$4,$5,'offered',$6,0,1,FALSE,0,$7,$7,$7)`

	leaseInsertSQL = `
INSERT INTO workflow_runner_leases (
    lease_id, attempt_id, workspace_id, job_id, fencing_token, state,
    offer_expires_at, lease_expires_at, created_at, updated_at
) VALUES ($1,$2,$3,$4,$5,'offered',$6,$7,$8,$8)`

	controlInsertSQL = `
INSERT INTO workflow_runner_control_messages (
    control_event_id, attempt_id, kind, sequence, exact_message_bytes,
    message_digest, delivery_state, created_at
) VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`

	claimJobUpdateSQL = `
UPDATE workflow_runner_jobs
SET state='offered', revision=revision+1, current_fence=$1,
    current_attempt_id=$2, updated_at=$3
WHERE workspace_id=$4 AND job_id=$5 AND revision=$6 AND state='queued'`

	eventReceiptByKeySQL = `
SELECT e.request_fingerprint, r.exact_receipt_bytes,
       j.state, a.state
FROM workflow_runner_worker_events e
JOIN workflow_runner_event_receipts r ON r.received_event_id=e.event_id
JOIN workflow_runner_attempts a ON a.attempt_id=e.attempt_id
JOIN workflow_runner_jobs j ON j.workspace_id=e.workspace_id AND j.job_id=e.job_id
WHERE e.idempotency_key=$1`

	activeAttemptForUpdateSQL = `
SELECT j.state, j.revision, j.current_fence, j.current_attempt_id,
       a.state, a.worker_sequence, a.control_sequence,
       a.execution_started, a.open_effect_count,
       l.state, l.offer_expires_at, l.lease_expires_at,
       j.dispatch_failures, j.terminal_status, j.terminal_reason,
       j.result_hash, j.reconciliation_id
FROM workflow_runner_jobs j
JOIN workflow_runner_attempts a ON a.attempt_id=j.current_attempt_id
JOIN workflow_runner_leases l ON l.attempt_id=a.attempt_id
WHERE j.workspace_id=$1 AND j.job_id=$2
FOR UPDATE OF j,a,l`

	workerEventInsertSQL = `
INSERT INTO workflow_runner_worker_events (
    event_id, workspace_id, job_id, attempt_id, lease_id, fencing_token,
    sequence, kind, idempotency_key, request_fingerprint, message_digest,
    exact_event_bytes, recorded_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`

	eventReceiptInsertSQL = `
INSERT INTO workflow_runner_event_receipts (
    receipt_event_id, received_event_id, status, exact_receipt_bytes,
    receipt_digest, reconciliation_id, committed_at
) VALUES ($1,$2,$3,$4,$5,$6,$7)`

	attemptUpdateSQL = `
UPDATE workflow_runner_attempts
SET state=$1, worker_sequence=$2, control_sequence=$3,
    execution_started=$4, open_effect_count=$5,
    accepted_at=COALESCE(accepted_at,$6),
    started_at=COALESCE(started_at,$7),
    finished_at=COALESCE(finished_at,$8), updated_at=$9
WHERE attempt_id=$10 AND worker_sequence=$11 AND control_sequence=$12`

	leaseUpdateSQL = `
UPDATE workflow_runner_leases
SET state=$1, last_heartbeat_at=COALESCE($2,last_heartbeat_at), updated_at=$3
WHERE lease_id=$4 AND fencing_token=$5`

	jobEventUpdateSQL = `
UPDATE workflow_runner_jobs
SET state=$1, revision=revision+1, terminal_status=$2,
    terminal_reason=$3, result_hash=$4, reconciliation_id=$5, updated_at=$6
WHERE workspace_id=$7 AND job_id=$8 AND revision=$9`

	jobViewSQL = `
SELECT j.workspace_id, j.job_id, j.workflow_run_id, j.correlation_id,
       j.state, j.revision, j.current_fence, j.current_attempt_id,
       a.lease_id, a.state, a.lease_expires_at,
       j.terminal_status, j.terminal_reason, j.result_hash,
       COALESCE(a.open_effect_count,0), j.reconciliation_id, r.code,
       COALESCE(a.execution_started,FALSE), j.created_at, j.updated_at
FROM workflow_runner_jobs j
LEFT JOIN (
    SELECT a.attempt_id, l.lease_id, a.state, l.lease_expires_at,
           a.open_effect_count, a.execution_started
    FROM workflow_runner_attempts a
    LEFT JOIN workflow_runner_leases l ON l.attempt_id=a.attempt_id
) a ON a.attempt_id=j.current_attempt_id
LEFT JOIN workflow_runner_reconciliations r ON r.reconciliation_id=j.reconciliation_id
WHERE j.workspace_id=$1 AND j.job_id=$2`

	statisticsSQL = `
SELECT
    (SELECT count(*) FROM workflow_runner_jobs WHERE state='queued'),
    (SELECT count(*) FROM workflow_runner_leases WHERE state IN ('offered','active','cancelling')),
    (SELECT count(*) FROM workflow_runner_leases WHERE state='expired'),
    (SELECT count(*) FROM workflow_runner_attempts WHERE ordinal > 1),
    0::BIGINT,
    (SELECT count(*) FROM workflow_runner_attempts WHERE process_exit_class='crashed'),
    (SELECT count(*) FROM workflow_runner_attempts WHERE process_exit_class='forced'),
    (SELECT count(*) FROM workflow_runner_jobs WHERE state='reconciliation_required')`
)
