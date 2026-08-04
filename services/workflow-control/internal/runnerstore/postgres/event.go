package postgres

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

type activeAttempt struct {
	jobState         runnerstore.JobState
	jobRevision      int64
	currentFence     int64
	currentAttemptID string
	attemptState     runnerstore.AttemptState
	workerSequence   int64
	controlSequence  int64
	executionStarted bool
	openEffectCount  int64
	leaseState       string
	offerExpiresAt   time.Time
	leaseExpiresAt   time.Time
	dispatchFailures int64
	terminalStatus   any
	terminalReason   any
	resultHash       any
	reconciliationID any
}

func (repository *Repository) RecordEvent(ctx context.Context, input runnerstore.RecordEventInput) (runnerstore.RecordedEvent, error) {
	prepared, err := runnerstore.ValidateRecordEventInput(input)
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	message := input.Message
	if message.JobID == nil || message.AttemptID == nil || message.LeaseID == nil || message.FencingToken == nil || message.Sequence == nil {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "leased event identity is incomplete", nil)
	}
	fingerprint, err := decodeFingerprint(prepared.RequestFingerprint)
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.RecordedEvent{}, databaseFailure("begin runner event", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, prepared.IdempotencyKey, message.WorkspaceID, *message.JobID); err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, message.WorkspaceID, *message.JobID))
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	if current.currentFence != *message.FencingToken {
		return runnerstore.RecordedEvent{}, repository.staleFence("worker event fencing token is stale", nil)
	}
	if current.currentAttemptID != *message.AttemptID {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "worker event attempt is not current", nil)
	}
	if result, raw, readErr := readRecordedEvent(tx.QueryRow(ctx, eventReceiptByKeySQL, prepared.IdempotencyKey)); readErr == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) != 1 {
			return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "event idempotency key is bound to different bytes", nil)
		}
		result.Duplicate = true
		return result, nil
	} else if !errors.Is(readErr, pgx.ErrNoRows) {
		return runnerstore.RecordedEvent{}, databaseFailure("read runner event receipt", readErr)
	}
	if *message.Sequence != current.workerSequence+1 {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "worker event sequence is not the exact successor", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	if err := validateEventTime(current, message, now, tx); err != nil {
		return runnerstore.RecordedEvent{}, err
	}

	next, err := applyEvent(ctx, tx, current, message, now)
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	nextControlSequence := current.controlSequence + 1
	receipt, err := runnerprotocol.CreateEventReceipt(message, runnerprotocol.CreateReceiptInput{
		Sequence: nextControlSequence, SentAt: runnerstore.CanonicalTimestamp(now),
		Status: runnerprotocol.ReceiptAccepted, ControlBuildHash: input.ControlBuildHash,
	})
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	receiptPrepared, err := runnerprotocol.PrepareEnvelope(receipt)
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}

	eventFingerprint := fingerprint
	eventDigest, _ := hex.DecodeString(prepared.MessageDigest)
	receiptDigest, _ := hex.DecodeString(receiptPrepared.MessageDigest)
	if _, err := tx.Exec(ctx, workerEventInsertSQL,
		message.EventID, message.WorkspaceID, *message.JobID, *message.AttemptID,
		*message.LeaseID, *message.FencingToken, *message.Sequence, string(message.Kind),
		prepared.IdempotencyKey, eventFingerprint, eventDigest, prepared.Body, now,
	); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("insert worker event", err)
	}
	if err := applyEffectBoundary(ctx, tx, message, now); err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	if _, err := tx.Exec(ctx, controlInsertSQL,
		receipt.EventID, *message.AttemptID, "event_receipt", nextControlSequence,
		receiptPrepared.Body, receiptDigest, now,
	); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("insert event receipt outbox", err)
	}
	if _, err := tx.Exec(ctx, eventReceiptInsertSQL,
		receipt.EventID, message.EventID, "accepted", receiptPrepared.Body,
		receiptDigest, nil, now,
	); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("insert durable event receipt", err)
	}

	var acceptedAt, startedAt, finishedAt any
	if message.Kind == runnerprotocol.KindLeaseAccept {
		acceptedAt, startedAt = now, now
	}
	if message.Kind == runnerprotocol.KindTerminal || message.Kind == runnerprotocol.KindLeaseReject {
		finishedAt = now
	}
	tag, err := tx.Exec(ctx, attemptUpdateSQL,
		string(next.attemptState), *message.Sequence, nextControlSequence,
		next.executionStarted, next.openEffectCount,
		acceptedAt, startedAt, finishedAt, now, *message.AttemptID,
		current.workerSequence, current.controlSequence,
	)
	if err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("advance runner attempt", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "runner attempt CAS lost", nil)
	}
	if message.Kind == runnerprotocol.KindLeaseAccept {
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_jobs SET dispatch_failures=0,dispatch_not_before='-infinity',dispatch_state='ready',last_dispatch_error=NULL WHERE workspace_id=$1 AND job_id=$2`, message.WorkspaceID, *message.JobID); err != nil {
			return runnerstore.RecordedEvent{}, mapWriteFailure("reset runner dispatch failures", err)
		}
	} else if message.Kind == runnerprotocol.KindLeaseReject {
		if err := applyDispatchFailure(ctx, tx, message.WorkspaceID, *message.JobID, *message.AttemptID, current.dispatchFailures+1, "lease_rejected", now); err != nil {
			return runnerstore.RecordedEvent{}, err
		}
	}
	if _, err := tx.Exec(ctx, leaseUpdateSQL,
		next.leaseState, heartbeatTime(message, now), now, *message.LeaseID, *message.FencingToken,
	); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("advance runner lease", err)
	}
	tag, err = tx.Exec(ctx, jobEventUpdateSQL,
		string(next.jobState), next.terminalStatus, next.terminalReason,
		next.resultHash, next.reconciliationID, now,
		message.WorkspaceID, *message.JobID, current.jobRevision,
	)
	if err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("advance runner job", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorConflict, "runner job event CAS lost", nil)
	}
	if err := repository.commit(ctx, tx); err != nil {
		return repository.resolveEventCommit(input, prepared, fingerprint, err)
	}
	return runnerstore.RecordedEvent{
		Receipt: receipt, ReceiptBytes: append([]byte(nil), receiptPrepared.Body...),
		Status: runnerstore.ReceiptAccepted, JobState: next.jobState,
		AttemptState: next.attemptState,
	}, nil
}

type eventTransition struct {
	jobState         runnerstore.JobState
	attemptState     runnerstore.AttemptState
	leaseState       string
	executionStarted bool
	openEffectCount  int64
	terminalStatus   any
	terminalReason   any
	resultHash       any
	reconciliationID any
}

func applyEvent(ctx context.Context, tx pgx.Tx, current activeAttempt, message runnerprotocol.Envelope, now time.Time) (eventTransition, error) {
	next := eventTransition{
		jobState: current.jobState, attemptState: current.attemptState,
		leaseState: current.leaseState, executionStarted: current.executionStarted,
		openEffectCount: current.openEffectCount,
		terminalStatus:  current.terminalStatus, terminalReason: current.terminalReason,
		resultHash: current.resultHash, reconciliationID: current.reconciliationID,
	}
	switch message.Kind {
	case runnerprotocol.KindLeaseAccept:
		if current.attemptState != runnerstore.AttemptOffered || current.leaseState != "offered" {
			return next, runnerstore.Failure(runnerstore.ErrorConflict, "lease accept is not valid in the current state", nil)
		}
		next.jobState, next.attemptState, next.leaseState = runnerstore.JobRunning, runnerstore.AttemptRunning, "active"
		// The receipt is committed in the same transaction. Once it can be
		// delivered, JavaScript may start, so recovery must conservatively treat
		// this attempt as execution-started and must not auto-take it over.
		next.executionStarted = true
	case runnerprotocol.KindLeaseReject:
		if current.attemptState != runnerstore.AttemptOffered {
			return next, runnerstore.Failure(runnerstore.ErrorConflict, "lease reject is not valid in the current state", nil)
		}
		next.jobState, next.attemptState, next.leaseState = runnerstore.JobQueued, runnerstore.AttemptRejected, "released"
		if current.dispatchFailures+1 >= runnerstore.MaxDispatchFailures {
			reconciliationID, err := insertReconciliation(ctx, tx, message, "WORKFLOW_RUNNER_RECONCILIATION_REQUIRED", now)
			if err != nil {
				return next, err
			}
			next.jobState, next.attemptState = runnerstore.JobReconciliationRequired, runnerstore.AttemptReconciliationRequired
			next.terminalStatus, next.terminalReason, next.reconciliationID = string(runnerprotocol.TerminalReconciliationRequired), "commit_outcome_unknown", reconciliationID
		}
	case runnerprotocol.KindHeartbeat:
		if current.attemptState != runnerstore.AttemptRunning && current.attemptState != runnerstore.AttemptCancelling {
			return next, runnerstore.Failure(runnerstore.ErrorConflict, "heartbeat is not valid in the current state", nil)
		}
	case runnerprotocol.KindEffectIntent:
		if current.attemptState != runnerstore.AttemptRunning {
			return next, runnerstore.Failure(runnerstore.ErrorConflict, "effect intent requires a running attempt", nil)
		}
		next.openEffectCount++
	case runnerprotocol.KindEffectOutcome:
		if current.openEffectCount < 1 {
			return next, runnerstore.Failure(runnerstore.ErrorConflict, "effect outcome has no open intent", nil)
		}
		next.openEffectCount--
		if message.Payload["status"] == "reconciliation_required" {
			reconciliationID, err := insertReconciliation(ctx, tx, message, "WORKFLOW_RUNNER_RECONCILIATION_REQUIRED", now)
			if err != nil {
				return next, err
			}
			next.jobState, next.attemptState, next.leaseState = runnerstore.JobReconciliationRequired, runnerstore.AttemptReconciliationRequired, "released"
			next.terminalStatus, next.terminalReason = string(runnerprotocol.TerminalReconciliationRequired), "commit_outcome_unknown"
			next.reconciliationID = reconciliationID
		}
	case runnerprotocol.KindCancelAck:
		status := message.Payload["status"].(string)
		terminal := current.jobState == runnerstore.JobTerminal || current.jobState == runnerstore.JobReconciliationRequired
		if terminal {
			if status != "already_terminal" {
				return next, runnerstore.Failure(runnerstore.ErrorConflict, "terminal runner job only accepts already_terminal cancel acknowledgement", nil)
			}
		} else if current.jobState != runnerstore.JobCancelling || current.attemptState != runnerstore.AttemptCancelling || (status != "cancelling" && status != "cancelled") {
			return next, runnerstore.Failure(runnerstore.ErrorConflict, "cancel acknowledgement does not match a cancelling attempt", nil)
		}
		if err := acknowledgeCancel(ctx, tx, message, now); err != nil {
			return next, err
		}
		if !terminal {
			next.jobState, next.attemptState, next.leaseState = runnerstore.JobCancelling, runnerstore.AttemptCancelling, "cancelling"
		}
	case runnerprotocol.KindTerminal:
		if (current.jobState != runnerstore.JobRunning && current.jobState != runnerstore.JobCancelling) ||
			(current.attemptState != runnerstore.AttemptRunning && current.attemptState != runnerstore.AttemptCancelling) {
			return next, runnerstore.Failure(runnerstore.ErrorConflict, "terminal event requires a running or cancelling attempt", nil)
		}
		if current.openEffectCount != 0 {
			return next, runnerstore.Failure(runnerstore.ErrorReconciliation, "terminal cannot close an open effect boundary", nil)
		}
		status := message.Payload["status"].(string)
		reason := message.Payload["terminalReason"]
		result := message.Payload["resultHash"]
		if status == string(runnerprotocol.TerminalReconciliationRequired) {
			reconciliationID, err := insertReconciliation(ctx, tx, message, "WORKFLOW_RUNNER_RECONCILIATION_REQUIRED", now)
			if err != nil {
				return next, err
			}
			next.jobState, next.attemptState = runnerstore.JobReconciliationRequired, runnerstore.AttemptReconciliationRequired
			next.reconciliationID = reconciliationID
		} else {
			next.jobState, next.attemptState = runnerstore.JobTerminal, runnerstore.AttemptTerminal
		}
		next.leaseState = "released"
		next.terminalStatus, next.terminalReason = status, reason
		if result != nil {
			decoded, _ := hex.DecodeString(result.(string))
			next.resultHash = decoded
		}
	default:
		return next, runnerstore.Failure(runnerstore.ErrorInputInvalid, "event kind is not receiptable", nil)
	}
	return next, nil
}

func validateEventTime(current activeAttempt, message runnerprotocol.Envelope, now time.Time, tx pgx.Tx) error {
	if message.Kind == runnerprotocol.KindLeaseAccept {
		if now.After(current.offerExpiresAt) {
			return runnerstore.Failure(runnerstore.ErrorLeaseExpired, "lease offer expired before acceptance", nil)
		}
		if message.Payload["leaseExpiresAt"] != runnerstore.CanonicalTimestamp(current.leaseExpiresAt) {
			return runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "lease accept changed the durable expiry", nil)
		}
		return nil
	}
	if now.After(current.leaseExpiresAt) {
		if message.Kind == runnerprotocol.KindCancelAck || (message.Kind == runnerprotocol.KindTerminal && current.jobState == runnerstore.JobCancelling) {
			return nil
		}
		return runnerstore.Failure(runnerstore.ErrorLeaseExpired, "runner lease expired", nil)
	}
	if message.Kind == runnerprotocol.KindHeartbeat && message.Payload["leaseExpiresAt"] != runnerstore.CanonicalTimestamp(current.leaseExpiresAt) {
		return runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "heartbeat changed the durable lease expiry", nil)
	}
	return nil
}

func applyEffectBoundary(ctx context.Context, tx pgx.Tx, message runnerprotocol.Envelope, now time.Time) error {
	switch message.Kind {
	case runnerprotocol.KindEffectIntent:
		effectHash, _ := hex.DecodeString(message.Payload["effectHash"].(string))
		if _, err := tx.Exec(ctx, `
INSERT INTO workflow_runner_effect_boundaries (
    attempt_id, effect_id, intent_event_id, intent_hash, opened_at
) VALUES ($1,$2,$3,$4,$5)`, *message.AttemptID, message.Payload["effectId"], message.EventID, effectHash, now); err != nil {
			return mapWriteFailure("open runner effect boundary", err)
		}
	case runnerprotocol.KindEffectOutcome:
		outcomeHash, _ := hex.DecodeString(message.Payload["outcomeHash"].(string))
		tag, err := tx.Exec(ctx, `
UPDATE workflow_runner_effect_boundaries
SET outcome_event_id=$1, outcome_hash=$2, outcome_status=$3, closed_at=$4
WHERE attempt_id=$5 AND effect_id=$6 AND outcome_event_id IS NULL`,
			message.EventID, outcomeHash, message.Payload["status"], now,
			*message.AttemptID, message.Payload["effectId"])
		if err != nil {
			return mapWriteFailure("close runner effect boundary", err)
		}
		if tag.RowsAffected() != 1 {
			return runnerstore.Failure(runnerstore.ErrorConflict, "effect boundary is absent or already closed", nil)
		}
	}
	return nil
}

func acknowledgeCancel(ctx context.Context, tx pgx.Tx, message runnerprotocol.Envelope, now time.Time) error {
	tag, err := tx.Exec(ctx, `
UPDATE workflow_runner_cancel_controls
SET state='acknowledged', ack_event_id=$1, acknowledged_at=$2
WHERE cancel_id=$3 AND attempt_id=$4 AND lease_id=$5 AND fencing_token=$6
  AND state IN ('pending','sent')`,
		message.EventID, now, message.Payload["cancelId"], *message.AttemptID,
		*message.LeaseID, *message.FencingToken)
	if err != nil {
		return mapWriteFailure("acknowledge runner cancellation", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "cancel acknowledgement does not bind an active control", nil)
	}
	return nil
}

func insertReconciliation(ctx context.Context, tx pgx.Tx, message runnerprotocol.Envelope, code string, now time.Time) (string, error) {
	reconciliationID, err := randomToken("runner-reconciliation")
	if err != nil {
		return "", databaseFailure("generate runner reconciliation id", err)
	}
	prepared, err := runnerprotocol.PrepareEnvelope(message)
	if err != nil {
		return "", err
	}
	evidenceHash := sha256.Sum256(append([]byte("openslack.workflow-runner.reconciliation.v1\x00"), prepared.Body...))
	if _, err := tx.Exec(ctx, `
INSERT INTO workflow_runner_reconciliations (
    reconciliation_id, workspace_id, job_id, attempt_id, code, evidence_hash, created_at
) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		reconciliationID, message.WorkspaceID, *message.JobID, *message.AttemptID,
		code, evidenceHash[:], now); err != nil {
		return "", mapWriteFailure("insert runner reconciliation", err)
	}
	return reconciliationID, nil
}

func heartbeatTime(message runnerprotocol.Envelope, now time.Time) any {
	if message.Kind == runnerprotocol.KindHeartbeat {
		return now
	}
	return nil
}

func readActiveAttempt(row pgx.Row) (activeAttempt, error) {
	var value activeAttempt
	var currentAttempt pgtype.Text
	var terminalStatus, terminalReason, reconciliationID pgtype.Text
	var resultHash []byte
	if err := row.Scan(
		&value.jobState, &value.jobRevision, &value.currentFence, &currentAttempt,
		&value.attemptState, &value.workerSequence, &value.controlSequence,
		&value.executionStarted, &value.openEffectCount,
		&value.leaseState, &value.offerExpiresAt, &value.leaseExpiresAt,
		&value.dispatchFailures,
		&terminalStatus, &terminalReason, &resultHash, &reconciliationID,
	); errors.Is(err, pgx.ErrNoRows) {
		return activeAttempt{}, runnerstore.Failure(runnerstore.ErrorNotFound, "active runner attempt was not found", err)
	} else if err != nil {
		return activeAttempt{}, databaseFailure("read active runner attempt", err)
	}
	if !currentAttempt.Valid {
		return activeAttempt{}, runnerstore.Failure(runnerstore.ErrorConflict, "runner job has no active attempt", nil)
	}
	value.currentAttemptID = currentAttempt.String
	if terminalStatus.Valid {
		value.terminalStatus = terminalStatus.String
	}
	if terminalReason.Valid {
		value.terminalReason = terminalReason.String
	}
	if len(resultHash) > 0 {
		value.resultHash = resultHash
	}
	if reconciliationID.Valid {
		value.reconciliationID = reconciliationID.String
	}
	return value, nil
}

func readRecordedEvent(row pgx.Row) (runnerstore.RecordedEvent, []byte, error) {
	var fingerprint, receiptBytes []byte
	var jobState runnerstore.JobState
	var attemptState runnerstore.AttemptState
	if err := row.Scan(&fingerprint, &receiptBytes, &jobState, &attemptState); err != nil {
		return runnerstore.RecordedEvent{}, nil, err
	}
	receipt, err := runnerprotocol.ValidateCanonicalEnvelopeBytes(receiptBytes)
	if err != nil {
		return runnerstore.RecordedEvent{}, nil, runnerstore.Failure(runnerstore.ErrorDatabase, "stored event receipt is invalid", err)
	}
	status := runnerstore.ReceiptStatus(receipt.Payload["status"].(string))
	return runnerstore.RecordedEvent{
		Receipt: receipt, ReceiptBytes: append([]byte(nil), receiptBytes...),
		Status: status, JobState: jobState, AttemptState: attemptState,
	}, append([]byte(nil), fingerprint...), nil
}

func (repository *Repository) resolveEventCommit(input runnerstore.RecordEventInput, prepared runnerprotocol.PreparedMessage, fingerprint []byte, commitErr error) (runnerstore.RecordedEvent, error) {
	ctx, cancel := context.WithTimeout(context.Background(), commitRecoveryTimeout)
	defer cancel()
	current, err := repository.ReadJob(ctx, input.Message.WorkspaceID, *input.Message.JobID)
	if err == nil && current.FencingToken != *input.Message.FencingToken {
		return runnerstore.RecordedEvent{}, repository.staleFence("event commit recovery found a newer fence", commitErr)
	}
	result, raw, readErr := readRecordedEvent(repository.pool.QueryRow(ctx, eventReceiptByKeySQL, prepared.IdempotencyKey))
	if readErr == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) != 1 {
			return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "event commit recovery found another fingerprint", commitErr)
		}
		return result, nil
	}
	if !errors.Is(readErr, pgx.ErrNoRows) {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "event commit outcome cannot be read", errors.Join(commitErr, readErr))
	}
	return repository.persistEventReconciliation(ctx, input, prepared, fingerprint, commitErr)
}

func (repository *Repository) persistEventReconciliation(ctx context.Context, input runnerstore.RecordEventInput, prepared runnerprotocol.PreparedMessage, fingerprint []byte, commitErr error) (runnerstore.RecordedEvent, error) {
	message := input.Message
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "begin event reconciliation", errors.Join(commitErr, err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, prepared.IdempotencyKey, message.WorkspaceID, *message.JobID); err != nil {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "lock event reconciliation", errors.Join(commitErr, err))
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, message.WorkspaceID, *message.JobID))
	if err != nil {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "read event reconciliation attempt", errors.Join(commitErr, err))
	}
	if current.currentFence != *message.FencingToken || current.currentAttemptID != *message.AttemptID {
		return runnerstore.RecordedEvent{}, repository.staleFence("event reconciliation found a newer attempt", commitErr)
	}
	if result, raw, readErr := readRecordedEvent(tx.QueryRow(ctx, eventReceiptByKeySQL, prepared.IdempotencyKey)); readErr == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) != 1 {
			return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "event reconciliation fingerprint differs", commitErr)
		}
		return result, nil
	} else if !errors.Is(readErr, pgx.ErrNoRows) {
		return runnerstore.RecordedEvent{}, databaseFailure("read event reconciliation receipt", readErr)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	reconciliationID, err := insertReconciliation(ctx, tx, message, "WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN", now)
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	code := runnerprotocol.ErrorCommitOutcomeUnknown
	nextControlSequence := current.controlSequence + 1
	receipt, err := runnerprotocol.CreateEventReceipt(message, runnerprotocol.CreateReceiptInput{
		Sequence: nextControlSequence, SentAt: runnerstore.CanonicalTimestamp(now),
		Status: runnerprotocol.ReceiptReconciliationRequired, ControlBuildHash: input.ControlBuildHash,
		ErrorCode: &code,
	})
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	receiptPrepared, err := runnerprotocol.PrepareEnvelope(receipt)
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	eventDigest, _ := hex.DecodeString(prepared.MessageDigest)
	receiptDigest, _ := hex.DecodeString(receiptPrepared.MessageDigest)
	if _, err := tx.Exec(ctx, workerEventInsertSQL,
		message.EventID, message.WorkspaceID, *message.JobID, *message.AttemptID, *message.LeaseID,
		*message.FencingToken, *message.Sequence, string(message.Kind), prepared.IdempotencyKey,
		fingerprint, eventDigest, prepared.Body, now); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("insert reconciled worker event", err)
	}
	if _, err := tx.Exec(ctx, controlInsertSQL,
		receipt.EventID, *message.AttemptID, "event_receipt", nextControlSequence,
		receiptPrepared.Body, receiptDigest, now); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("insert reconciliation receipt outbox", err)
	}
	if _, err := tx.Exec(ctx, eventReceiptInsertSQL,
		receipt.EventID, message.EventID, "reconciliation_required", receiptPrepared.Body,
		receiptDigest, reconciliationID, now); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("insert reconciled event receipt", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE workflow_runner_attempts
SET state='reconciliation_required', worker_sequence=$1, control_sequence=$2,
    process_exit_class=COALESCE(process_exit_class,'crashed'), finished_at=$3, updated_at=$3
WHERE attempt_id=$4`, *message.Sequence, nextControlSequence, now, *message.AttemptID); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("mark reconciled attempt", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE workflow_runner_leases SET state='released', updated_at=$1 WHERE lease_id=$2`, now, *message.LeaseID); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("release reconciled lease", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE workflow_runner_jobs
SET state='reconciliation_required', revision=revision+1,
    terminal_status='reconciliation_required', terminal_reason='commit_outcome_unknown',
    reconciliation_id=$1, updated_at=$2
WHERE workspace_id=$3 AND job_id=$4`, reconciliationID, now, message.WorkspaceID, *message.JobID); err != nil {
		return runnerstore.RecordedEvent{}, mapWriteFailure("mark reconciled runner job", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return runnerstore.RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "commit event reconciliation", errors.Join(commitErr, err))
	}
	return runnerstore.RecordedEvent{
		Receipt: receipt, ReceiptBytes: receiptPrepared.Body,
		Status:       runnerstore.ReceiptReconciliationRequired,
		JobState:     runnerstore.JobReconciliationRequired,
		AttemptState: runnerstore.AttemptReconciliationRequired,
	}, nil
}

var _ = fmt.Sprintf
