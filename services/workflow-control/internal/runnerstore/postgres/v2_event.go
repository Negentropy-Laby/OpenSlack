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
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
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
	var replayBinding *runnerstore.V2AuthorityBindingView
	if repository.v2RuntimeDelivery && runtimeBindingKind(message.Kind) {
		binding, bindingErr := repository.ReadAuthorityBindingForEvent(ctx, message.EventID, input.ExactBytes)
		if bindingErr == nil {
			replayBinding = &binding
		} else if !runnerstore.IsCode(bindingErr, runnerstore.ErrorNotFound) {
			return runnerstore.V2RecordedEvent{}, bindingErr
		}
		if replay, found, replayErr := readV2EventReplayRow(
			repository.pool.QueryRow(ctx, v2EventReplaySQL, prepared.IdempotencyKey),
			prepared,
			input.ExactBytes,
			replayBinding,
		); replayErr != nil {
			return runnerstore.V2RecordedEvent{}, replayErr
		} else if found {
			if replayBinding != nil {
				replay.AuthorityBindingID = &replayBinding.BindingID
			}
			return replay, nil
		}
	}
	if repository.v2RuntimeDelivery && runtimeBindingKind(message.Kind) {
		if replayBinding == nil {
			// Only an independently sealed initial admission may omit a resume
			// authority binding. In particular, revision/generation and binding
			// absence are never used to classify a first resume as initial.
			if message.Kind == authoritycontract.KindLeaseAccept &&
				repository.isInitialV2LeaseAccept(ctx, message) {
				return repository.finalizeV2Event(ctx, input, prepared, nil)
			}
			return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorNotFound, "authority binding for event was not found", nil)
		}
		binding := *replayBinding
		if message.Kind == authoritycontract.KindLeaseAccept &&
			(binding.Operation != runnerbindingcontract.OperationResumeAdvance || !repository.isResumeV2LeaseAccept(ctx, message)) {
			return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "lease accept binding lacks a sealed resume admission", nil)
		}
		if binding.State != "resolved" && binding.State != "runner_committed" && binding.State != "completed" {
			return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "exact authority binding is not resolved for runner consumption", nil)
		}
		if binding.State == "resolved" {
			reason, driftErr := repository.runtimeBindingConsumptionDrift(ctx, binding, message.Kind)
			if driftErr != nil || reason != "" {
				if reason == "" {
					reason = "process_crash"
				}
				latchErr := repository.latchRuntimeBindingReconciliation(ctx, binding, reason)
				return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "authority binding cannot be consumed after runner lifecycle drift", errors.Join(driftErr, latchErr))
			}
		}
		if binding.State == "resolved" && (binding.Operation == runnerbindingcontract.OperationBudgetReserve || binding.Operation == runnerbindingcontract.OperationBudgetSettle) {
			exactSource, sourceHash, sourceErr := repository.readRuntimeBudgetSource(ctx, binding)
			if sourceErr != nil {
				latchErr := repository.latchRuntimeBindingReconciliation(ctx, binding, "source_outcome_unknown")
				return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "exact post-resolution budget outcome cannot be proven", errors.Join(sourceErr, latchErr))
			}
			binding.ExactSourceResult = exactSource
			binding.SourceResultHash = sourceHash
		}
		outcome := runnerstore.V2AuthorityOutcome{
			Operation: authoritycontract.ReceiptOperation(binding.Operation), ExactReceiptBytes: binding.ExactResolutionReceipt,
			AcceptedRunRevision: binding.AcceptedRunRevision, AcceptedResumeGeneration: binding.AcceptedGeneration,
			RuntimeBinding: &binding,
		}
		recorded, finalizeErr := repository.finalizeV2Event(ctx, input, prepared, &outcome)
		if finalizeErr == nil {
			recorded.AuthorityBindingID = &binding.BindingID
		}
		return recorded, finalizeErr
	}
	if repository.v2RuntimeDelivery {
		return repository.finalizeV2Event(ctx, input, prepared, nil)
	}
	advance := v2Advance(message.Kind, *message.ResumeGeneration)
	if !advance.needsAuthority {
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

func (repository *Repository) runtimeBindingConsumptionDrift(ctx context.Context, binding runnerstore.V2AuthorityBindingView, kind authoritycontract.Kind) (string, error) {
	var jobState, attemptState, leaseState, currentAttempt string
	var currentFence, revision, generation int64
	var pendingCancel bool
	err := repository.pool.QueryRow(ctx, `SELECT j.state,a.state,l.state,j.current_attempt_id,a.fencing_token,
b.current_run_revision,b.current_resume_generation,EXISTS (
 SELECT 1 FROM workflow_runner_cancel_controls c WHERE c.attempt_id=a.attempt_id AND c.state IN ('pending','sent')
)
FROM workflow_runner_jobs j
JOIN workflow_runner_attempts a ON a.attempt_id=$1
JOIN workflow_runner_leases l ON l.lease_id=$2 AND l.attempt_id=a.attempt_id
JOIN workflow_runner_v2_attempt_bindings b ON b.attempt_id=a.attempt_id
WHERE j.workspace_id=$3 AND j.job_id=$4`, binding.AttemptID, binding.LeaseID, binding.WorkspaceID, binding.JobID).Scan(
		&jobState, &attemptState, &leaseState, &currentAttempt, &currentFence, &revision, &generation, &pendingCancel,
	)
	if err != nil {
		return "process_crash", databaseFailure("read runtime binding consumption head", err)
	}
	if pendingCancel || jobState == string(runnerstore.JobCancelling) || attemptState == string(runnerstore.AttemptCancelling) || leaseState == "cancelling" {
		return "cancelled_with_outstanding_authority", nil
	}
	if jobState == string(runnerstore.JobTerminal) || jobState == string(runnerstore.JobReconciliationRequired) ||
		attemptState == string(runnerstore.AttemptTerminal) || attemptState == string(runnerstore.AttemptReconciliationRequired) {
		return "terminal_with_outstanding_authority", nil
	}
	expectedJob, expectedAttempt, expectedLease := string(runnerstore.JobRunning), string(runnerstore.AttemptRunning), "active"
	if kind == authoritycontract.KindLeaseAccept {
		expectedJob, expectedAttempt, expectedLease = string(runnerstore.JobOffered), string(runnerstore.AttemptOffered), "offered"
	}
	if currentAttempt != binding.AttemptID || currentFence != binding.FencingToken || revision != binding.ExpectedRunRevision || generation != binding.ExpectedGeneration ||
		jobState != expectedJob || attemptState != expectedAttempt || leaseState != expectedLease {
		return "process_crash", nil
	}
	return "", nil
}

func (repository *Repository) readRuntimeBudgetSource(ctx context.Context, binding runnerstore.V2AuthorityBindingView) ([]byte, []byte, error) {
	if repository.v2BudgetResults == nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "budget result point-read is unavailable", nil)
	}
	resolution, err := runnerbindingcontract.ParseResolutionBytes(binding.ExactResolutionBytes)
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored budget binding resolution is invalid", err)
	}
	evidence := runtimeBindingRecord(resolution["evidence"])
	preparedValue := evidence["preparedRequest"]
	prepared, _, err := budgetcontract.ValidatePreparedRequestRecord(preparedValue)
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "budget binding prepared request is invalid", err)
	}
	result, err := repository.v2BudgetResults.ReadMutationResult(ctx, binding.WorkspaceID, prepared.IdempotencyKey)
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "read exact immutable budget result", err)
	}
	if result.Operation != prepared.Operation || result.Record == nil || result.LedgerEntry == nil || result.Reconciliation != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "budget point-read did not prove a closed accepted result", nil)
	}
	var exact []byte
	switch binding.Operation {
	case runnerbindingcontract.OperationBudgetReserve:
		if prepared.Operation != "reserve" {
			return nil, nil, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "budget reserve binding points at another operation", nil)
		}
		value := runnerbindingcontract.Record{
			"schema": runnerbindingcontract.BudgetSourceResultSchema, "durableReceiptBytes": string(result.ExactReceiptBytes),
			"decision": result.Record, "ledgerEntry": result.LedgerEntry,
		}
		exact, err = canonicaljson.Encode(value)
		if err == nil {
			exact = append(exact, '\n')
			_, err = runnerbindingcontract.ParseBudgetSourceResultBytes(exact, preparedValue)
		}
	case runnerbindingcontract.OperationBudgetSettle:
		if prepared.Operation != "settle" || result.Status != "settled" {
			return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "budget settlement did not produce a terminal accepted result", nil)
		}
		exact = append([]byte(nil), result.ExactReceiptBytes...)
		_, err = runnerbindingcontract.ParseBudgetSettlementSourceReceiptBytes(exact, preparedValue)
	default:
		return nil, nil, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "runtime budget point-read was requested for a non-budget binding", nil)
	}
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "exact immutable budget result is cross-spliced", err)
	}
	digest := sha256.Sum256(exact)
	return exact, digest[:], nil
}

func (repository *Repository) latchRuntimeBindingReconciliation(ctx context.Context, binding runnerstore.V2AuthorityBindingView, reason string) error {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return databaseFailure("begin budget source reconciliation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, bindingLockDomain+binding.BindingID, binding.WorkspaceID, binding.JobID); err != nil {
		return err
	}
	var state string
	if err := tx.QueryRow(ctx, `SELECT state FROM workflow_runner_authority_bindings WHERE binding_id=$1 FOR UPDATE`, binding.BindingID).Scan(&state); err != nil {
		return databaseFailure("lock budget source reconciliation binding", err)
	}
	if state == "reconciliation_required" {
		return tx.Commit(ctx)
	}
	if state != "resolved" {
		return runnerstore.Failure(runnerstore.ErrorSequenceConflict, "authority-binding reconciliation lost its resolved predecessor", nil)
	}
	reconciliationID, err := randomToken("wfrunner-reconciliation")
	if err != nil {
		return databaseFailure("generate budget source reconciliation identity", err)
	}
	evidenceHash := sha256.Sum256(append(append(append([]byte(binding.BindingID), 0), []byte(reason)...), binding.ExactResolutionReceipt...))
	if _, err := tx.Exec(ctx, `INSERT INTO workflow_runner_authority_reconciliations
(reconciliation_id,binding_id,workspace_id,job_id,attempt_id,reason,evidence_hash,created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`, reconciliationID, binding.BindingID,
		binding.WorkspaceID, binding.JobID, binding.AttemptID, reason, evidenceHash[:]); err != nil {
		return mapWriteFailure("insert authority-binding reconciliation", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE workflow_runner_authority_bindings
SET state='reconciliation_required',reconciliation_id=$2,reconciliation_reason=$3,updated_at=clock_timestamp()
WHERE binding_id=$1 AND state='resolved'`, binding.BindingID, reconciliationID, reason); err != nil {
		return mapWriteFailure("latch authority-binding reconciliation", err)
	}
	return tx.Commit(ctx)
}

func runtimeBindingKind(kind authoritycontract.Kind) bool {
	_, ok := runnerbindingcontract.OperationForKind(kind)
	return ok
}

func (repository *Repository) isInitialV2LeaseAccept(ctx context.Context, message authoritycontract.Message) bool {
	return repository.hasV2LeaseAdmission(ctx, message, "initial")
}

func (repository *Repository) isResumeV2LeaseAccept(ctx context.Context, message authoritycontract.Message) bool {
	return repository.hasV2LeaseAdmission(ctx, message, "resume")
}

func (repository *Repository) hasV2LeaseAdmission(ctx context.Context, message authoritycontract.Message, expected string) bool {
	if message.AttemptID == nil || message.JobID == nil || message.WorkflowRunID == nil || message.LeaseID == nil ||
		message.FencingToken == nil || message.Sequence == nil || *message.Sequence != 1 {
		return false
	}
	var key, workspaceID string
	var fingerprint, exactRequest []byte
	var workerSequence int64
	err := repository.pool.QueryRow(ctx, `SELECT admission.idempotency_key,admission.workspace_id,
admission.request_fingerprint,admission.exact_request_bytes,a.worker_sequence
FROM workflow_runner_attempts a
JOIN workflow_runner_jobs j ON j.current_attempt_id=a.attempt_id
JOIN workflow_runner_v2_attempt_bindings b ON b.attempt_id=a.attempt_id
JOIN workflow_runner_v2_runtime_admissions admission
  ON admission.attempt_id=b.attempt_id
 AND admission.workspace_id=b.workspace_id AND admission.job_id=b.job_id
 AND admission.admission_disposition=b.admission_disposition
 AND admission.job_spec_hash=b.admission_job_spec_hash
WHERE a.attempt_id=$1 AND a.workspace_id=$2 AND a.job_id=$3 AND a.state='offered'
  AND j.workflow_run_id=$4
  AND admission.lease_id=$5
  AND admission.fencing_token=$6
  AND admission.lease_id=(SELECT lease_id FROM workflow_runner_leases
      WHERE attempt_id=a.attempt_id AND fencing_token=a.fencing_token)`,
		*message.AttemptID, message.WorkspaceID, *message.JobID, *message.WorkflowRunID,
		*message.LeaseID, *message.FencingToken).Scan(&key, &workspaceID, &fingerprint, &exactRequest, &workerSequence)
	if err != nil || workerSequence != 0 {
		return false
	}
	receipt, found, err := readV2RuntimeAdmissionReceipt(
		repository.pool.QueryRow(ctx, v2RuntimeAdmissionByKeySQL, key), workspaceID, fingerprint, exactRequest,
	)
	return err == nil && found && receipt.Disposition == expected
}

type stagedV2Event struct {
	recorded           *runnerstore.V2RecordedEvent
	authorityCommitted bool
}

type v2AdvanceRule struct {
	needsAuthority bool
	runDelta       int64
	resumeDelta    int64
	operation      authoritycontract.ReceiptOperation
	decisionKind   authoritycontract.Kind
}

func v2Advance(kind authoritycontract.Kind, resumeGeneration int64) v2AdvanceRule {
	switch kind {
	case authoritycontract.KindCheckpointCommit:
		return v2AdvanceRule{needsAuthority: true, operation: authoritycontract.ReceiptCheckpointCommit}
	case authoritycontract.KindEffectIntent:
		return v2AdvanceRule{needsAuthority: true, operation: authoritycontract.ReceiptEffectAuthorize, decisionKind: authoritycontract.KindEffectAuthorization}
	case authoritycontract.KindBudgetReserveRequest:
		return v2AdvanceRule{needsAuthority: true, runDelta: 1, operation: authoritycontract.ReceiptBudgetReserve, decisionKind: authoritycontract.KindBudgetAuthorization}
	case authoritycontract.KindBudgetUsageReport:
		return v2AdvanceRule{needsAuthority: true, runDelta: 1, operation: authoritycontract.ReceiptBudgetSettle}
	case authoritycontract.KindLeaseAccept:
		if resumeGeneration > 0 {
			return v2AdvanceRule{needsAuthority: true, runDelta: 1, resumeDelta: 1, operation: authoritycontract.ReceiptResumeAdvance, decisionKind: authoritycontract.KindResumeOffer}
		}
	}
	return v2AdvanceRule{}
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

func readV2EventReplayRow(row pgx.Row, prepared authoritycontract.PreparedMessage, exactEventBytes []byte, runtimeBinding *runnerstore.V2AuthorityBindingView) (runnerstore.V2RecordedEvent, bool, error) {
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
	runtimeAuthorityReceipt := false
	var runtimeReceiptValue runnerbindingcontract.Record
	var runtimeAuthorityErr error
	if len(authorityReceiptBytes) != 0 {
		runtimeReceiptValue, runtimeAuthorityErr = runnerbindingcontract.ParseReceiptBytes(authorityReceiptBytes)
		runtimeAuthorityReceipt = runtimeAuthorityErr == nil
	}
	if err != nil || !bytes.Equal([]byte(receiptPrepared.Body), receiptBytes) || !bytes.Equal(receiptControlBytes, receiptBytes) ||
		subtle.ConstantTimeCompare(receiptDigest, storedReceiptDigest) != 1 || subtle.ConstantTimeCompare(receiptControlDigest, storedReceiptDigest) != 1 ||
		receiptStatus != string(runnerstore.ReceiptAccepted) || receiptReconciliationID != nil ||
		receiptControlID != receipt.EventID || receiptControlAttempt != attemptID || receiptControlKind != string(authoritycontract.KindEventReceipt) ||
		receipt.Sequence == nil || receiptControlSequence != *receipt.Sequence || validateStoredV2EventReceipt(event, prepared, receipt, hex.EncodeToString(durableControlBuildHash), authorityOperation, runtimeAuthorityReceipt) != nil {
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
		advance := v2Advance(event.Kind, *event.ResumeGeneration)
		expectedRevision := *event.RunRevision + advance.runDelta
		expectedGeneration := *event.ResumeGeneration + advance.resumeDelta
		runtimeReceipt := false
		if _, parseErr := runnerbindingcontract.ParseReceiptBytes(authorityReceiptBytes); parseErr == nil {
			operation := runnerbindingcontract.Operation(*authorityOperation)
			delta, deltaErr := runnerbindingcontract.RunnerHeadDelta(operation)
			expectedKind, kindErr := runnerbindingcontract.ExpectedKind(operation)
			if deltaErr != nil || kindErr != nil || expectedKind != event.Kind ||
				bindingString(runtimeReceiptValue, "operation") != *authorityOperation {
				return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored runtime authority operation is invalid", deltaErr)
			}
			expectedRevision = *event.RunRevision + delta.Revision
			expectedGeneration = *event.ResumeGeneration + delta.Generation
			runtimeReceipt = true
			if runtimeBinding == nil || runtimeBinding.Operation != operation ||
				runtimeBinding.State != "runner_committed" && runtimeBinding.State != "completed" ||
				runtimeBinding.TargetEventID != event.EventID || runtimeBinding.TargetKind != string(event.Kind) ||
				runtimeBinding.TargetSequence != *event.Sequence || !bytes.Equal(runtimeBinding.ExactTargetBytes, exactEventBytes) ||
				runtimeBinding.AttemptID != *event.AttemptID || runtimeBinding.LeaseID != *event.LeaseID ||
				runtimeBinding.FencingToken != *event.FencingToken || runtimeBinding.ExpectedRunRevision != *event.RunRevision ||
				runtimeBinding.ExpectedGeneration != *event.ResumeGeneration || runtimeBinding.AcceptedRunRevision != expectedRevision ||
				runtimeBinding.AcceptedGeneration != expectedGeneration ||
				!bytes.Equal(runtimeBinding.ExactResolutionReceipt, authorityReceiptBytes) {
				return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored runtime authority binding replay is cross-spliced", nil)
			}
		}
		outcome := runnerstore.V2AuthorityOutcome{Operation: authoritycontract.ReceiptOperation(*authorityOperation), ExactReceiptBytes: authorityReceiptBytes,
			AcceptedRunRevision: expectedRevision, AcceptedResumeGeneration: expectedGeneration, Decision: result.Decision, DecisionBytes: result.DecisionBytes,
			RuntimeBinding: runtimeBinding}
		if runtimeReceipt {
			decisionExpected := *authorityOperation == string(runnerbindingcontract.OperationEffectAuthorize) ||
				*authorityOperation == string(runnerbindingcontract.OperationBudgetReserve) || *authorityOperation == string(runnerbindingcontract.OperationResumeAdvance)
			if decisionExpected != (result.Decision != nil) {
				return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored runtime authority decision presence drifted", nil)
			}
		}
		if _, _, validateErr := validateV2AuthorityResult(event, receiptControlSequence+1, outcome); validateErr != nil {
			return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 authority replay binding is invalid", validateErr)
		}
	} else if result.Decision != nil {
		return runnerstore.V2RecordedEvent{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 decision has no authority receipt binding", nil)
	}
	return result, true, nil
}

func validateStoredV2EventReceipt(event authoritycontract.Message, prepared authoritycontract.PreparedMessage, receipt authoritycontract.Message, controlBuildHash string, authorityOperation *string, runtimeAuthority bool) error {
	if receipt.JobID == nil || receipt.WorkflowRunID == nil || receipt.AttemptID == nil || receipt.LeaseID == nil || receipt.FencingToken == nil ||
		receipt.AuthorityBackend == nil || receipt.Authority == nil || receipt.RoutingEpoch == nil || receipt.AuthorityBuildHash == nil ||
		receipt.RunRevision == nil || receipt.ResumeGeneration == nil || receipt.Sequence == nil ||
		receipt.WorkspaceID != event.WorkspaceID || *receipt.JobID != *event.JobID || *receipt.WorkflowRunID != *event.WorkflowRunID ||
		*receipt.AttemptID != *event.AttemptID || *receipt.LeaseID != *event.LeaseID || *receipt.FencingToken != *event.FencingToken ||
		*receipt.AuthorityBackend != *event.AuthorityBackend || *receipt.Authority != *event.Authority || *receipt.RoutingEpoch != *event.RoutingEpoch ||
		*receipt.AuthorityBuildHash != *event.AuthorityBuildHash ||
		receipt.EventID != "receipt-"+event.EventID || receipt.CorrelationID != event.CorrelationID ||
		receipt.Payload["receivedEventId"] != event.EventID || receipt.Payload["receivedKind"] != string(event.Kind) ||
		receipt.Payload["receivedSequence"] != *event.Sequence || receipt.Payload["receivedDigest"] != prepared.MessageDigest ||
		receipt.Payload["receivedIdempotencyKey"] != prepared.IdempotencyKey || receipt.Payload["receivedFingerprint"] != prepared.RequestFingerprint ||
		receipt.Payload["controlBuildHash"] != controlBuildHash ||
		receipt.Payload["status"] != string(authoritycontract.ReceiptAccepted) || receipt.Payload["committedAt"] != receipt.SentAt || receipt.Payload["errorCode"] != nil {
		return runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "stored v2 event receipt is cross-spliced", nil)
	}
	advance := v2Advance(event.Kind, *event.ResumeGeneration)
	expectedRevision := *event.RunRevision + advance.runDelta
	expectedGeneration := *event.ResumeGeneration + advance.resumeDelta
	if runtimeAuthority && authorityOperation != nil {
		if delta, err := runnerbindingcontract.RunnerHeadDelta(runnerbindingcontract.Operation(*authorityOperation)); err == nil {
			expectedRevision = *event.RunRevision + delta.Revision
			expectedGeneration = *event.ResumeGeneration + delta.Generation
		}
	}
	if *receipt.RunRevision != expectedRevision || *receipt.ResumeGeneration != expectedGeneration {
		return runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "stored v2 event receipt revision or generation drifted", nil)
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
	if recorded, found, replayErr := readV2EventReplayRow(tx.QueryRow(ctx, v2EventReplaySQL, prepared.IdempotencyKey), prepared, input.ExactBytes, nil); replayErr != nil {
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
	var replayBinding *runnerstore.V2AuthorityBindingView
	if authority != nil {
		replayBinding = authority.RuntimeBinding
	}
	if result, found, readErr := readV2EventReplayRow(tx.QueryRow(ctx, v2EventReplaySQL, prepared.IdempotencyKey), prepared, input.ExactBytes, replayBinding); readErr != nil {
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
	if authority != nil && authority.RuntimeBinding != nil {
		if err := validateRuntimeBindingFinalizeClock(now, *authority.RuntimeBinding); err != nil {
			return runnerstore.V2RecordedEvent{}, err
		}
	}
	translated := translateV2Event(message)
	next, err := applyV2Event(ctx, tx, current, translated, message.Kind, now)
	if err != nil {
		return runnerstore.V2RecordedEvent{}, err
	}
	nextControl := current.controlSequence + 1
	receiptRunRevision, nextResumeGeneration := *message.RunRevision, *message.ResumeGeneration
	if authority != nil {
		if authority.RuntimeBinding != nil {
			decision, decisionBytes, buildErr := buildRuntimeBindingDecision(message, current.controlSequence+2, now, *authority.RuntimeBinding)
			if buildErr != nil {
				return runnerstore.V2RecordedEvent{}, buildErr
			}
			authority.Decision, authority.DecisionBytes = decision, decisionBytes
		}
		var validateErr error
		receiptRunRevision, nextResumeGeneration, validateErr = validateV2AuthorityResult(message, current.controlSequence+2, *authority)
		if validateErr != nil {
			return runnerstore.V2RecordedEvent{}, validateErr
		}
	}
	receipt := v2EventReceipt(message, prepared, nextControl, receiptRunRevision, nextResumeGeneration, input.ControlBuildHash, now)
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
	if authority != nil && authority.RuntimeBinding != nil {
		binding := authority.RuntimeBinding
		var bindingState string
		var boundTarget, boundResolutionReceipt, boundSourceResult, boundSourceHash []byte
		if err := tx.QueryRow(ctx, `SELECT state,exact_target_bytes,exact_resolution_receipt_bytes,exact_source_result_bytes,source_result_hash
FROM workflow_runner_authority_bindings WHERE binding_id=$1 AND target_event_id=$2 FOR UPDATE`,
			binding.BindingID, message.EventID).Scan(&bindingState, &boundTarget, &boundResolutionReceipt, &boundSourceResult, &boundSourceHash); err != nil {
			return runnerstore.V2RecordedEvent{}, databaseFailure("lock runtime authority binding for runner commit", err)
		}
		if bindingState != "resolved" || !bytes.Equal(boundTarget, input.ExactBytes) || !bytes.Equal(boundResolutionReceipt, authority.ExactReceiptBytes) ||
			len(boundSourceResult) != 0 || len(boundSourceHash) != 0 {
			return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "runtime authority binding changed before runner commit", nil)
		}
		if (binding.Operation == runnerbindingcontract.OperationBudgetReserve || binding.Operation == runnerbindingcontract.OperationBudgetSettle) &&
			(len(binding.ExactSourceResult) == 0 || len(binding.SourceResultHash) != sha256.Size) {
			return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "runtime budget binding lacks its exact point-read result", nil)
		}
		authorityHashValue := sha256.Sum256(authority.ExactReceiptBytes)
		if _, err := tx.Exec(ctx, `INSERT INTO workflow_runner_v2_event_inbox (
event_id,workspace_id,job_id,attempt_id,lease_id,fencing_token,worker_sequence,kind,run_revision,resume_generation,
idempotency_key,request_fingerprint,message_digest,exact_event_bytes,state,authority_operation,authority_receipt_hash,
exact_authority_receipt_bytes,created_at,updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'authority_committed',$15,$16,$17,$18,$18)`,
			message.EventID, message.WorkspaceID, *message.JobID, *message.AttemptID, *message.LeaseID, *message.FencingToken,
			*message.Sequence, string(message.Kind), *message.RunRevision, *message.ResumeGeneration, prepared.IdempotencyKey,
			fingerprint, eventDigest, input.ExactBytes, string(binding.Operation), authorityHashValue[:], authority.ExactReceiptBytes, now); err != nil {
			return runnerstore.V2RecordedEvent{}, mapWriteFailure("stage resolved runtime authority event", err)
		}
	}
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
		if authority.RuntimeBinding != nil {
			tag, err = tx.Exec(ctx, `UPDATE workflow_runner_authority_bindings
SET state='runner_committed',exact_source_result_bytes=$2,source_result_hash=$3,updated_at=$4
WHERE binding_id=$1 AND state='resolved'`, authority.RuntimeBinding.BindingID,
				nullableBytes(authority.RuntimeBinding.ExactSourceResult), nullableBytes(authority.RuntimeBinding.SourceResultHash), now)
			if err != nil {
				return runnerstore.V2RecordedEvent{}, mapWriteFailure("advance runtime authority binding to runner committed", err)
			}
			if tag.RowsAffected() != 1 {
				return runnerstore.V2RecordedEvent{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "runtime authority binding runner commit CAS lost", nil)
			}
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

func validateRuntimeBindingFinalizeClock(now time.Time, binding runnerstore.V2AuthorityBindingView) error {
	receipt, err := runnerbindingcontract.ParseReceiptBytes(binding.ExactResolutionReceipt)
	if err != nil {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "runtime binding resolution receipt is invalid", err)
	}
	committedAtText, committed := receipt["committedAt"].(string)
	if !committed {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "runtime binding resolution receipt has no commit clock", nil)
	}
	committedAt, err := runnerstore.ParseTimestamp(committedAtText)
	if err != nil {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "runtime binding resolution receipt commit clock is invalid", err)
	}
	if now.Before(committedAt) {
		return runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "authority-binding resolution receipt is ahead of the database finalization clock", nil)
	}
	return nil
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

func runtimeBindingRecord(value any) map[string]any {
	switch current := value.(type) {
	case runnerbindingcontract.Record:
		return map[string]any(current)
	case budgetcontract.Record:
		return map[string]any(current)
	case map[string]any:
		return current
	default:
		return nil
	}
}

func buildRuntimeBindingDecision(message authoritycontract.Message, sequence int64, now time.Time, binding runnerstore.V2AuthorityBindingView) (*authoritycontract.Message, []byte, error) {
	if binding.Operation != runnerbindingcontract.OperationEffectAuthorize && binding.Operation != runnerbindingcontract.OperationBudgetReserve &&
		binding.Operation != runnerbindingcontract.OperationResumeAdvance {
		return nil, nil, nil
	}
	stage, err := runnerbindingcontract.ParseStageBytes(binding.ExactStageBytes)
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "runtime binding stage is invalid", err)
	}
	stageReceipt, err := runnerbindingcontract.ParseReceiptBytes(binding.ExactStageReceipt)
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "runtime binding stage receipt is invalid", err)
	}
	resolution, err := runnerbindingcontract.ParseResolutionBytes(binding.ExactResolutionBytes)
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "runtime binding resolution is invalid", err)
	}
	resolutionReceipt, err := runnerbindingcontract.ParseReceiptBytes(binding.ExactResolutionReceipt)
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "runtime binding resolution receipt is invalid", err)
	}
	if _, err := runnerbindingcontract.ValidateResolutionReceipt(resolutionReceipt, resolution, stage, stageReceipt); err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "runtime binding resolution exchange is cross-spliced", err)
	}
	evidence := runtimeBindingRecord(resolution["evidence"])
	kind := authoritycontract.Kind("")
	payload := map[string]any{}
	runRevision, generation := binding.AcceptedRunRevision, binding.AcceptedGeneration
	decisionHash, err := runnerbindingcontract.HashReceipt(resolutionReceipt)
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "hash runtime binding resolution receipt", err)
	}
	switch binding.Operation {
	case runnerbindingcontract.OperationEffectAuthorize:
		kind = authoritycontract.KindEffectAuthorization
		payload = map[string]any{
			"effectId": evidence["effectId"], "effectHash": evidence["effectHash"], "approvalId": evidence["approvalId"],
			"approvalStatus": evidence["approvalStatus"], "decisionRevision": evidence["decisionRevision"],
			"grantHash": evidence["grantHash"], "authorityReceiptHash": decisionHash, "expiresAt": evidence["expiresAt"],
		}
	case runnerbindingcontract.OperationResumeAdvance:
		kind = authoritycontract.KindResumeOffer
		runRevision, generation = binding.ExpectedRunRevision, binding.ExpectedGeneration
		payload = map[string]any{
			"checkpointId": evidence["priorCheckpointId"], "checkpointHash": evidence["priorCheckpointHash"],
			"nextPhaseId": evidence["nextPhaseId"], "nextPhaseIndex": evidence["nextPhaseIndex"],
			"newResumeGeneration": binding.AcceptedGeneration, "newAttemptId": evidence["logicalResumeAttemptId"],
			"authorityReceiptHash": decisionHash, "expiresAt": evidence["expiresAt"],
		}
	case runnerbindingcontract.OperationBudgetReserve:
		if len(binding.ExactSourceResult) == 0 {
			return nil, nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "budget runtime binding has no exact durable Go source result", nil)
		}
		preparedRequest := evidence["preparedRequest"]
		source, sourceErr := runnerbindingcontract.ParseBudgetSourceResultBytes(binding.ExactSourceResult, preparedRequest)
		if sourceErr != nil {
			return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "budget runtime source result is invalid", sourceErr)
		}
		decision := runtimeBindingRecord(source["decision"])
		authorization := runtimeBindingRecord(decision["authorization"])
		durable, durableErr := runnerbindingcontract.ParseBudgetDurableReceiptBytes(source["durableReceiptBytes"])
		if durableErr != nil {
			return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "parse durable budget receipt", durableErr)
		}
		projection := runtimeBindingRecord(durable["operationalProjection"])
		committedRunRevision, committedRevisionOK := projection["acceptedRunRevision"].(int64)
		if !committedRevisionOK || committedRunRevision < 1 {
			return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "durable budget receipt has no accepted source revision", nil)
		}
		durableHash, hashErr := runnerbindingcontract.HashBudgetSourceReceipt(source["durableReceiptBytes"])
		if hashErr != nil {
			return nil, nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "hash durable budget receipt", hashErr)
		}
		kind = authoritycontract.KindBudgetAuthorization
		payload = map[string]any{
			"reservationId": message.Payload["reservationId"], "status": decision["status"],
			"authorizedTokens": authorization["tokens"], "authorizedCostNanoUsd": authorization["nanoUsd"],
			"authorizedCalls": authorization["calls"], "authorityReceiptHash": durableHash,
			"committedRunRevision": committedRunRevision,
		}
	}
	decision := authoritycontract.Message{
		Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion, Kind: kind,
		WorkspaceID: message.WorkspaceID, JobID: message.JobID, WorkflowRunID: message.WorkflowRunID,
		AttemptID: message.AttemptID, LeaseID: message.LeaseID, FencingToken: message.FencingToken, Sequence: &sequence,
		AuthorityBackend: message.AuthorityBackend, Authority: message.Authority, RoutingEpoch: message.RoutingEpoch,
		AuthorityBuildHash: message.AuthorityBuildHash, RunRevision: &runRevision, ResumeGeneration: &generation,
		EventID: "binding-" + string(kind) + "-" + binding.BindingID, CorrelationID: message.CorrelationID,
		SentAt: runnerstore.CanonicalTimestamp(now), Payload: payload,
	}
	prepared, err := prepareV2Message(decision)
	if err != nil {
		return nil, nil, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "build runtime binding decision", err)
	}
	return &decision, []byte(prepared.Body), nil
}

func validateV2AuthorityResult(message authoritycontract.Message, decisionSequence int64, result runnerstore.V2AuthorityOutcome) (int64, int64, error) {
	if result.RuntimeBinding != nil {
		binding := result.RuntimeBinding
		expectedKind, kindErr := runnerbindingcontract.ExpectedKind(binding.Operation)
		delta, deltaErr := runnerbindingcontract.RunnerHeadDelta(binding.Operation)
		if kindErr != nil || deltaErr != nil || expectedKind != message.Kind || binding.TargetEventID != message.EventID ||
			binding.AttemptID != *message.AttemptID || binding.LeaseID != *message.LeaseID || binding.FencingToken != *message.FencingToken ||
			binding.ExpectedRunRevision != *message.RunRevision || binding.ExpectedGeneration != *message.ResumeGeneration ||
			binding.AcceptedRunRevision != *message.RunRevision+delta.Revision ||
			binding.AcceptedGeneration != *message.ResumeGeneration+delta.Generation ||
			result.Operation != authoritycontract.ReceiptOperation(binding.Operation) ||
			result.AcceptedRunRevision != binding.AcceptedRunRevision || result.AcceptedResumeGeneration != binding.AcceptedGeneration ||
			!bytes.Equal(result.ExactReceiptBytes, binding.ExactResolutionReceipt) {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "runtime authority binding matrix or exact event identity drifted", errors.Join(kindErr, deltaErr))
		}
		decisionExpected := binding.Operation == runnerbindingcontract.OperationEffectAuthorize ||
			binding.Operation == runnerbindingcontract.OperationBudgetReserve || binding.Operation == runnerbindingcontract.OperationResumeAdvance
		if decisionExpected != (result.Decision != nil) {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorReconciliation, "runtime authority binding decision presence drifted", nil)
		}
		if result.Decision != nil {
			prepared, err := prepareV2Message(*result.Decision)
			if err != nil || !bytes.Equal([]byte(prepared.Body), result.DecisionBytes) || result.Decision.Sequence == nil ||
				*result.Decision.Sequence != decisionSequence || result.Decision.AttemptID == nil || *result.Decision.AttemptID != binding.AttemptID {
				return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "runtime authority binding decision bytes drifted", err)
			}
		}
		return binding.AcceptedRunRevision, binding.AcceptedGeneration, nil
	}
	if len(result.ExactReceiptBytes) == 0 {
		return 0, 0, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 authority receipt is missing", nil)
	}
	advance := v2Advance(message.Kind, *message.ResumeGeneration)
	expectedRevision := *message.RunRevision + advance.runDelta
	expectedGeneration := *message.ResumeGeneration + advance.resumeDelta
	if !advance.needsAuthority || result.Operation != advance.operation || result.AcceptedRunRevision != expectedRevision || result.AcceptedResumeGeneration != expectedGeneration {
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
		var (
			exactReceiptHash string
			budgetProof      *runnerbindingcontract.BudgetDurableReceiptProof
		)
		if message.Kind == authoritycontract.KindBudgetReserveRequest {
			proof, proofErr := runnerbindingcontract.ProveBudgetDurableReceiptBytes(string(result.ExactReceiptBytes))
			if proofErr != nil {
				return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 budget decision durable receipt is invalid", proofErr)
			}
			budgetProof = &proof
			exactReceiptHash = proof.ReceiptHash
		} else {
			receiptHash := sha256.Sum256(result.ExactReceiptBytes)
			exactReceiptHash = hex.EncodeToString(receiptHash[:])
		}
		if decision.Payload["authorityReceiptHash"] != exactReceiptHash {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 decision does not bind the exact authority receipt", nil)
		}
		if advance.decisionKind == "" || decision.Kind != advance.decisionKind {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 authority decision kind does not match the triggering event", nil)
		}
		if message.Kind == authoritycontract.KindBudgetReserveRequest {
			if budgetProof == nil || message.AuthorityBuildHash == nil || budgetProof.Operation != "reserve" || budgetProof.Status != "accepted" ||
				budgetProof.ReservationID != message.Payload["reservationId"] || decision.Payload["reservationId"] != message.Payload["reservationId"] ||
				budgetProof.AcceptedRunRevision != decision.Payload["committedRunRevision"] ||
				budgetProof.AuthorityBuildHash != *message.AuthorityBuildHash {
				return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 budget decision does not bind its exact durable receipt", nil)
			}
		}
		if message.Kind == authoritycontract.KindEffectIntent && (decision.Payload["effectId"] != message.Payload["effectId"] || decision.Payload["effectHash"] != message.Payload["effectHash"]) {
			return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 effect decision identity differs", nil)
		}
		if message.Kind == authoritycontract.KindLeaseAccept {
			generation, ok := decision.Payload["newResumeGeneration"].(int64)
			newAttemptID, validAttemptID := decision.Payload["newAttemptId"].(string)
			if !ok || generation != *message.ResumeGeneration+1 || !validAttemptID || newAttemptID == *message.AttemptID {
				return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 resume decision identity or generation differs", nil)
			}
			if generation != result.AcceptedResumeGeneration {
				return 0, 0, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 resume decision does not match its operation-specific receipt", nil)
			}
		}
	} else if advance.decisionKind != "" {
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
