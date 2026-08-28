package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

func (repository *Repository) MarkV2ControlDeliveryStarted(ctx context.Context, attemptID, eventID, kind string, at time.Time) error {
	return repository.markV2Delivery(ctx, attemptID, eventID, kind, at, false)
}

func (repository *Repository) MarkV2ControlDelivered(ctx context.Context, attemptID, eventID, kind string, at time.Time) error {
	return repository.markV2Delivery(ctx, attemptID, eventID, kind, at, true)
}

func (repository *Repository) MarkV2ControlDeliveryReconciliation(ctx context.Context, attemptID, eventID, kind string, at time.Time) error {
	if err := validateID(attemptID, "attemptId"); err != nil {
		return err
	}
	if err := validateID(eventID, "eventId"); err != nil {
		return err
	}
	tag, err := repository.pool.Exec(ctx, `UPDATE workflow_runner_control_messages
SET delivery_state='reconciliation_required',delivery_started_at=COALESCE(delivery_started_at,$1)
WHERE attempt_id=$2 AND control_event_id=$3 AND kind=$4 AND delivery_state IN ('delivering','awaiting_ack')`, at.UTC(), attemptID, eventID, kind)
	if err != nil {
		return databaseFailure("latch v2 control delivery reconciliation", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 uncertain delivery could not be latched", nil)
	}
	repository.signalV2ControlAcknowledged(attemptID, eventID)
	return nil
}

func (repository *Repository) markV2Delivery(ctx context.Context, attemptID, eventID, kind string, at time.Time, complete bool) error {
	if err := validateID(attemptID, "attemptId"); err != nil {
		return err
	}
	if err := validateID(eventID, "eventId"); err != nil {
		return err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return databaseFailure("begin v2 control delivery", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var sequence *int64
	var state string
	if err := tx.QueryRow(ctx, `SELECT sequence,delivery_state FROM workflow_runner_control_messages
WHERE attempt_id=$1 AND control_event_id=$2 AND kind=$3 FOR UPDATE`, attemptID, eventID, kind).Scan(&sequence, &state); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return runnerstore.Failure(runnerstore.ErrorNotFound, "v2 control message was not found", err)
		}
		return databaseFailure("lock v2 control delivery", err)
	}
	expectedState := "pending"
	if complete {
		expectedState = "delivering"
	}
	if state == "delivered" {
		return repository.commit(ctx, tx)
	}
	if state == "awaiting_ack" {
		// Exact restart resend: the durable control bytes and identity are
		// unchanged. The ACK predecessor was established before the bytes became
		// visible, and only its companion HTTP ACK may finish delivery.
		return repository.commit(ctx, tx)
	}
	if state != expectedState {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 control delivery state is not the exact predecessor", nil)
	}
	if !complete && sequence != nil {
		var lowerOutstanding bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workflow_runner_control_messages
WHERE attempt_id=$1 AND sequence IS NOT NULL AND sequence<$2
  AND delivery_state IN ('pending','delivering','awaiting_ack','reconciliation_required'))`, attemptID, *sequence).Scan(&lowerOutstanding); err != nil {
			return databaseFailure("read v2 lower control delivery", err)
		}
		if lowerOutstanding {
			return runnerstore.Failure(runnerstore.ErrorSequenceConflict, "v2 control cannot overtake an earlier unsettled control", nil)
		}
	}
	if !complete && (kind == "budget_authorization" || kind == "effect_authorization" || kind == "resume_offer") {
		var receiptState string
		if err := tx.QueryRow(ctx, `SELECT receipt.delivery_state
FROM workflow_runner_v2_decision_bindings binding
JOIN workflow_runner_control_messages receipt ON receipt.control_event_id=binding.receipt_control_event_id
WHERE binding.decision_control_event_id=$1 FOR UPDATE OF receipt`, eventID).Scan(&receiptState); err != nil {
			return databaseFailure("read v2 paired receipt delivery", err)
		}
		if receiptState != "delivered" {
			return runnerstore.Failure(runnerstore.ErrorSequenceConflict, "v2 authority decision cannot precede its delivered event receipt", nil)
		}
	}
	authorityBound := false
	if repository.v2RuntimeDelivery {
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
 SELECT 1 FROM workflow_runner_event_receipts r
 JOIN workflow_runner_authority_bindings b ON b.target_event_id=r.received_event_id
 WHERE r.receipt_event_id=$1 AND b.state IN ('runner_committed','completed','reconciliation_required')
 UNION ALL
 SELECT 1 FROM workflow_runner_v2_decision_bindings d
 JOIN workflow_runner_authority_bindings b ON b.target_event_id=d.received_event_id
 WHERE d.decision_control_event_id=$1 AND b.state IN ('runner_committed','completed','reconciliation_required')
 UNION ALL
 SELECT 1 FROM workflow_runner_v2_cancel_bindings c
 JOIN workflow_runner_authority_bindings b ON b.attempt_id=c.attempt_id
 WHERE c.control_event_id=$1 AND b.state='runner_committed'
)`, eventID).Scan(&authorityBound); err != nil {
			return databaseFailure("read v2 authority-bound delivery", err)
		}
	}
	var tag interface{ RowsAffected() int64 }
	if complete {
		if authorityBound {
			tag, err = tx.Exec(ctx, `UPDATE workflow_runner_control_messages
SET delivery_state='awaiting_ack'
WHERE attempt_id=$1 AND control_event_id=$2 AND kind=$3 AND delivery_state IN ('delivering','awaiting_ack')`, attemptID, eventID, kind)
		} else {
			tag, err = tx.Exec(ctx, `UPDATE workflow_runner_control_messages
SET delivery_state='delivered',delivered_at=$1
WHERE attempt_id=$2 AND control_event_id=$3 AND kind=$4 AND delivery_state='delivering'`, at.UTC(), attemptID, eventID, kind)
		}
	} else if authorityBound {
		tag, err = tx.Exec(ctx, `UPDATE workflow_runner_control_messages
SET delivery_state='awaiting_ack',delivery_started_at=$1
WHERE attempt_id=$2 AND control_event_id=$3 AND kind=$4 AND delivery_state='pending'`, at.UTC(), attemptID, eventID, kind)
	} else {
		tag, err = tx.Exec(ctx, `UPDATE workflow_runner_control_messages
SET delivery_state='delivering',delivery_started_at=$1
WHERE attempt_id=$2 AND control_event_id=$3 AND kind=$4 AND delivery_state='pending'`, at.UTC(), attemptID, eventID, kind)
	}
	if err != nil {
		return databaseFailure("advance v2 control delivery", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 control delivery state is not the exact successor", nil)
	}
	if complete && kind == "cancel_request" {
		tag, err = tx.Exec(ctx, `UPDATE workflow_runner_cancel_controls
SET state='sent' WHERE control_event_id=$1 AND state='pending'`, eventID)
		if err != nil {
			return mapWriteFailure("mark v2 cancel delivered", err)
		}
		if tag.RowsAffected() != 1 {
			return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 cancel delivery state is not the exact successor", nil)
		}
	}
	return repository.commit(ctx, tx)
}

func v2ControlACKWaitKey(attemptID, eventID string) string { return attemptID + "\x00" + eventID }

func (repository *Repository) signalV2ControlAcknowledged(attemptID, eventID string) {
	if value, ok := repository.v2ControlACKWaiters.LoadAndDelete(v2ControlACKWaitKey(attemptID, eventID)); ok {
		close(value.(chan struct{}))
	}
}

func (repository *Repository) readV2ControlAcknowledgement(ctx context.Context, attemptID, eventID string) (runnerstore.V2ControlDeliveryDisposition, bool, error) {
	var state string
	if err := repository.pool.QueryRow(ctx, `SELECT delivery_state FROM workflow_runner_control_messages
WHERE attempt_id=$1 AND control_event_id=$2`, attemptID, eventID).Scan(&state); err != nil {
		return "", false, databaseFailure("wait for v2 control ACK", err)
	}
	switch state {
	case "delivered":
		return runnerstore.V2ControlDeliveryAccepted, true, nil
	case "reconciliation_required", "abandoned":
		return runnerstore.V2ControlDeliveryReconciliationRequired, true, nil
	case "awaiting_ack":
		return "", false, nil
	default:
		return "", false, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "v2 control is not awaiting its exact ACK", nil)
	}
}

// WaitV2ControlAcknowledged uses an in-process wakeup for the common path and
// the database row as the durable fact. The second point-read closes the race
// between registering the waiter and a concurrently committed HTTP ACK.
func (repository *Repository) WaitV2ControlAcknowledged(ctx context.Context, attemptID, eventID string) (runnerstore.V2ControlDeliveryDisposition, error) {
	if disposition, complete, err := repository.readV2ControlAcknowledgement(ctx, attemptID, eventID); err != nil || complete {
		return disposition, err
	}
	key := v2ControlACKWaitKey(attemptID, eventID)
	wake := make(chan struct{})
	actual, loaded := repository.v2ControlACKWaiters.LoadOrStore(key, wake)
	if loaded {
		wake = actual.(chan struct{})
	}
	defer repository.v2ControlACKWaiters.CompareAndDelete(key, wake)
	if disposition, complete, err := repository.readV2ControlAcknowledgement(ctx, attemptID, eventID); err != nil || complete {
		return disposition, err
	}
	select {
	case <-wake:
		return repository.waitV2ControlAcknowledgementPointRead(ctx, attemptID, eventID)
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (repository *Repository) waitV2ControlAcknowledgementPointRead(ctx context.Context, attemptID, eventID string) (runnerstore.V2ControlDeliveryDisposition, error) {
	disposition, complete, err := repository.readV2ControlAcknowledgement(ctx, attemptID, eventID)
	if err != nil {
		return "", err
	}
	if !complete {
		return "", runnerstore.Failure(runnerstore.ErrorSequenceConflict, "v2 control ACK wakeup has no durable successor", nil)
	}
	return disposition, nil
}
