package postgres

const (
	receiptByKeySQL = `
SELECT receipt_id, operation, status, idempotency_key, request_fingerprint,
       request_hash, workspace_id, run_id, expected_revision, accepted_revision,
       resume_generation, backend, authority, routing_epoch, authority_build_hash,
       record_hash, correlation_id, service_build_hash, committed_at,
       reconciliation_token, exact_receipt_bytes, recorded_at
FROM workflow_control_transition_receipts
WHERE idempotency_key=$1`

	receiptByWorkspaceKeySQL = receiptByKeySQL + ` AND workspace_id=$2`

	headForUpdateSQL = `
SELECT workflow_id, workflow_version, workflow_source_hash, manifest_hash, input_hash,
       backend, authority, routing_epoch, authority_build_hash,
       state, revision, current_phase_id, current_phase_index, resume_generation,
       record_hash, canonical_record_bytes, updated_at
FROM workflow_control_runs
WHERE workspace_id=$1 AND run_id=$2
FOR UPDATE`

	epochInsertSQL = `
INSERT INTO workflow_control_authority_epochs (
    workspace_id, routing_epoch, backend, authority, authority_build_hash
) VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (workspace_id, routing_epoch) DO NOTHING`

	epochReadSQL = `
SELECT backend, authority, authority_build_hash
FROM workflow_control_authority_epochs
WHERE workspace_id=$1 AND routing_epoch=$2`

	runInsertSQL = `
INSERT INTO workflow_control_runs (
    workspace_id, run_id, workflow_id, workflow_version, workflow_source_hash,
    manifest_hash, input_hash, backend, authority, routing_epoch,
    authority_build_hash, state, revision, current_phase_id, current_phase_index,
    resume_generation, record_hash, canonical_record_bytes, updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`

	runCASUpdateSQL = `
UPDATE workflow_control_runs
SET state=$17, revision=$18, current_phase_id=$19, current_phase_index=$20,
    resume_generation=$21, record_hash=$22, canonical_record_bytes=$23,
    updated_at=$24
WHERE workspace_id=$1 AND run_id=$2
  AND workflow_id=$3 AND workflow_version=$4
  AND workflow_source_hash=$5 AND manifest_hash=$6 AND input_hash=$7
  AND backend=$8 AND authority=$9 AND routing_epoch=$10 AND authority_build_hash=$11
  AND revision=$12 AND state=$13
  AND current_phase_id IS NOT DISTINCT FROM $14
  AND current_phase_index IS NOT DISTINCT FROM $15
  AND resume_generation=$16`

	eventInsertSQL = `
INSERT INTO workflow_control_transition_events (
    event_id, receipt_id, workspace_id, run_id, from_revision, to_revision,
    from_state, to_state, from_phase_id, from_phase_index, to_phase_id,
    to_phase_index, from_resume_generation, to_resume_generation, backend,
    authority, routing_epoch, authority_build_hash, request_hash, record_hash,
    correlation_id, canonical_record_bytes
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`

	receiptAcceptedInsertSQL = `
INSERT INTO workflow_control_transition_receipts (
    receipt_id, operation, status, idempotency_key, request_fingerprint,
    request_hash, workspace_id, run_id, expected_revision, accepted_revision,
    resume_generation, backend, authority, routing_epoch, authority_build_hash,
    record_hash, correlation_id, service_build_hash, committed_at,
    exact_receipt_bytes
) VALUES ($1,'run_transition','accepted',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
RETURNING recorded_at`

	receiptReconciliationInsertSQL = `
INSERT INTO workflow_control_transition_receipts (
    receipt_id, operation, status, idempotency_key, request_fingerprint,
    request_hash, workspace_id, run_id, expected_revision, accepted_revision,
    resume_generation, backend, authority, routing_epoch, authority_build_hash,
    record_hash, correlation_id, service_build_hash, committed_at,
    reconciliation_token, exact_receipt_bytes
) VALUES ($1,'run_transition','reconciliation_required',$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,NULL,$13,$14,NULL,$15,$16)
ON CONFLICT (idempotency_key) DO NOTHING`

	outboxInsertSQL = `
INSERT INTO workflow_control_outbox (
    outbox_id, event_id, workspace_id, run_id, run_revision, event_type,
    idempotency_key, payload_hash, canonical_payload_bytes
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`

	reconciliationInsertSQL = `
INSERT INTO workflow_control_reconciliations (
    reconciliation_token, receipt_id, idempotency_key, request_fingerprint,
    request_hash, evidence_hash, workspace_id, run_id, expected_revision,
    expected_state, expected_phase_id, expected_phase_index,
    expected_resume_generation, target_revision, target_state, target_phase_id,
    target_phase_index, target_resume_generation, backend, authority,
    routing_epoch, authority_build_hash, requested_record_hash
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`

	openReconciliationSQL = `
SELECT EXISTS (
    SELECT 1 FROM workflow_control_reconciliations
    WHERE workspace_id=$1 AND run_id=$2 AND status='open'
)`

	readSQL = `
SELECT workflow_id, workflow_version, encode(workflow_source_hash,'hex'),
       encode(manifest_hash,'hex'), encode(input_hash,'hex'), backend, authority,
       routing_epoch, encode(authority_build_hash,'hex'), state, revision,
       current_phase_id, current_phase_index, resume_generation,
       encode(record_hash,'hex'), canonical_record_bytes, updated_at
FROM workflow_control_runs
WHERE workspace_id=$1 AND run_id=$2`

	outboxReadSQL = `
SELECT outbox_id, event_id, workspace_id, run_id, run_revision, event_type,
       status, idempotency_key, encode(payload_hash,'hex'),
       canonical_payload_bytes, attempt_count, created_at
FROM workflow_control_outbox
WHERE workspace_id=$1 AND run_id=$2 AND run_revision=$3`

	readinessSQL = `SELECT 1`

	statisticsSQL = `
SELECT
    (SELECT count(*) FROM workflow_control_runs),
    (SELECT count(*) FROM workflow_control_transition_receipts),
    (SELECT count(*) FROM workflow_control_transition_events),
    (SELECT count(*) FROM workflow_control_outbox WHERE status='pending'),
    (SELECT count(*) FROM workflow_control_reconciliations WHERE status='open')`
)
