package postgres

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func (repository *Repository) RequestCancel(ctx context.Context, input runnerstore.CancelInput) (runnerstore.CancelControl, error) {
	if err := runnerstore.ValidateCancelInput(input); err != nil {
		return runnerstore.CancelControl{}, err
	}
	fingerprint, err := decodeFingerprint(input.RequestFingerprint)
	if err != nil {
		return runnerstore.CancelControl{}, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.CancelControl{}, databaseFailure("begin runner cancellation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, input.IdempotencyKey, input.WorkspaceID, input.JobID); err != nil {
		return runnerstore.CancelControl{}, err
	}
	if existing, raw, readErr := readCancelControl(tx.QueryRow(ctx, cancelByKeySQL, input.IdempotencyKey)); readErr == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) != 1 {
			return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "cancel idempotency key is bound to another control", nil)
		}
		existing.Duplicate = true
		return existing, nil
	} else if !errors.Is(readErr, pgx.ErrNoRows) {
		return runnerstore.CancelControl{}, databaseFailure("read runner cancellation", readErr)
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, input.WorkspaceID, input.JobID))
	if err != nil {
		return runnerstore.CancelControl{}, err
	}
	if current.currentFence != input.ExpectedFence {
		return runnerstore.CancelControl{}, repository.staleFence("cancel expected fence is stale", nil)
	}
	if current.jobState == runnerstore.JobTerminal || current.jobState == runnerstore.JobReconciliationRequired {
		return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorConflict, "terminal runner job cannot accept a new cancellation", nil)
	}
	if current.jobState != runnerstore.JobOffered && current.jobState != runnerstore.JobRunning && current.jobState != runnerstore.JobCancelling {
		return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorConflict, "runner job is not cancellable", nil)
	}
	if current.currentAttemptID != input.ExpectedAttemptID {
		return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "cancel expected attempt is not current", nil)
	}
	var requiredProtocol string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(to_jsonb(j)->>'required_protocol_version','openslack.workflow_runner.v1')
FROM workflow_runner_jobs j WHERE workspace_id=$1 AND job_id=$2`, input.WorkspaceID, input.JobID).Scan(&requiredProtocol); err != nil {
		return runnerstore.CancelControl{}, databaseFailure("read cancellation protocol binding", err)
	}
	if requiredProtocol == "openslack.workflow_runner.v2" {
		var authorityLaneBusy bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workflow_runner_v2_event_inbox
WHERE attempt_id=$1 AND state IN ('pending_authority','authority_committed','reconciliation_required'))`, input.ExpectedAttemptID).Scan(&authorityLaneBusy); err != nil {
			return runnerstore.CancelControl{}, databaseFailure("read v2 cancellation event lane", err)
		}
		if authorityLaneBusy {
			return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorConflict, "v2 cancellation is blocked by an unsettled authority event", nil)
		}
		if repository.v2RuntimeDelivery {
			var pendingDecision bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM workflow_runner_v2_decision_bindings pair
JOIN workflow_runner_control_messages decision ON decision.control_event_id=pair.decision_control_event_id
JOIN workflow_runner_authority_bindings binding ON binding.target_event_id=pair.received_event_id
WHERE binding.attempt_id=$1 AND binding.state='runner_committed'
  AND decision.delivery_state IN ('pending','delivering','awaiting_ack','reconciliation_required')
)`, input.ExpectedAttemptID).Scan(&pendingDecision); err != nil {
				return runnerstore.CancelControl{}, databaseFailure("read v2 cancellation decision lane", err)
			}
			if pendingDecision {
				// A decision-producing event has already reserved the exact next
				// control sequence. The immutable decision must settle before a
				// normal later cancellation can be admitted; skipping it would
				// create a sequence gap at the worker.
				return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorConflict, "v2 cancellation must follow the durable authority decision", nil)
			}
		}
	}
	var workflowRunID, correlationID, leaseID string
	if err := tx.QueryRow(ctx, `
SELECT j.workflow_run_id, j.correlation_id, l.lease_id
FROM workflow_runner_jobs j
JOIN workflow_runner_attempts a ON a.attempt_id=j.current_attempt_id
JOIN workflow_runner_leases l ON l.attempt_id=a.attempt_id
WHERE j.workspace_id=$1 AND j.job_id=$2`, input.WorkspaceID, input.JobID).Scan(&workflowRunID, &correlationID, &leaseID); err != nil {
		return runnerstore.CancelControl{}, databaseFailure("read cancellation identity", err)
	}
	if correlationID != input.CorrelationID || leaseID != input.ExpectedLeaseID {
		return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "cancel identity does not bind the current lease", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.CancelControl{}, err
	}
	requestedAt := input.Now.UTC().Truncate(time.Millisecond)
	expiresAt := input.ExpiresAt.UTC().Truncate(time.Millisecond)
	if now.After(expiresAt) {
		return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorControlExpired, "cancel control already expired", nil)
	}
	if requestedAt.After(now.Add(time.Second)) || now.Sub(requestedAt) > runnerstore.MaxCancellationWindow {
		return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorControlExpired, "cancel requestedAt is outside the accepted clock window", nil)
	}
	cancelID, err := randomToken("cancel")
	if err != nil {
		return runnerstore.CancelControl{}, databaseFailure("generate cancellation id", err)
	}
	eventID, err := randomToken("control")
	if err != nil {
		return runnerstore.CancelControl{}, databaseFailure("generate cancellation event id", err)
	}
	sequence := current.controlSequence + 1
	jobID, runID, attemptID, lease := input.JobID, workflowRunID, input.ExpectedAttemptID, leaseID
	fence := input.ExpectedFence
	message := runnerprotocol.Envelope{
		ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: runnerprotocol.KindCancelRequest,
		WorkspaceID: input.WorkspaceID, JobID: &jobID, WorkflowRunID: &runID,
		AttemptID: &attemptID, LeaseID: &lease, FencingToken: &fence, Sequence: &sequence,
		EventID: eventID, CorrelationID: correlationID, SentAt: runnerstore.CanonicalTimestamp(requestedAt),
		Payload: map[string]any{
			"cancelId": cancelID, "requestedAt": runnerstore.CanonicalTimestamp(requestedAt),
			"expiresAt": runnerstore.CanonicalTimestamp(expiresAt), "reason": input.Reason,
		},
	}
	prepared, err := runnerprotocol.PrepareEnvelope(message)
	if err != nil {
		return runnerstore.CancelControl{}, err
	}
	digest, _ := hex.DecodeString(prepared.MessageDigest)
	if _, err := tx.Exec(ctx, controlInsertSQL,
		eventID, attemptID, "cancel_request", sequence, prepared.Body, digest, now,
	); err != nil {
		return runnerstore.CancelControl{}, mapWriteFailure("insert durable cancel request", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO workflow_runner_cancel_controls (
    cancel_id, workspace_id, job_id, attempt_id, lease_id, fencing_token,
    reason, state, idempotency_key, request_fingerprint, control_event_id,
    requested_at, expires_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12)`,
		cancelID, input.WorkspaceID, input.JobID, attemptID, leaseID, fence,
		input.Reason, input.IdempotencyKey, fingerprint, eventID, requestedAt, expiresAt,
	); err != nil {
		return runnerstore.CancelControl{}, mapWriteFailure("insert runner cancellation", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE workflow_runner_attempts
SET state='cancelling', control_sequence=$1, updated_at=$2
WHERE attempt_id=$3 AND control_sequence=$4`, sequence, now, attemptID, current.controlSequence); err != nil {
		return runnerstore.CancelControl{}, mapWriteFailure("advance cancelling attempt", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE workflow_runner_leases SET state='cancelling', updated_at=$1 WHERE lease_id=$2`, now, leaseID); err != nil {
		return runnerstore.CancelControl{}, mapWriteFailure("advance cancelling lease", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE workflow_runner_jobs SET state='cancelling', revision=revision+1, updated_at=$1
WHERE workspace_id=$2 AND job_id=$3 AND revision=$4`, now, input.WorkspaceID, input.JobID, current.jobRevision); err != nil {
		return runnerstore.CancelControl{}, mapWriteFailure("advance cancelling job", err)
	}
	if err := repository.commit(ctx, tx); err != nil {
		// The control exact bytes are durable or the caller must reconcile by the
		// same idempotency key; never synthesize a second cancel identity.
		if recovered, raw, readErr := readCancelControl(repository.pool.QueryRow(context.Background(), cancelByKeySQL, input.IdempotencyKey)); readErr == nil && subtle.ConstantTimeCompare(raw, fingerprint) == 1 {
			return recovered, nil
		}
		return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "cancel request commit outcome is unknown", err)
	}
	return runnerstore.CancelControl{
		WorkspaceID: input.WorkspaceID, JobID: input.JobID, WorkflowRunID: workflowRunID,
		AttemptID: attemptID, LeaseID: leaseID, FencingToken: fence,
		CancelID: cancelID, Reason: input.Reason, RequestedAt: requestedAt,
		ExpiresAt: expiresAt, ControlSequence: sequence, Message: message,
		ExactBytes: append([]byte(nil), prepared.Body...),
	}, nil
}

func (repository *Repository) PendingCancel(ctx context.Context, workspaceID, jobID, attemptID string) (*runnerstore.CancelControl, error) {
	for label, value := range map[string]string{"workspaceId": workspaceID, "jobId": jobID, "attemptId": attemptID} {
		if err := validateID(value, label); err != nil {
			return nil, err
		}
	}
	value, _, err := readCancelControl(repository.pool.QueryRow(ctx, pendingCancelSQL, workspaceID, jobID, attemptID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, databaseFailure("read pending runner cancellation", err)
	}
	return &value, nil
}

func (repository *Repository) MarkControlDelivered(ctx context.Context, attemptID, eventID, kind string, deliveredAt time.Time) error {
	if err := validateID(attemptID, "attemptId"); err != nil {
		return err
	}
	if err := validateID(eventID, "eventId"); err != nil {
		return err
	}
	if kind != "lease_offer" && kind != "cancel_request" && kind != "event_receipt" && kind != "hello_ack" {
		return runnerstore.Failure(runnerstore.ErrorInputInvalid, "control kind is invalid", nil)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return databaseFailure("begin runner control delivery", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var state string
	if readErr := tx.QueryRow(ctx, `SELECT delivery_state FROM workflow_runner_control_messages WHERE attempt_id=$1 AND control_event_id=$2 AND kind=$3 FOR UPDATE`, attemptID, eventID, kind).Scan(&state); readErr != nil {
		if errors.Is(readErr, pgx.ErrNoRows) {
			return runnerstore.Failure(runnerstore.ErrorNotFound, "runner control was not found", readErr)
		}
		return databaseFailure("read runner control delivery", readErr)
	}
	if state != "pending" && state != "delivered" {
		return runnerstore.Failure(runnerstore.ErrorConflict, "runner control cannot be marked delivered", nil)
	}
	if kind == "cancel_request" {
		var cancelState string
		if readErr := tx.QueryRow(ctx, `SELECT state FROM workflow_runner_cancel_controls WHERE control_event_id=$1 FOR UPDATE`, eventID).Scan(&cancelState); readErr != nil {
			if errors.Is(readErr, pgx.ErrNoRows) {
				return runnerstore.Failure(runnerstore.ErrorNotFound, "runner cancel control was not found", readErr)
			}
			return databaseFailure("read runner cancel delivery", readErr)
		}
		if state == "pending" {
			tag, updateErr := tx.Exec(ctx, `UPDATE workflow_runner_cancel_controls SET state='sent' WHERE control_event_id=$1 AND state='pending'`, eventID)
			if updateErr != nil {
				return mapWriteFailure("mark runner cancel sent", updateErr)
			}
			if tag.RowsAffected() != 1 {
				return runnerstore.Failure(runnerstore.ErrorConflict, "runner cancel delivery state is inconsistent", nil)
			}
		} else if cancelState != "sent" && cancelState != "acknowledged" {
			return runnerstore.Failure(runnerstore.ErrorConflict, "delivered runner cancel has inconsistent durable state", nil)
		}
	}
	if state == "pending" {
		tag, updateErr := tx.Exec(ctx, `UPDATE workflow_runner_control_messages SET delivery_state='delivered',delivered_at=$1 WHERE attempt_id=$2 AND control_event_id=$3 AND kind=$4 AND delivery_state='pending'`, deliveredAt.UTC(), attemptID, eventID, kind)
		if updateErr != nil {
			return mapWriteFailure("mark runner control delivered", updateErr)
		}
		if tag.RowsAffected() != 1 {
			return runnerstore.Failure(runnerstore.ErrorConflict, "runner control delivery CAS lost", nil)
		}
	}
	if err := repository.commit(ctx, tx); err != nil {
		return repository.resolveControlDelivery(attemptID, eventID, kind, err)
	}
	return nil
}

func (repository *Repository) resolveControlDelivery(attemptID, eventID, kind string, commitErr error) error {
	ctx, cancel := context.WithTimeout(context.Background(), commitRecoveryTimeout)
	defer cancel()
	var deliveryState string
	if err := repository.pool.QueryRow(ctx, `SELECT delivery_state FROM workflow_runner_control_messages WHERE attempt_id=$1 AND control_event_id=$2 AND kind=$3`, attemptID, eventID, kind).Scan(&deliveryState); err != nil {
		return runnerstore.Failure(runnerstore.ErrorCommitUnknown, "control delivery commit outcome cannot be read", errors.Join(commitErr, err))
	}
	if deliveryState != "delivered" {
		return runnerstore.Failure(runnerstore.ErrorCommitUnknown, "control delivery commit was not proven", commitErr)
	}
	if kind == "cancel_request" {
		var cancelState string
		if err := repository.pool.QueryRow(ctx, `SELECT state FROM workflow_runner_cancel_controls WHERE control_event_id=$1`, eventID).Scan(&cancelState); err != nil || (cancelState != "sent" && cancelState != "acknowledged") {
			return runnerstore.Failure(runnerstore.ErrorCommitUnknown, "cancel delivery commit was not proven", errors.Join(commitErr, err))
		}
	}
	return nil
}

func readCancelControl(row pgx.Row) (runnerstore.CancelControl, []byte, error) {
	var value runnerstore.CancelControl
	var fingerprint, exact []byte
	if err := row.Scan(
		&value.WorkspaceID, &value.JobID, &value.WorkflowRunID,
		&value.AttemptID, &value.LeaseID, &value.FencingToken,
		&value.CancelID, &value.Reason, &value.RequestedAt, &value.ExpiresAt,
		&value.ControlSequence, &exact, &fingerprint,
	); err != nil {
		return runnerstore.CancelControl{}, nil, err
	}
	message, err := runnerprotocol.ValidateCanonicalEnvelopeBytes(exact)
	if err != nil {
		return runnerstore.CancelControl{}, nil, runnerstore.Failure(runnerstore.ErrorDatabase, "stored cancel control is invalid", err)
	}
	value.Message = message
	value.ExactBytes = append([]byte(nil), exact...)
	return value, append([]byte(nil), fingerprint...), nil
}

const cancelByKeySQL = `
SELECT c.workspace_id, c.job_id, j.workflow_run_id,
       c.attempt_id, c.lease_id, c.fencing_token,
       c.cancel_id, c.reason, c.requested_at, c.expires_at,
       m.sequence, m.exact_message_bytes, c.request_fingerprint
FROM workflow_runner_cancel_controls c
JOIN workflow_runner_jobs j ON j.workspace_id=c.workspace_id AND j.job_id=c.job_id
JOIN workflow_runner_control_messages m ON m.control_event_id=c.control_event_id
WHERE c.idempotency_key=$1`

const pendingCancelSQL = `
SELECT c.workspace_id, c.job_id, j.workflow_run_id,
       c.attempt_id, c.lease_id, c.fencing_token,
       c.cancel_id, c.reason, c.requested_at, c.expires_at,
       m.sequence, m.exact_message_bytes, c.request_fingerprint
FROM workflow_runner_cancel_controls c
JOIN workflow_runner_jobs j ON j.workspace_id=c.workspace_id AND j.job_id=c.job_id
JOIN workflow_runner_control_messages m ON m.control_event_id=c.control_event_id
WHERE c.workspace_id=$1 AND c.job_id=$2 AND c.attempt_id=$3
  AND c.state IN ('pending','sent')
ORDER BY c.requested_at DESC
LIMIT 1`
