package postgres

const (
	receiptSelectByKeySQL = `
SELECT receipt_id, operation, status, scenario_instance_id, idempotency_key,
       request_fingerprint, previous_cursor, cursor, revision,
       snapshot_integrity_hash, delta_integrity_hash, committed_at,
       reconciliation_token, recorded_at
FROM graph_ingest_receipts
WHERE idempotency_key = $1`

	receiptSelectScopedSQL = `
SELECT receipt_id, operation, status, scenario_instance_id, idempotency_key,
       request_fingerprint, previous_cursor, cursor, revision,
       snapshot_integrity_hash, delta_integrity_hash, committed_at,
       reconciliation_token, recorded_at
FROM graph_ingest_receipts
WHERE scenario_instance_id = $1 AND idempotency_key = $2`

	headForUpdateSQL = `
SELECT cursor, revision, snapshot_integrity_hash
FROM graph_heads
WHERE scenario_instance_id = $1
FOR UPDATE`

	snapshotInsertSQL = `
INSERT INTO graph_snapshots (
    scenario_instance_id, cursor, revision, canonical_bytes, integrity_hash,
    projector_version, generated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)`

	deltaInsertSQL = `
INSERT INTO graph_deltas (
    scenario_instance_id, from_cursor, to_cursor, revision, canonical_bytes,
    integrity_hash, generated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)`

	headInsertSQL = `
INSERT INTO graph_heads (
    scenario_instance_id, cursor, revision, snapshot_integrity_hash
) VALUES ($1, $2, $3, $4)`

	headUpdateCASSQL = `
UPDATE graph_heads
SET cursor = $4,
    revision = $5,
    snapshot_integrity_hash = $6,
    updated_at = clock_timestamp()
WHERE scenario_instance_id = $1
  AND cursor = $2
  AND revision = $3`

	receiptInsertAcceptedSQL = `
INSERT INTO graph_ingest_receipts (
    receipt_id, operation, status, scenario_instance_id, idempotency_key,
    request_fingerprint, previous_cursor, cursor, revision,
    snapshot_integrity_hash, delta_integrity_hash, committed_at
) VALUES (
    $1, $2, 'accepted', $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp()
)
RETURNING committed_at, recorded_at`

	receiptInsertReconciliationSQL = `
INSERT INTO graph_ingest_receipts (
    receipt_id, operation, status, scenario_instance_id, idempotency_key,
    request_fingerprint, previous_cursor, cursor, revision,
    snapshot_integrity_hash, delta_integrity_hash, committed_at,
    reconciliation_token
) VALUES (
    $1, $2, 'reconciliation_required', $3, $4, $5, $6, $7, $8,
    $9, $10, NULL, $11
)
ON CONFLICT (idempotency_key) DO NOTHING`

	snapshotSelectSQL = `
SELECT scenario_instance_id, cursor, revision, canonical_bytes, integrity_hash,
       projector_version, generated_at, stored_at
FROM graph_snapshots
WHERE scenario_instance_id = $1 AND cursor = $2`

	deltaSelectSQL = `
SELECT scenario_instance_id, from_cursor, to_cursor, revision, canonical_bytes,
       integrity_hash, generated_at, stored_at
FROM graph_deltas
WHERE scenario_instance_id = $1 AND from_cursor = $2 AND to_cursor = $3`

	currentSelectSQL = `
SELECT h.scenario_instance_id, h.cursor, h.revision, h.snapshot_integrity_hash,
       h.updated_at, s.canonical_bytes, s.revision, s.stored_at
FROM graph_heads AS h
JOIN graph_snapshots AS s
  ON s.scenario_instance_id = h.scenario_instance_id
 AND s.cursor = h.cursor
WHERE h.scenario_instance_id = $1`

	headListSQL = `
SELECT h.scenario_instance_id, h.cursor, h.revision, h.snapshot_integrity_hash,
       s.canonical_bytes, s.revision, h.updated_at
FROM graph_heads AS h
JOIN graph_snapshots AS s
  ON s.scenario_instance_id = h.scenario_instance_id
 AND s.cursor = h.cursor
ORDER BY h.scenario_instance_id ASC
LIMIT $1`

	snapshotListSQL = `
SELECT scenario_instance_id, cursor, revision, canonical_bytes, integrity_hash,
       projector_version, generated_at, stored_at
FROM graph_snapshots
WHERE scenario_instance_id = $1 AND revision > $2
ORDER BY revision ASC
LIMIT $3`

	deltaListSQL = `
SELECT scenario_instance_id, from_cursor, to_cursor, revision, canonical_bytes,
       integrity_hash, generated_at, stored_at
FROM graph_deltas
WHERE scenario_instance_id = $1 AND revision > $2
ORDER BY revision ASC
LIMIT $3`

	statisticsSelectSQL = `
SELECT
    (SELECT count(*) FROM graph_heads),
    (SELECT COALESCE(max(revision), 0) FROM graph_heads),
    (
        SELECT count(*)
        FROM graph_ingest_receipts
        WHERE status = 'reconciliation_required'
    )`
)
