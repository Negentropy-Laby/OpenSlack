package postgres

const (
	intakeInsertSQL = `INSERT INTO notifications (
    notification_id, caller_id, vendor_id, idempotency_key, request_fingerprint,
    payload_bytes, state, version, attempt_count, delivery_cycle_started_at,
    next_attempt_at, created_at, updated_at
) VALUES (
    gen_random_uuid()::text, $1, $2, $3, $4, $5, 'pending', 1, 0, $6, NULL, $6, $6
)
ON CONFLICT (caller_id, idempotency_key) DO NOTHING
RETURNING notification_id, created_at`

	intakeSelectSQL = `SELECT notification_id, request_fingerprint
FROM notifications
WHERE caller_id = $1 AND idempotency_key = $2`

	notificationColumns = `notification_id, caller_id, vendor_id, idempotency_key, request_fingerprint,
    payload_bytes, state, version, attempt_count, delivery_cycle_started_at,
    replay_count, created_at, updated_at, next_attempt_at, lease_id,
    lease_expires_at, lease_actor_id, delivered_at, dead_at, dead_reason,
    replayed_at, replay_actor, replay_reason, last_outcome_class, last_error_code`

	claimScanSQL = `SELECT ` + notificationColumns + `
FROM notifications
WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
  AND vendor_id = ANY($1)
ORDER BY delivery_cycle_started_at ASC, created_at ASC, notification_id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1`

	claimByIDSQL = `SELECT ` + notificationColumns + `
FROM notifications
WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
  AND notification_id = $1 AND vendor_id = ANY($2)
FOR UPDATE SKIP LOCKED
LIMIT 1`

	claimUpdateSQL = `UPDATE notifications
SET state = 'in_flight',
    version = version + 1,
    lease_id = $3,
    lease_expires_at = $4,
    lease_actor_id = $5,
    updated_at = $6
WHERE notification_id = $1 AND version = $2`

	appendClaimedSQL = `INSERT INTO delivery_attempts (
    notification_id, attempt_seq, event_kind, result_kind, outcome_class,
    http_status, error_code, reason, actor_id, lease_id, lease_expires_at,
    recorded_at, claimed_at
) VALUES ($1, $2, 'claimed', NULL, NULL, NULL, NULL, NULL, $4, $3, $5, $6, $6)`

	selectNotificationForUpdateSQL = `SELECT ` + notificationColumns + `
FROM notifications
WHERE notification_id = $1 AND vendor_id = ANY($2)
FOR UPDATE`

	selectNotificationSQL = `SELECT ` + notificationColumns + `
FROM notifications
WHERE notification_id = $1 AND vendor_id = ANY($2)`

	recoverSelectSQL = `SELECT ` + notificationColumns + `
FROM notifications
WHERE state = 'in_flight' AND lease_expires_at <= $2
ORDER BY lease_expires_at ASC, notification_id ASC
LIMIT $1
FOR UPDATE`

	outboxCountsSQL = `SELECT state, COUNT(*)
FROM notifications
WHERE vendor_id = ANY($1)
GROUP BY state`

	outboxCountsGlobalSQL = `SELECT state, COUNT(*)
FROM notifications
GROUP BY state`

	oldestPendingSQL = `SELECT MIN(created_at)
FROM notifications
WHERE state = 'pending' AND vendor_id = ANY($1)`

	oldestPendingGlobalSQL = `SELECT MIN(created_at)
FROM notifications
WHERE state = 'pending'`

	listDeadSQL = `SELECT ` + notificationColumns + `
FROM notifications
WHERE state = 'dead'
  AND vendor_id = ANY($1)
  AND dead_at <= $2
  AND ($3::timestamptz IS NULL OR (dead_at, notification_id) > ($3::timestamptz, $4))
ORDER BY dead_at ASC, notification_id ASC
LIMIT $5`

	listHistorySQL = `SELECT
    attempt_id, notification_id, attempt_seq, event_kind, claimed_at,
    outcome_class, result_kind, http_status, error_code, reason,
    actor_id, lease_id, lease_expires_at, recorded_at
FROM delivery_attempts
WHERE notification_id = $1
  AND ($2 = 0 AND $3 = '' OR (attempt_seq, attempt_id) > ($2, $3::uuid))
ORDER BY attempt_seq ASC, attempt_id ASC
LIMIT $4`

	nextAttemptSeqSQL = `SELECT COALESCE(MAX(attempt_seq), 0) + 1
FROM delivery_attempts
WHERE notification_id = $1`

	appendAttemptSQL = `INSERT INTO delivery_attempts (
    notification_id, attempt_seq, event_kind, result_kind, outcome_class,
    http_status, error_code, reason, actor_id, lease_id, lease_expires_at,
    recorded_at, claimed_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`

	transitionUpdateSQL = `UPDATE notifications
SET state = $1,
    version = $2,
    attempt_count = $3,
    delivery_cycle_started_at = $4,
    delivered_at = $5,
    dead_at = $6,
    dead_reason = $7,
    replayed_at = $8,
    replay_actor = $9,
    replay_reason = $10,
    next_attempt_at = $11,
    last_outcome_class = $12,
    last_error_code = $13,
    lease_id = $14,
    lease_expires_at = $15,
    lease_actor_id = $16,
    updated_at = $17
WHERE notification_id = $18 AND version = $19`
)
