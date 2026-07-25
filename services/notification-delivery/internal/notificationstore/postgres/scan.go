package postgres

import (
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore"
)

// scanNotification scans a notification row from a pgx.Row.
func scanNotification(row pgx.Row, n *notificationstore.Notification) error {
	var nextAt, leaseExpires, deliveredAt, deadAt, replayedAt *time.Time
	var leaseID, leaseActorID, deadReason, replayActor, replayReason, lastOutcome, lastError *string
	if err := row.Scan(
		&n.ID,
		&n.CallerID,
		&n.VendorID,
		&n.IdempotencyKey,
		&n.RequestFingerprint,
		&n.Payload,
		&n.State,
		&n.Version,
		&n.AttemptCount,
		&n.DeliveryCycleStartedAt,
		&n.ReplayCount,
		&n.CreatedAt,
		&n.UpdatedAt,
		&nextAt,
		&leaseID,
		&leaseExpires,
		&leaseActorID,
		&deliveredAt,
		&deadAt,
		&deadReason,
		&replayedAt,
		&replayActor,
		&replayReason,
		&lastOutcome,
		&lastError,
	); err != nil {
		return err
	}
	n.NextAttemptAt = nextAt
	n.LeaseID = derefString(leaseID)
	n.LeaseExpiresAt = leaseExpires
	n.LeaseActorID = derefString(leaseActorID)
	n.DeliveredAt = deliveredAt
	n.DeadAt = deadAt
	n.DeadReason = derefString(deadReason)
	n.ReplayedAt = replayedAt
	n.ReplayActor = derefString(replayActor)
	n.ReplayReason = derefString(replayReason)
	n.LastOutcomeClass = derefString(lastOutcome)
	n.LastErrorCode = derefString(lastError)
	return nil
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// scanNotificationRows scans a notification row from pgx.Rows.
func scanNotificationRows(rows pgx.Rows, n *notificationstore.Notification) error {
	return scanNotification(rows, n)
}

// scanAttempt scans a delivery_attempts row.
func scanAttempt(rows pgx.Rows, a *notificationstore.Attempt) error {
	var claimedAt, leaseExpires *time.Time
	var httpStatus *int
	var outcomeClass, resultKind, errorCode, reason, actorID, leaseID *string
	if err := rows.Scan(
		&a.ID,
		&a.NotificationID,
		&a.AttemptSeq,
		&a.EventKind,
		&a.ConfigVersion,
		&claimedAt,
		&outcomeClass,
		&resultKind,
		&httpStatus,
		&errorCode,
		&reason,
		&actorID,
		&leaseID,
		&leaseExpires,
		&a.RecordedAt,
	); err != nil {
		return err
	}
	a.ClaimedAt = claimedAt
	a.OutcomeClass = derefString(outcomeClass)
	a.ResultKind = derefString(resultKind)
	a.HTTPStatus = httpStatus
	a.ErrorCode = derefString(errorCode)
	a.Reason = derefString(reason)
	a.ActorID = derefString(actorID)
	a.LeaseID = derefString(leaseID)
	a.LeaseExpiresAt = leaseExpires
	return nil
}
