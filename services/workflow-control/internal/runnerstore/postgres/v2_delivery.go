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
WHERE attempt_id=$2 AND control_event_id=$3 AND kind=$4 AND delivery_state='delivering'`, at.UTC(), attemptID, eventID, kind)
	if err != nil {
		return databaseFailure("latch v2 control delivery reconciliation", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 uncertain delivery could not be latched", nil)
	}
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
	if state != expectedState {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 control delivery state is not the exact predecessor", nil)
	}
	if !complete && sequence != nil {
		var lowerOutstanding bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workflow_runner_control_messages
WHERE attempt_id=$1 AND sequence IS NOT NULL AND sequence<$2
  AND delivery_state IN ('pending','delivering','reconciliation_required'))`, attemptID, *sequence).Scan(&lowerOutstanding); err != nil {
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
	var tag interface{ RowsAffected() int64 }
	if complete {
		tag, err = tx.Exec(ctx, `UPDATE workflow_runner_control_messages
SET delivery_state='delivered',delivered_at=$1
WHERE attempt_id=$2 AND control_event_id=$3 AND kind=$4 AND delivery_state='delivering'`, at.UTC(), attemptID, eventID, kind)
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
