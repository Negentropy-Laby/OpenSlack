package postgres

const (
	receiptByKeySQL = `
SELECT receipt_id, operation, status, parity, idempotency_key, request_fingerprint,
       workspace_id, plan_id, source_sequence, observation_kind,
       observation_digest, mismatch_code, committed_at, reconciliation_token, recorded_at
FROM governance_shadow_receipts
WHERE idempotency_key = $1`

	headForUpdateSQL = `
SELECT source_sequence, matched_record_revision, matched_record_hash, matched_state
FROM governance_shadow_heads
WHERE workspace_id = $1 AND plan_id = $2
FOR UPDATE`

	recordVersionSQL = `
SELECT canonical_record_bytes
FROM governance_shadow_record_versions
WHERE workspace_id = $1 AND plan_id = $2 AND revision = $3`

	observationInsertSQL = `
INSERT INTO governance_shadow_observations (
    observation_id, workspace_id, plan_id, source_sequence, kind, parity,
    mismatch_code, record_revision, record_hash, canonical_bytes,
    body_digest, projection_bytes
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
RETURNING recorded_at`

	recordVersionInsertSQL = `
INSERT INTO governance_shadow_record_versions (
    workspace_id, plan_id, revision, observation_id, state,
    record_hash, canonical_record_bytes
) VALUES ($1,$2,$3,$4,$5,$6,$7)`

	headInsertSQL = `
INSERT INTO governance_shadow_heads (
    workspace_id, plan_id, source_sequence,
    matched_record_revision, matched_record_hash, matched_state
) VALUES ($1,$2,$3,$4,$5,$6)`

	headUpdateSQL = `
UPDATE governance_shadow_heads
SET source_sequence = $4,
    matched_record_revision = $5,
    matched_record_hash = $6,
    matched_state = $7,
    updated_at = clock_timestamp()
WHERE workspace_id = $1 AND plan_id = $2 AND source_sequence = $3`

	receiptAcceptedInsertSQL = `
INSERT INTO governance_shadow_receipts (
    receipt_id, operation, status, parity, idempotency_key,
    request_fingerprint, workspace_id, plan_id, source_sequence,
    observation_kind, observation_digest, observation_id, mismatch_code,
    committed_at
) VALUES ($1,'observation_ingest','accepted',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())
RETURNING committed_at, recorded_at`

	receiptReconciliationInsertSQL = `
INSERT INTO governance_shadow_receipts (
    receipt_id, operation, status, parity, idempotency_key,
    request_fingerprint, workspace_id, plan_id, source_sequence,
    observation_kind, observation_digest, mismatch_code,
    reconciliation_token
) VALUES ($1,'observation_ingest','reconciliation_required','unknown',$2,$3,$4,$5,$6,$7,$8,NULL,$9)
ON CONFLICT (idempotency_key) DO NOTHING`

	projectionHeadSQL = `
SELECT source_sequence, matched_record_revision
FROM governance_shadow_heads
WHERE workspace_id = $1 AND plan_id = $2`

	projectionCountsSQL = `
SELECT
    count(*) FILTER (WHERE parity = 'matched'),
    count(*) FILTER (WHERE parity = 'mismatched'),
    count(*) FILTER (WHERE kind = 'confirmation' AND parity = 'matched'),
    count(*) FILTER (WHERE kind = 'confirmation' AND parity = 'mismatched'),
    count(*) FILTER (WHERE kind = 'audit' AND parity = 'matched'),
    count(*) FILTER (WHERE kind = 'audit' AND parity = 'mismatched')
FROM governance_shadow_observations
WHERE workspace_id = $1 AND plan_id = $2`

	statisticsSQL = `
SELECT
    (SELECT count(*) FROM governance_shadow_heads),
    (SELECT COALESCE(max(source_sequence),0) FROM governance_shadow_heads),
    (SELECT count(*) FROM governance_shadow_observations WHERE parity='matched'),
    (SELECT count(*) FROM governance_shadow_observations WHERE parity='mismatched'),
    (SELECT count(*) FROM governance_shadow_receipts WHERE status='reconciliation_required')`
)
