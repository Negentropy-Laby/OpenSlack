package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func (repository *Repository) RecordV2Event(ctx context.Context, input runnerstore.V2RecordEventInput) (runnerstore.V2RecordedEvent, error) {
	prepared, err := prepareV2Message(input.Message)
	if err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	message := input.Message
	if !bytes.Equal([]byte(prepared.Body), input.ExactBytes) || message.Kind == authoritycontract.KindHello {
		return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorHashMismatch, "v2 event bytes are not exact canonical runner bytes", nil)
	}
	direction, _ := authoritycontract.DirectionForKind(message.Kind)
	if direction != authoritycontract.DirectionRunnerToControl || message.JobID == nil || message.AttemptID == nil || message.LeaseID == nil || message.FencingToken == nil || message.Sequence == nil || message.RunRevision == nil || message.ResumeGeneration == nil {
		return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "v2 leased event binding is incomplete", nil)
	}
	// Replay is resolved before consulting mutable attempt state. An authority
	// receipt may already have advanced the run revision or resume generation,
	// so validating current bindings first would make an exact response-loss
	// retry impossible.
	if recorded, found, replayErr := repository.readV2EventReplay(ctx, prepared, input.ExactBytes); replayErr != nil {
		return runnerstore.V2RecordedEvent{}, replayErr
	} else if found {
		return recorded, nil
	}
	needsAuthority := message.Kind == authoritycontract.KindEffectIntent || message.Kind == authoritycontract.KindCheckpointCommit ||
		message.Kind == authoritycontract.KindBudgetReserveRequest || message.Kind == authoritycontract.KindBudgetUsageReport ||
		(message.Kind == authoritycontract.KindLeaseAccept && *message.ResumeGeneration > 0)
	if !needsAuthority {
		return repository.finalizeV2Event(ctx, input, prepared, nil)
	}
	staged, err := repository.stageV2Event(ctx, input, prepared)
	if err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	if staged.recorded != nil {
		return *staged.recorded, nil
	}
	lease := runnerstore.AttemptLease{WorkspaceID: message.WorkspaceID, JobID: *message.JobID, WorkflowRunID: *message.WorkflowRunID,
		AttemptID: *message.AttemptID, LeaseID: *message.LeaseID, FencingToken: *message.FencingToken,
		RequiredProtocolVersion: authoritycontract.ProtocolVersion, RunRevision: *message.RunRevision, ResumeGeneration: *message.ResumeGeneration}
	request := runnerstore.V2AuthorityRequest{Message: message, ExactBytes: input.ExactBytes, Lease: lease}
	result, err := repository.callV2Authority(ctx, request, prepared, staged.authorityCommitted)
	if err != nil {
		// A response loss is never retried with a new key. Only the exact durable
		// receipt point-read may prove the authority mutation.
		result, err = repository.callV2Authority(ctx, request, prepared, true)
		if err != nil {
			return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 authority outcome cannot be proven by exact receipt", err)
		}
	}
	if err := repository.latchV2AuthorityResult(ctx, input, prepared, result); err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	recorded, err := repository.finalizeV2Event(ctx, input, prepared, &result)
	if err != nil {
		repository.markV2EventReconciliation(ctx, input.Message.EventID)
		return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 authority committed but runner finalization failed", err)
	}
	return recorded, nil
}

type stagedV2Event struct {
	recorded           *runnerstore.V2RecordedEvent
	authorityCommitted bool
}

const v2EventReplaySQL = `
SELECT e.request_fingerprint,e.exact_event_bytes,e.workspace_id,e.job_id,e.attempt_id,e.lease_id,
       e.fencing_token,e.sequence,e.kind,e.idempotency_key,e.message_digest,
       r.exact_receipt_bytes,r.receipt_digest,r.status,r.reconciliation_id,
       rc.control_event_id,rc.attempt_id,rc.kind,rc.sequence,rc.exact_message_bytes,rc.message_digest,
       d.exact_message_bytes,d.control_event_id,d.attempt_id,d.kind,d.sequence,d.message_digest,
       b.authority_receipt_hash,i.exact_authority_receipt_bytes,i.authority_operation,ps.control_build_hash,
       j.state,a.state
FROM workflow_runner_worker_events e
JOIN workflow_runner_event_receipts r ON r.received_event_id=e.event_id
JOIN workflow_runner_control_messages rc ON rc.control_event_id=r.receipt_event_id
JOIN workflow_runner_attempts a ON a.attempt_id=e.attempt_id
LEFT JOIN workflow_runner_process_sessions ps ON ps.attempt_id=e.attempt_id AND ps.protocol_version='openslack.workflow_runner.v2'
JOIN workflow_runner_jobs j ON j.workspace_id=e.workspace_id AND j.job_id=e.job_id
JOIN workflow_runner_v2_decision_bindings b ON b.received_event_id=e.event_id
LEFT JOIN workflow_runner_control_messages d ON d.control_event_id=b.decision_control_event_id
LEFT JOIN workflow_runner_v2_event_inbox i ON i.event_id=e.event_id
WHERE e.idempotency_key=$1`

func (repository *Repository) readV2EventReplay(ctx context.Context, prepared authoritycontract.PreparedMessage, exactEventBytes []byte) (runnerstore.V2RecordedEvent, bool, error) {
	return readV2EventReplayRow(repository.pool.QueryRow(ctx, v2EventReplaySQL, prepared.IdempotencyKey), prepared, exactEventBytes)
}

func readV2EventReplayRow(row pgx.Row, prepared authoritycontract.PreparedMessage, exactEventBytes []byte) (runnerstore.V2RecordedEvent, bool, error) {
	var fingerprint, storedEvent, eventDigest, receiptBytes, receiptDigest, receiptControlBytes, receiptControlDigest []byte
	var workspaceID, jobID, attemptID, leaseID, eventKind, idempotencyKey string
	var fence, workerSequence int64
	var receiptStatus, receiptControlID, receiptControlAttempt, receiptControlKind string
	var receiptControlSequence int64
	var receiptReconciliationID *string
	var decisionBytes, decisionDigest, authorityReceiptHash, authorityReceiptBytes, durableControlBuildHash []byte
	var decisionControlID, decisionAttempt, decisionKind, authorityOperation *string
	var decisionSequence *int64
	var jobState, attemptState string
	if err := row.Scan(&fingerprint, &storedEvent, &workspaceID, &jobID, &attemptID, &leaseID,
		&fence, &workerSequence, &eventKind, &idempotencyKey, &eventDigest,
		&receiptBytes, &receiptDigest, &receiptStatus, &receiptReconciliationID,
		&receiptControlID, &receiptControlAttempt, &receiptControlKind, &receiptControlSequence, &receiptControlBytes, &receiptControlDigest,
		&decisionBytes, &decisionControlID, &decisionAttempt, &decisionKind, &decisionSequence, &decisionDigest,
		&authorityReceiptHash, &authorityReceiptBytes, &authorityOperation, &durableControlBuildHash, &jobState, &attemptState); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return runnerstore.V2RecordedEvent{}, false, nil
		}
		return runnerstore.V2RecordedEvent{}, false, databaseFailure("read v2 event replay", err)
	}
	expectedFingerprint, err := decodeFingerprint(prepared.RequestFingerprint)
	if err != nil {
		return runnerstore.V2RecordedEvent{}, false, err
	}
	expectedEventDigest, _ := hex.DecodeString(prepared.MessageDigest)
	event, decodeErr := authoritycontract.DecodeMessageJSON(exactEventBytes)
	if decodeErr != nil || event.JobID == nil || event.AttemptID == nil || event.LeaseID == nil || event.FencingToken == nil || event.Sequence == nil ||
		subtle.ConstantTimeCompare(fingerprint, expectedFingerprint) != 1 || subtle.ConstantTimeCompare(storedEvent, exactEventBytes) != 1 ||
		subtle.ConstantTimeCompare(eventDigest, expectedEventDigest) != 1 || workspaceID != event.WorkspaceID || jobID != *event.JobID ||
		attemptID != *event.AttemptID || leaseID != *event.LeaseID || fence != *event.FencingToken || workerSequence != *event.Sequence ||
		eventKind != string(event.Kind) || idempotencyKey != prepared.IdempotencyKey {
		return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "v2 event key is bound to different bytes", nil)
	}
	receipt, err := authoritycontract.DecodeMessageJSON(receiptBytes)
	if err != nil {
		return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 runner receipt is invalid", err)
	}
	receiptPrepared, err := prepareV2Message(receipt)
	storedReceiptDigest, _ := hex.DecodeString(receiptPrepared.MessageDigest)
	if err != nil || !bytes.Equal([]byte(receiptPrepared.Body), receiptBytes) || !bytes.Equal(receiptControlBytes, receiptBytes) ||
		subtle.ConstantTimeCompare(receiptDigest, storedReceiptDigest) != 1 || subtle.ConstantTimeCompare(receiptControlDigest, storedReceiptDigest) != 1 ||
		receiptStatus != string(runnerstore.ReceiptAccepted) || receiptReconciliationID != nil ||
		receiptControlID != receipt.EventID || receiptControlAttempt != attemptID || receiptControlKind != string(authoritycontract.KindEventReceipt) ||
		receipt.Sequence == nil || receiptControlSequence != *receipt.Sequence || validateStoredV2EventReceipt(event, prepared, receipt, hex.EncodeToString(durableControlBuildHash)) != nil {
		return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 runner receipt binding is invalid", err)
	}
	result := runnerstore.V2RecordedEvent{Receipt: receipt, ReceiptBytes: receiptBytes, Status: runnerstore.ReceiptAccepted,
		JobState: runnerstore.JobState(jobState), AttemptState: runnerstore.AttemptState(attemptState), Duplicate: true}
	if len(decisionBytes) != 0 {
		decision, decodeErr := authoritycontract.DecodeMessageJSON(decisionBytes)
		if decodeErr != nil {
			return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 decision is invalid", decodeErr)
		}
		decisionPrepared, prepareErr := prepareV2Message(decision)
		storedDecisionDigest, _ := hex.DecodeString(decisionPrepared.MessageDigest)
		if prepareErr != nil || !bytes.Equal([]byte(decisionPrepared.Body), decisionBytes) || decisionControlID == nil || decisionAttempt == nil ||
			decisionKind == nil || decisionSequence == nil || *decisionControlID != decision.EventID || *decisionAttempt != attemptID ||
			*decisionKind != string(decision.Kind) || decision.Sequence == nil || *decisionSequence != *decision.Sequence ||
			subtle.ConstantTimeCompare(decisionDigest, storedDecisionDigest) != 1 {
			return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 decision durable binding is invalid", prepareErr)
		}
		result.Decision = &decision
		result.DecisionBytes = decisionBytes
	} else if decisionControlID != nil || decisionAttempt != nil || decisionKind != nil || decisionSequence != nil || len(decisionDigest) != 0 {
		return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 decision null binding is invalid", nil)
	}
	if authorityOperation != nil || len(authorityReceiptBytes) != 0 || len(authorityReceiptHash) != 0 {
		if authorityOperation == nil || len(authorityReceiptBytes) == 0 || len(authorityReceiptHash) != sha256.Size {
			return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 authority replay binding is incomplete", nil)
		}
		digest := sha256.Sum256(authorityReceiptBytes)
		if subtle.ConstantTimeCompare(authorityReceiptHash, digest[:]) != 1 {
			return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 authority receipt hash drifted", nil)
		}
		expectedRevision, expectedGeneration := *event.RunRevision, *event.ResumeGeneration
		if event.Kind == authoritycontract.KindBudgetReserveRequest || event.Kind == authoritycontract.KindBudgetUsageReport || event.Kind == authoritycontract.KindLeaseAccept {
			expectedRevision++
		}
		if event.Kind == authoritycontract.KindLeaseAccept {
			expectedGeneration++
		}
		outcome := runnerstore.V2AuthorityOutcome{Operation: authoritycontract.ReceiptOperation(*authorityOperation), ExactReceiptBytes: authorityReceiptBytes,
			AcceptedRunRevision: expectedRevision, AcceptedResumeGeneration: expectedGeneration, Decision: result.Decision, DecisionBytes: result.DecisionBytes}
		if _, _, validateErr := validateV2AuthorityResult(event, receiptControlSequence+1, outcome); validateErr != nil {
			return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 authority replay binding is invalid", validateErr)
		}
	} else if result.Decision != nil {
		return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 decision has no authority receipt binding", nil)
	}
	return result, true, nil
}

func validateStoredV2EventReceipt(event authoritycontract.Message, prepared authoritycontract.PreparedMessage, receipt authoritycontract.Message, controlBuildHash string) error {
	if receipt.JobID == nil || receipt.WorkflowRunID == nil || receipt.AttemptID == nil || receipt.LeaseID == nil || receipt.FencingToken == nil ||
		receipt.AuthorityBackend == nil || receipt.Authority == nil || receipt.RoutingEpoch == nil || receipt.AuthorityBuildHash == nil ||
		receipt.RunRevision == nil || receipt.ResumeGeneration == nil || receipt.Sequence == nil ||
		receipt.WorkspaceID != event.WorkspaceID || *receipt.JobID != *event.JobID || *receipt.WorkflowRunID != *event.WorkflowRunID ||
		*receipt.AttemptID != *event.AttemptID || *receipt.LeaseID != *event.LeaseID || *receipt.FencingToken != *event.FencingToken ||
		*receipt.AuthorityBackend != *event.AuthorityBackend || *receipt.Authority != *event.Authority || *receipt.RoutingEpoch != *event.RoutingEpoch ||
		*receipt.AuthorityBuildHash != *event.AuthorityBuildHash || *receipt.ResumeGeneration != *event.ResumeGeneration ||
		receipt.EventID != "receipt-"+event.EventID || receipt.CorrelationID != event.CorrelationID ||
		receipt.Payload["receivedEventId"] != event.EventID || receipt.Payload["receivedKind"] != string(event.Kind) ||
		receipt.Payload["receivedSequence"] != *event.Sequence || receipt.Payload["receivedDigest"] != prepared.MessageDigest ||
		receipt.Payload["receivedIdempotencyKey"] != prepared.IdempotencyKey || receipt.Payload["receivedFingerprint"] != prepared.RequestFingerprint ||
		receipt.Payload["controlBuildHash"] != controlBuildHash ||
		receipt.Payload["status"] != string(authoritycontract.ReceiptAccepted) || receipt.Payload["committedAt"] != receipt.SentAt || receipt.Payload["errorCode"] != nil {
		return runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "stored v2 event receipt is cross-spliced", nil)
	}
	expectedRevision := *event.RunRevision
	if event.Kind == authoritycontract.KindBudgetReserveRequest || event.Kind == authoritycontract.KindBudgetUsageReport ||
		(event.Kind == authoritycontract.KindLeaseAccept && *event.ResumeGeneration > 0) {
		expectedRevision++
	}
	if *receipt.RunRevision != expectedRevision {
		return runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "stored v2 event receipt revision drifted", nil)
	}
	return nil
}

func (repository *Repository) latchV2AuthorityResult(ctx context.Context, input runnerstore.V2RecordEventInput, prepared authoritycontract.PreparedMessage, result runnerstore.V2AuthorityOutcome) error {
	if len(result.ExactReceiptBytes) == 0 {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 authority result has no exact receipt", nil)
	}
	receiptHash := sha256.Sum256(result.ExactReceiptBytes)
	fingerprint, _ := decodeFingerprint(prepared.RequestFingerprint)
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return databaseFailure("begin v2 authority latch", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, prepared.IdempotencyKey, input.Message.WorkspaceID, *input.Message.JobID); err != nil {
		return err
	}
	var state string
	var storedFingerprint, storedEvent, storedHash, storedReceipt []byte
	if err := tx.QueryRow(ctx, `SELECT state,request_fingerprint,exact_event_bytes,authority_receipt_hash,exact_authority_receipt_bytes
FROM workflow_runner_v2_event_inbox WHERE event_id=$1 FOR UPDATE`, input.Message.EventID).Scan(
		&state, &storedFingerprint, &storedEvent, &storedHash, &storedReceipt); err != nil {
		return databaseFailure("read v2 authority latch", err)
	}
	if subtle.ConstantTimeCompare(storedFingerprint, fingerprint) != 1 || subtle.ConstantTimeCompare(storedEvent, input.ExactBytes) != 1 {
		return runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "v2 authority latch is bound to different event bytes", nil)
	}
	if state == "authority_committed" {
		if subtle.ConstantTimeCompare(storedHash, receiptHash[:]) != 1 || subtle.ConstantTimeCompare(storedReceipt, result.ExactReceiptBytes) != 1 {
			return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 authority returned different receipt bytes for one event", nil)
		}
		return repository.commit(ctx, tx)
	}
	if state != "pending_authority" {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 authority latch is not pending", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE workflow_runner_v2_event_inbox
SET state='authority_committed',authority_operation=$1,authority_receipt_hash=$2,exact_authority_receipt_bytes=$3,updated_at=$4
WHERE event_id=$5 AND state='pending_authority'`, string(result.Operation), receiptHash[:], result.ExactReceiptBytes, now, input.Message.EventID)
	if err != nil {
		return mapWriteFailure("latch v2 authority receipt", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 authority latch CAS lost", nil)
	}
	return repository.commit(ctx, tx)
}

func (repository *Repository) markV2EventReconciliation(ctx context.Context, eventID string) {
	reconciliationID := "v2-reconciliation-" + eventID
	_, _ = repository.pool.Exec(ctx, `UPDATE workflow_runner_v2_event_inbox
SET state='reconciliation_required',reconciliation_id=$1,updated_at=clock_timestamp()
WHERE event_id=$2 AND state='authority_committed'`, reconciliationID, eventID)
}

func (repository *Repository) callV2Authority(ctx context.Context, request runnerstore.V2AuthorityRequest, prepared authoritycontract.PreparedMessage, pointRead bool) (runnerstore.V2AuthorityOutcome, error) {
	kind := request.Message.Kind
	key, fingerprint := prepared.IdempotencyKey, prepared.RequestFingerprint
	switch kind {
	case authoritycontract.KindCheckpointCommit:
		if repository.v2Authorities.Checkpoint == nil {
			break
		}
		if pointRead {
			return repository.v2Authorities.Checkpoint.ReadCheckpointReceipt(ctx, key, fingerprint)
		}
		return repository.v2Authorities.Checkpoint.CommitCheckpoint(ctx, request)
	case authoritycontract.KindEffectIntent:
		if repository.v2Authorities.Effect == nil {
			break
		}
		if pointRead {
			return repository.v2Authorities.Effect.ReadEffectReceipt(ctx, key, fingerprint)
		}
		return repository.v2Authorities.Effect.AuthorizeEffect(ctx, request)
	case authoritycontract.KindBudgetReserveRequest, authoritycontract.KindBudgetUsageReport:
		if repository.v2Authorities.Budget == nil {
			break
		}
		if pointRead {
			return repository.v2Authorities.Budget.ReadBudgetReceipt(ctx, kind, key, fingerprint)
		}
		if kind == authoritycontract.KindBudgetReserveRequest {
			return repository.v2Authorities.Budget.ReserveBudget(ctx, request)
		}
		return repository.v2Authorities.Budget.SettleBudget(ctx, request)
	case authoritycontract.KindLeaseAccept:
		if repository.v2Authorities.Resume == nil {
			break
		}
		if pointRead {
			return repository.v2Authorities.Resume.ReadResumeReceipt(ctx, key, fingerprint)
		}
		return repository.v2Authorities.Resume.AdvanceResume(ctx, request)
	}
	return runnerstore.V2AuthorityOutcome{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "required v2 operation authority port is unavailable after durable event staging", nil)
}

func (repository *Repository) stageV2Event(ctx context.Context, input runnerstore.V2RecordEventInput, prepared authoritycontract.PreparedMessage) (stagedV2Event, error) {
	message := input.Message
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return stagedV2Event{}, databaseFailure("begin v2 event staging", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, prepared.IdempotencyKey, message.WorkspaceID, *message.JobID); err != nil {
		return stagedV2Event{}, err
	}
	if recorded, found, replayErr := readV2EventReplayRow(tx.QueryRow(ctx, v2EventReplaySQL, prepared.IdempotencyKey), prepared, input.ExactBytes); replayErr != nil {
		return stagedV2Event{}, replayErr
	} else if found {
		recorded.Duplicate = true
		return stagedV2Event{recorded: &recorded}, nil
	}
	fingerprint, _ := decodeFingerprint(prepared.RequestFingerprint)
	digest, _ := hex.DecodeString(prepared.MessageDigest)
	var existingID, existingKey, existingState string
	var existingFingerprint, existingDigest, existingBytes []byte
	readErr := tx.QueryRow(ctx, `SELECT event_id,idempotency_key,request_fingerprint,message_digest,exact_event_bytes,state
FROM workflow_runner_v2_event_inbox
WHERE event_id=$1 OR idempotency_key=$2 OR (attempt_id=$3 AND worker_sequence=$4)
FOR UPDATE`, message.EventID, prepared.IdempotencyKey, *message.AttemptID, *message.Sequence).Scan(
		&existingID, &existingKey, &existingFingerprint, &existingDigest, &existingBytes, &existingState)
	if readErr == nil {
		if existingID != message.EventID || existingKey != prepared.IdempotencyKey ||
			subtle.ConstantTimeCompare(existingFingerprint, fingerprint) != 1 || subtle.ConstantTimeCompare(existingDigest, digest) != 1 ||
			subtle.ConstantTimeCompare(existingBytes, input.ExactBytes) != 1 {
			return stagedV2Event{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "v2 event identity is bound to different bytes", nil)
		}
		switch existingState {
		case "pending_authority":
			return stagedV2Event{}, nil
		case "authority_committed":
			return stagedV2Event{authorityCommitted: true}, nil
		case "runner_committed":
			return stagedV2Event{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 committed inbox is missing its runner receipt", nil)
		default:
			return stagedV2Event{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 event is latched for reconciliation", nil)
		}
	}
	if !errors.Is(readErr, pgx.ErrNoRows) {
		return stagedV2Event{}, databaseFailure("read v2 staged event", readErr)
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, message.WorkspaceID, *message.JobID))
	if err != nil {
		return stagedV2Event{}, err
	}
	if err := validateV2CurrentBinding(ctx, tx, current, message); err != nil {
		return stagedV2Event{}, err
	}
	if *message.Sequence != current.workerSequence+1 {
		return stagedV2Event{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "v2 worker event sequence is not the exact successor", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return stagedV2Event{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO workflow_runner_v2_event_inbox (
event_id,workspace_id,job_id,attempt_id,lease_id,fencing_token,worker_sequence,kind,run_revision,resume_generation,
idempotency_key,request_fingerprint,message_digest,exact_event_bytes,state,created_at,updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending_authority',$15,$15)`, message.EventID, message.WorkspaceID, *message.JobID, *message.AttemptID,
		*message.LeaseID, *message.FencingToken, *message.Sequence, string(message.Kind), *message.RunRevision,
		*message.ResumeGeneration, prepared.IdempotencyKey, fingerprint, digest, input.ExactBytes, now)
	if err != nil {
		return stagedV2Event{}, mapWriteFailure("stage v2 authority event", err)
	}
	if err := repository.commit(ctx, tx); err != nil {
		return stagedV2Event{}, err
	}
	return stagedV2Event{}, nil
}

func (repository *Repository) finalizeV2Event(ctx context.Context, input runnerstore.V2RecordEventInput, prepared authoritycontract.PreparedMessage, authority *runnerstore.V2AuthorityOutcome) (runnerstore.V2RecordedEvent, error) {
	message := input.Message
	fingerprint, _ := decodeFingerprint(prepared.RequestFingerprint)
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.V2RecordedEvent{}, databaseFailure("begin v2 event finalization", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, prepared.IdempotencyKey, message.WorkspaceID, *message.JobID); err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	if result, found, readErr := readV2EventReplayRow(tx.QueryRow(ctx, v2EventReplaySQL, prepared.IdempotencyKey), prepared, input.ExactBytes); readErr != nil {
		return runnerstore.V2RecordedEvent{}, readErr
	} else if found {
		return result, nil
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, message.WorkspaceID, *message.JobID))
	if err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	if err := validateV2CurrentBinding(ctx, tx, current, message); err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	if *message.Sequence != current.workerSequence+1 {
		return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "v2 worker event sequence is not the exact successor", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	translated := translateV2Event(message)
	next, err := applyV2Event(ctx, tx, current, translated, message.Kind, now)
	if err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	nextControl := current.controlSequence + 1
	receiptRunRevision, nextResumeGeneration := *message.RunRevision, *message.ResumeGeneration
	if authority != nil {
		var validateErr error
		receiptRunRevision, nextResumeGeneration, validateErr = validateV2AuthorityResult(message, current.controlSequence+2, *authority)
		if validateErr != nil {
			return runnerstore.V2RecordedEvent{}, validateErr
		}
	}
	receipt := v2EventReceipt(message, prepared, nextControl, receiptRunRevision, *message.ResumeGeneration, input.ControlBuildHash, now)
	receiptPrepared, err := prepareV2Message(receipt)
	if err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	controlAdvance := int64(1)
	var decision *authoritycontract.Message
	var decisionBytes []byte
	var authorityHash []byte
	if authority != nil {
		authorityHashValue := sha256.Sum256(authority.ExactReceiptBytes)
		authorityHash = authorityHashValue[:]
		if authority.Decision != nil {
			decision, decisionBytes = authority.Decision, append([]byte(nil), authority.DecisionBytes...)
			controlAdvance++
		}
	}
	eventDigest, _ := hex.DecodeString(prepared.MessageDigest)
	receiptDigest, _ := hex.DecodeString(receiptPrepared.MessageDigest)
	if _, err := tx.Exec(ctx, workerEventInsertSQL, message.EventID, message.WorkspaceID, *message.JobID, *message.AttemptID,
		*message.LeaseID, *message.FencingToken, *message.Sequence, string(message.Kind), prepared.IdempotencyKey,
		fingerprint, eventDigest, input.ExactBytes, now); err != nil {
		return runnerstore.V2RecordedEvent{}, mapWriteFailure("insert v2 worker event", err)
	}
	if message.Kind == authoritycontract.KindEffectIntent || message.Kind == authoritycontract.KindEffectOutcome {
		if err := applyEffectBoundary(ctx, tx, translated, now); err != nil {
			return runnerstore.V2RecordedEvent{}, err
		}
	}
	if _, err := tx.Exec(ctx, controlInsertSQL, receipt.EventID, *message.AttemptID, "event_receipt", nextControl, []byte(receiptPrepared.Body), receiptDigest, now); err != nil {
		return runnerstore.V2RecordedEvent{}, mapWriteFailure("insert v2 event receipt", err)
	}
	if _, err := tx.Exec(ctx, eventReceiptInsertSQL, receipt.EventID, message.EventID, "accepted", []byte(receiptPrepared.Body), receiptDigest, nil, now); err != nil {
		return runnerstore.V2RecordedEvent{}, mapWriteFailure("insert durable v2 event receipt", err)
	}
	if decision != nil {
		decisionPrepared, _ := prepareV2Message(*decision)
		decisionDigest, _ := hex.DecodeString(decisionPrepared.MessageDigest)
		if _, err := tx.Exec(ctx, controlInsertSQL, decision.EventID, *message.AttemptID, string(decision.Kind), nextControl+1, decisionBytes, decisionDigest, now); err != nil {
			return runnerstore.V2RecordedEvent{}, mapWriteFailure("insert v2 authority decision", err)
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workflow_runner_v2_decision_bindings (
received_event_id,receipt_control_event_id,decision_control_event_id,authority_receipt_hash,created_at
) VALUES ($1,$2,$3,$4,$5)`, message.EventID, receipt.EventID, nullableDecisionID(decision), nullableBytes(authorityHash), now); err != nil {
		return runnerstore.V2RecordedEvent{}, mapWriteFailure("bind v2 receipt before decision", err)
	}
	if authority != nil {
		tag, err := tx.Exec(ctx, `UPDATE workflow_runner_v2_event_inbox SET state='runner_committed',authority_operation=$1,
authority_receipt_hash=$2,exact_authority_receipt_bytes=$3,updated_at=$4 WHERE event_id=$5 AND state='authority_committed'`,
			string(authority.Operation), authorityHash, authority.ExactReceiptBytes, now, message.EventID)
		if err != nil {
			return runnerstore.V2RecordedEvent{}, mapWriteFailure("finalize v2 event inbox", err)
		}
		if tag.RowsAffected() != 1 {
			return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 authority inbox finalization CAS lost", nil)
		}
		tag, err = tx.Exec(ctx, `UPDATE workflow_runner_v2_attempt_bindings
SET current_run_revision=$1,current_resume_generation=$2,last_authority_operation=$3,last_authority_event_id=$4
WHERE attempt_id=$5 AND current_run_revision=$6 AND current_resume_generation=$7`,
			receiptRunRevision, nextResumeGeneration, string(authority.Operation), message.EventID,
			*message.AttemptID, *message.RunRevision, *message.ResumeGeneration)
		if err != nil {
			return runnerstore.V2RecordedEvent{}, mapWriteFailure("advance v2 authority binding", err)
		}
		if tag.RowsAffected() != 1 {
			return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 authority binding CAS lost", nil)
		}
	}
	acceptedAt, startedAt, finishedAt := any(nil), any(nil), any(nil)
	if message.Kind == authoritycontract.KindLeaseAccept {
		acceptedAt, startedAt = now, now
	}
	if message.Kind == authoritycontract.KindTerminal || message.Kind == authoritycontract.KindLeaseReject {
		finishedAt = now
	}
	if _, err := tx.Exec(ctx, attemptUpdateSQL, string(next.attemptState), *message.Sequence, current.controlSequence+controlAdvance,
		next.executionStarted, next.openEffectCount, acceptedAt, startedAt, finishedAt, now, *message.AttemptID,
		current.workerSequence, current.controlSequence); err != nil {
		return runnerstore.V2RecordedEvent{}, mapWriteFailure("advance v2 runner attempt", err)
	}
	if _, err := tx.Exec(ctx, leaseUpdateSQL, next.leaseState, heartbeatTime(translated, now), now, *message.LeaseID, *message.FencingToken); err != nil {
		return runnerstore.V2RecordedEvent{}, mapWriteFailure("advance v2 runner lease", err)
	}
	if _, err := tx.Exec(ctx, jobEventUpdateSQL, string(next.jobState), next.terminalStatus, next.terminalReason,
		next.resultHash, next.reconciliationID, now, message.WorkspaceID, *message.JobID, current.jobRevision); err != nil {
		return runnerstore.V2RecordedEvent{}, mapWriteFailure("advance v2 runner job", err)
	}
	if err := repository.commit(ctx, tx); err != nil {
		return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "v2 event commit outcome is unknown", err)
	}
	return runnerstore.V2RecordedEvent{Receipt: receipt, ReceiptBytes: []byte(receiptPrepared.Body), Decision: decision,
		DecisionBytes: decisionBytes, Status: runnerstore.ReceiptAccepted, JobState: next.jobState, AttemptState: next.attemptState}, nil
}

func validateV2CurrentBinding(ctx context.Context, tx pgx.Tx, current activeAttempt, message authoritycontract.Message) error {
	if current.currentFence != *message.FencingToken || current.currentAttemptID != *message.AttemptID {
		return runnerstore.Failure(runnerstore.ErrorStaleFence, "v2 event runner fence is stale", nil)
	}
	var backend, authority string
	var epoch, revision, generation int64
	var build []byte
	if err := tx.QueryRow(ctx, `SELECT authority_backend,workflow_authority,routing_epoch,authority_build_hash,current_run_revision,current_resume_generation
FROM workflow_runner_v2_attempt_bindings WHERE attempt_id=$1`, *message.AttemptID).Scan(&backend, &authority, &epoch, &build, &revision, &generation); err != nil {
		return databaseFailure("read v2 attempt binding", err)
	}
	if message.AuthorityBackend == nil || message.Authority == nil || message.RoutingEpoch == nil || message.AuthorityBuildHash == nil ||
		*message.AuthorityBackend != backend || *message.Authority != authority || *message.RoutingEpoch != epoch ||
		*message.AuthorityBuildHash != hex.EncodeToString(build) || *message.RunRevision != revision || *message.ResumeGeneration != generation {
		return runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 event authority binding drifted", nil)
	}
	return nil
}

func translateV2Event(message authoritycontract.Message) runnerprotocol.Envelope {
	kind := runnerprotocol.Kind(message.Kind)
	return runnerprotocol.Envelope{ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: kind, WorkspaceID: message.WorkspaceID,
		JobID: message.JobID, WorkflowRunID: message.WorkflowRunID, AttemptID: message.AttemptID, LeaseID: message.LeaseID,
		FencingToken: message.FencingToken, Sequence: message.Sequence, EventID: message.EventID,
		CorrelationID: message.CorrelationID, SentAt: message.SentAt, Payload: message.Payload}
}

func applyV2Event(ctx context.Context, tx pgx.Tx, current activeAttempt, translated runnerprotocol.Envelope, kind authoritycontract.Kind, now time.Time) (eventTransition, error) {
	switch kind {
	case authoritycontract.KindCheckpointCommit, authoritycontract.KindBudgetReserveRequest, authoritycontract.KindBudgetUsageReport:
		if current.attemptState != runnerstore.AttemptRunning {
			return eventTransition{}, runnerstore.Failure(runnerstore.ErrorConflict, "v2 authority event requires a running attempt", nil)
		}
		return eventTransition{jobState: current.jobState, attemptState: current.attemptState, leaseState: current.leaseState,
			executionStarted: current.executionStarted, openEffectCount: current.openEffectCount,
			terminalStatus: current.terminalStatus, terminalReason: current.terminalReason, resultHash: current.resultHash, reconciliationID: current.reconciliationID}, nil
	default:
		return applyEvent(ctx, tx, current, translated, now)
	}
}

func v2EventReceipt(message authoritycontract.Message, prepared authoritycontract.PreparedMessage, sequence, runRevision, resumeGeneration int64, controlBuild string, now time.Time) authoritycontract.Message {
	return authoritycontract.Message{Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion,
		Kind: authoritycontract.KindEventReceipt, WorkspaceID: message.WorkspaceID, JobID: message.JobID,
		WorkflowRunID: message.WorkflowRunID, AttemptID: message.AttemptID, LeaseID: message.LeaseID,
		FencingToken: message.FencingToken, Sequence: &sequence, AuthorityBackend: message.AuthorityBackend,
		Authority: message.Authority, RoutingEpoch: message.RoutingEpoch, AuthorityBuildHash: message.AuthorityBuildHash,
		RunRevision: &runRevision, ResumeGeneration: &resumeGeneration,
		EventID: "receipt-" + message.EventID, CorrelationID: message.CorrelationID, SentAt: runnerstore.CanonicalTimestamp(now),
		Payload: map[string]any{"receivedEventId": message.EventID, "receivedKind": string(message.Kind),
			"receivedSequence": *message.Sequence, "receivedDigest": prepared.MessageDigest,
			"receivedIdempotencyKey": prepared.IdempotencyKey, "receivedFingerprint": prepared.RequestFingerprint,
			"status": string(authoritycontract.ReceiptAccepted), "controlBuildHash": controlBuild,
			"committedAt": runnerstore.CanonicalTimestamp(now), "errorCode": nil}}
}

func validateV2AuthorityResult(message authoritycontract.Message, decisionSequence int64, result runnerstore.V2AuthorityOutcome) (int64, int64, error) {
	if len(result.ExactReceiptBytes) == 0 {
		return 0, 0, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 authority receipt is missing", nil)
	}
	expectedOperation := map[authoritycontract.Kind]authoritycontract.ReceiptOperation{
		authoritycontract.KindCheckpointCommit:     authoritycontract.ReceiptCheckpointCommit,
		authoritycontract.KindEffectIntent:         authoritycontract.ReceiptEffectAuthorize,
		authoritycontract.KindBudgetReserveRequest: authoritycontract.ReceiptBudgetReserve,
		authoritycontract.KindBudgetUsageReport:    authoritycontract.ReceiptBudgetSettle,
		authoritycontract.KindLeaseAccept:          authoritycontract.ReceiptResumeAdvance,
	}[message.Kind]
	expectedRevision, expectedGeneration := *message.RunRevision, *message.ResumeGeneration
	if message.Kind == authoritycontract.KindBudgetReserveRequest || message.Kind == authoritycontract.KindBudgetUsageReport || message.Kind == authoritycontract.KindLeaseAccept {
		expectedRevision++
	}
	if message.Kind == authoritycontract.KindLeaseAccept {
		expectedGeneration++
	}
	if result.Operation != expectedOperation || result.AcceptedRunRevision != expectedRevision || result.AcceptedResumeGeneration != expectedGeneration {
		return 0, 0, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 operation-specific authority outcome drifted", nil)
	}
	if result.Decision != nil {
		decision := result.Decision
		prepared, prepareErr := prepareV2Message(*decision)
		if prepareErr != nil || !bytes.Equal([]byte(prepared.Body), result.DecisionBytes) || decision.JobID == nil || decision.WorkflowRunID == nil ||
			decision.AttemptID == nil || decision.LeaseID == nil || decision.FencingToken == nil || decision.Sequence == nil ||
			decision.AuthorityBackend == nil || decision.Authority == nil || decision.RoutingEpoch == nil || decision.AuthorityBuildHash == nil ||
			decision.RunRevision == nil || decision.ResumeGeneration == nil || *decision.JobID != *message.JobID ||
			*decision.WorkflowRunID != *message.WorkflowRunID || *decision.AttemptID != *message.AttemptID || *decision.LeaseID != *message.LeaseID ||
			*decision.FencingToken != *message.FencingToken || *decision.Sequence != decisionSequence ||
			*decision.AuthorityBackend != *message.AuthorityBackend || *decision.Authority != *message.Authority ||
			*decision.RoutingEpoch != *message.RoutingEpoch || *decision.AuthorityBuildHash != *message.AuthorityBuildHash ||
			*decision.RunRevision != result.AcceptedRunRevision || *decision.ResumeGeneration != *message.ResumeGeneration ||
			decision.WorkspaceID != message.WorkspaceID || decision.CorrelationID != message.CorrelationID {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 authority decision binding is invalid", prepareErr)
		}
		receiptHash := sha256.Sum256(result.ExactReceiptBytes)
		if decision.Payload["authorityReceiptHash"] != hex.EncodeToString(receiptHash[:]) {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 decision does not bind the exact authority receipt", nil)
		}
		expectedKind := map[authoritycontract.Kind]authoritycontract.Kind{
			authoritycontract.KindBudgetReserveRequest: authoritycontract.KindBudgetAuthorization,
			authoritycontract.KindEffectIntent:         authoritycontract.KindEffectAuthorization,
			authoritycontract.KindLeaseAccept:          authoritycontract.KindResumeOffer,
		}[message.Kind]
		if decision.Kind != expectedKind {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 authority decision kind does not match the triggering event", nil)
		}
		if message.Kind == authoritycontract.KindBudgetReserveRequest && decision.Payload["reservationId"] != message.Payload["reservationId"] {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 budget decision reservation differs", nil)
		}
		if message.Kind == authoritycontract.KindEffectIntent && (decision.Payload["effectId"] != message.Payload["effectId"] || decision.Payload["effectHash"] != message.Payload["effectHash"]) {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 effect decision identity differs", nil)
		}
		if message.Kind == authoritycontract.KindLeaseAccept {
			generation, ok := decision.Payload["newResumeGeneration"].(int64)
			if !ok || generation != *message.ResumeGeneration+1 {
				return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 resume decision generation differs", nil)
			}
			if generation != result.AcceptedResumeGeneration {
				return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 resume decision does not match its operation-specific receipt", nil)
			}
		}
	} else if message.Kind == authoritycontract.KindBudgetReserveRequest || message.Kind == authoritycontract.KindEffectIntent || (message.Kind == authoritycontract.KindLeaseAccept && *message.ResumeGeneration > 0) {
		return 0, 0, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 advancing authority event is missing its control decision", nil)
	}
	return result.AcceptedRunRevision, result.AcceptedResumeGeneration, nil
}

func nullableDecisionID(value *authoritycontract.Message) any {
	if value == nil {
		return nil
	}
	return value.EventID
}
func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}
