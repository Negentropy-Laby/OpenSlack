package postgres

const (
	receiptByKeySQL = `
SELECT receipt_id, operation, status, idempotency_key, request_fingerprint,
       workspace_id, plan_id, expected_revision, accepted_revision, accepted_state,
       target_revision, target_state, backend, authority, routing_epoch,
       record_hash, correlation_id, caller_id, execution_id, service_build_sha,
       canonical_record_bytes, committed_at, reconciliation_token, recorded_at
FROM governance_authority_receipts
WHERE idempotency_key = $1`

	receiptByWorkspaceKeySQL = receiptByKeySQL + ` AND workspace_id = $2`

	headForUpdateSQL = `
SELECT route.backend, route.authority, route.routing_epoch,
       head.revision, head.state, head.record_hash,
       version.canonical_record_bytes
FROM governance_authority_routes AS route
JOIN governance_authority_heads AS head
  ON head.workspace_id = route.workspace_id AND head.plan_id = route.plan_id
JOIN governance_authority_record_versions AS version
  ON version.workspace_id = head.workspace_id AND version.plan_id = head.plan_id
 AND version.revision = head.revision
WHERE route.workspace_id = $1 AND route.plan_id = $2
FOR UPDATE OF head`

	routeInsertSQL = `
INSERT INTO governance_authority_routes (
    workspace_id, plan_id, backend, authority, routing_epoch
) VALUES ($1,$2,$3,$4,$5)`

	versionInsertSQL = `
INSERT INTO governance_authority_record_versions (
    workspace_id, plan_id, revision, state, record_hash,
    canonical_record_bytes, idempotency_key
) VALUES ($1,$2,$3,$4,$5,$6,$7)`

	headInsertSQL = `
INSERT INTO governance_authority_heads (
    workspace_id, plan_id, revision, state, record_hash, service_build_sha
) VALUES ($1,$2,$3,$4,$5,$6)`

	headUpdateSQL = `
UPDATE governance_authority_heads
SET revision=$4, state=$5, record_hash=$6, service_build_sha=$7,
    updated_at=clock_timestamp()
WHERE workspace_id=$1 AND plan_id=$2 AND revision=$3`

	receiptAcceptedInsertSQL = `
INSERT INTO governance_authority_receipts (
    receipt_id, operation, status, idempotency_key, request_fingerprint,
    workspace_id, plan_id, expected_revision, accepted_revision, accepted_state,
    backend, authority, routing_epoch, record_hash, correlation_id, caller_id,
    execution_id, service_build_sha, canonical_record_bytes, committed_at
) VALUES ($1,$2,'accepted',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,clock_timestamp())
RETURNING committed_at, recorded_at`

	receiptReconciliationInsertSQL = `
INSERT INTO governance_authority_receipts (
    receipt_id, operation, status, idempotency_key, request_fingerprint,
    workspace_id, plan_id, expected_revision, target_revision, target_state,
    backend, authority, routing_epoch, record_hash, correlation_id, caller_id,
    execution_id, service_build_sha, reconciliation_token
) VALUES ($1,$2,'reconciliation_required',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
ON CONFLICT (idempotency_key) DO NOTHING`

	eventInsertSQL = `
INSERT INTO governance_authority_events (
    event_id, receipt_id, operation, workspace_id, plan_id, revision, state, record_hash
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`

	auditDeliveryInsertSQL = `
INSERT INTO governance_authority_audit_deliveries (
    receipt_id, workspace_id, plan_id, revision, status
) VALUES ($1,$2,$3,$4,'pending')`

	auditDeliveryForUpdateSQL = `
SELECT delivery.status, route.routing_epoch, event.operation, event.state,
       version.canonical_record_bytes, delivery.audit_event_id,
       delivery.audit_event_hash, delivery.idempotency_key,
       delivery.request_fingerprint, delivery.recorded_at
FROM governance_authority_audit_deliveries AS delivery
JOIN governance_authority_routes AS route
  ON route.workspace_id=delivery.workspace_id AND route.plan_id=delivery.plan_id
JOIN governance_authority_events AS event
  ON event.receipt_id=delivery.receipt_id
JOIN governance_authority_record_versions AS version
  ON version.workspace_id=delivery.workspace_id AND version.plan_id=delivery.plan_id
 AND version.revision=delivery.revision
WHERE delivery.workspace_id=$1 AND delivery.plan_id=$2 AND delivery.revision=$3
FOR UPDATE OF delivery`

	auditDeliveryRecordSQL = `
UPDATE governance_authority_audit_deliveries
SET status='recorded', audit_event_id=$4, audit_event_hash=$5,
    canonical_audit_bytes=$6, idempotency_key=$7, request_fingerprint=$8,
    recorded_at=clock_timestamp()
WHERE workspace_id=$1 AND plan_id=$2 AND revision=$3 AND status='pending'
RETURNING recorded_at`

	auditDeliveryReadSQL = `
SELECT status, audit_event_id, audit_event_hash, idempotency_key,
       request_fingerprint, recorded_at
FROM governance_authority_audit_deliveries
WHERE workspace_id=$1 AND plan_id=$2 AND revision=$3`

	pendingAuditReadSQL = `
SELECT event.operation, delivery.workspace_id, delivery.plan_id, delivery.revision,
       route.backend, route.authority, route.routing_epoch,
       encode(event.record_hash,'hex'), encode(receipt.service_build_sha,'hex')
FROM governance_authority_audit_deliveries AS delivery
JOIN governance_authority_events AS event
  ON event.receipt_id=delivery.receipt_id
JOIN governance_authority_receipts AS receipt
  ON receipt.receipt_id=delivery.receipt_id
JOIN governance_authority_routes AS route
  ON route.workspace_id=delivery.workspace_id AND route.plan_id=delivery.plan_id
WHERE delivery.workspace_id=$1 AND delivery.plan_id=$2 AND delivery.revision=$3
  AND delivery.status='pending'`

	pendingAuditExistsSQL = `
SELECT EXISTS (
    SELECT 1
    FROM governance_authority_audit_deliveries
    WHERE workspace_id=$1 AND plan_id=$2 AND revision=$3 AND status='pending'
)`

	readSQL = `
SELECT route.backend, route.authority, route.routing_epoch,
       encode(head.record_hash,'hex'), version.canonical_record_bytes,
       encode(head.service_build_sha,'hex')
FROM governance_authority_routes AS route
JOIN governance_authority_heads AS head
  ON head.workspace_id = route.workspace_id AND head.plan_id = route.plan_id
JOIN governance_authority_record_versions AS version
  ON version.workspace_id = head.workspace_id AND version.plan_id = head.plan_id
 AND version.revision = head.revision
WHERE route.workspace_id = $1 AND route.plan_id = $2`

	statisticsSQL = `
SELECT
    (SELECT count(*) FROM governance_authority_heads),
    (SELECT count(*) FROM governance_authority_receipts),
    (SELECT count(*) FROM governance_authority_receipts WHERE status='reconciliation_required'),
    (SELECT count(*) FROM governance_authority_audit_deliveries WHERE status='pending')`
)
