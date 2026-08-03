package postgres

const (
	receiptByKeySQL = `
SELECT receipt_id, operation, status, parity, idempotency_key, request_fingerprint,
       workspace_id, run_id, source_sequence, observation_digest,
       observation_hash, mismatch_code, committed_at, reconciliation_token, recorded_at
FROM workflow_control_shadow_receipts
WHERE idempotency_key = $1`

	headForUpdateSQL = `
SELECT source_sequence, matched_source_sequence, matched_observation_id,
       matched_observation_hash, matched_status, matched_envelope_bytes
FROM workflow_control_shadow_heads
WHERE workspace_id = $1 AND run_id = $2
FOR UPDATE`

	observationInsertSQL = `
INSERT INTO workflow_control_shadow_observations (
    observation_id, workspace_id, run_id, source_sequence, parity,
    mismatch_code, status, canonical_envelope_bytes, body_digest,
    observation_hash, projection_bytes
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
RETURNING recorded_at`

	headInsertSQL = `
INSERT INTO workflow_control_shadow_heads (
    workspace_id, run_id, source_sequence, matched_source_sequence,
    matched_observation_id, matched_observation_hash, matched_status,
    matched_envelope_bytes
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`

	headUpdateSQL = `
UPDATE workflow_control_shadow_heads
SET source_sequence = $4,
    matched_source_sequence = $5,
    matched_observation_id = $6,
    matched_observation_hash = $7,
    matched_status = $8,
    matched_envelope_bytes = $9,
    updated_at = clock_timestamp()
WHERE workspace_id = $1 AND run_id = $2 AND source_sequence = $3`

	receiptAcceptedInsertSQL = `
INSERT INTO workflow_control_shadow_receipts (
    receipt_id, operation, status, parity, idempotency_key,
    request_fingerprint, workspace_id, run_id, source_sequence,
    observation_digest, observation_hash, observation_id, mismatch_code,
    committed_at
) VALUES ($1,'observation_ingest','accepted',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())
RETURNING committed_at, recorded_at`

	receiptReconciliationInsertSQL = `
INSERT INTO workflow_control_shadow_receipts (
    receipt_id, operation, status, parity, idempotency_key,
    request_fingerprint, workspace_id, run_id, source_sequence,
    observation_digest, observation_hash, mismatch_code,
    reconciliation_token
) VALUES ($1,'observation_ingest','reconciliation_required','unknown',$2,$3,$4,$5,$6,$7,NULL,NULL,$8)
ON CONFLICT (idempotency_key) DO NOTHING`

	projectionSnapshotSQL = `
SELECT
    head.source_sequence,
    head.matched_source_sequence,
    head.matched_observation_hash,
    head.matched_envelope_bytes,
    counts.matched_observations,
    counts.mismatched_observations
FROM workflow_control_shadow_heads AS head
CROSS JOIN LATERAL (
  SELECT
      count(*) FILTER (WHERE parity = 'matched') AS matched_observations,
      count(*) FILTER (WHERE parity = 'mismatched') AS mismatched_observations
  FROM workflow_control_shadow_observations
  WHERE workspace_id = head.workspace_id AND run_id = head.run_id
) AS counts
WHERE head.workspace_id = $1 AND head.run_id = $2`

	statisticsSQL = `
SELECT
    (SELECT count(*) FROM workflow_control_shadow_heads),
    (SELECT COALESCE(max(source_sequence),0) FROM workflow_control_shadow_heads),
    (SELECT count(*) FROM workflow_control_shadow_observations WHERE parity='matched'),
    (SELECT count(*) FROM workflow_control_shadow_observations WHERE parity='mismatched'),
    (SELECT count(*) FROM workflow_control_shadow_receipts WHERE status='reconciliation_required')`
)
