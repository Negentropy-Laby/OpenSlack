package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

const bindingLockDomain = "openslack.workflow-runner-authority-binding.v1\x00"

type storedBindingReceipt struct {
	workspaceID string
	fingerprint []byte
	request     []byte
	receipt     []byte
}

func validateBindingPrepared(
	input runnerstore.V2AuthorityBindingInput,
	parse func([]byte) (runnerbindingcontract.Record, error),
	prepare func(any) (runnerbindingcontract.Prepared, error),
) (runnerbindingcontract.Record, error) {
	body := []byte(input.Prepared.Body)
	value, err := parse(body)
	if err != nil {
		return nil, bindingContractFailure("authority-binding frame is invalid", err)
	}
	trusted, err := prepare(value)
	if err != nil || trusted.Schema != input.Prepared.Schema || trusted.Body != input.Prepared.Body ||
		trusted.BodyHash != input.Prepared.BodyHash || trusted.IdempotencyKey != input.Prepared.IdempotencyKey ||
		trusted.RequestFingerprint != input.Prepared.RequestFingerprint ||
		input.IdempotencyKey != trusted.IdempotencyKey || input.RequestFingerprint != trusted.RequestFingerprint {
		return nil, runnerstore.Failure(runnerstore.ErrorHashMismatch, "authority-binding prepared body and headers differ", err)
	}
	return value, nil
}

func bindingContractFailure(message string, err error) error {
	var contractErr *runnerbindingcontract.ContractError
	if errors.As(err, &contractErr) {
		code := runnerstore.ErrorAuthorityBinding
		if contractErr.Code == runnerbindingcontract.ErrorLimitExceeded {
			code = runnerstore.ErrorLimitExceeded
		}
		return runnerstore.Failure(code, message, err)
	}
	return runnerstore.Failure(runnerstore.ErrorAuthorityBinding, message, err)
}

func (repository *Repository) StageAuthorityBinding(ctx context.Context, input runnerstore.V2AuthorityBindingInput) (runnerstore.V2AuthorityBindingReceipt, error) {
	if !repository.v2RuntimeDelivery || repository.schemaVersion < 8 {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "schema-8 runtime delivery is disabled", nil)
	}
	stage, err := validateBindingPrepared(input, runnerbindingcontract.ParseStageBytes, runnerbindingcontract.PrepareStage)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	workspaceID := bindingString(stage, "workspaceId")
	if input.WorkspaceID != workspaceID {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "authenticated workspace and authority-binding stage differ", nil)
	}
	bindingID := bindingString(stage, "bindingId")
	target := bindingRecord(stage, "target")
	runnerHead := bindingRecord(stage, "runnerAuthority")
	route := bindingRecord(stage, "route")
	fingerprint, err := decodeFingerprint(input.RequestFingerprint)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("begin authority-binding stage", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, bindingLockDomain+input.IdempotencyKey, workspaceID, bindingString(stage, "jobId")); err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	if replay, found, readErr := readBindingReceiptRow(tx.QueryRow(ctx, `
SELECT workspace_id,stage_request_fingerprint,exact_stage_bytes,exact_stage_receipt_bytes
FROM workflow_runner_authority_bindings WHERE stage_idempotency_key=$1`, input.IdempotencyKey), workspaceID, fingerprint, []byte(input.Prepared.Body)); readErr != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, readErr
	} else if found {
		replay.Replay = true
		return replay, nil
	}

	var jobRunID, currentAttemptID, attemptState, currentLeaseID, leaseState string
	var protocol, backend, authority, admissionDisposition string
	var currentFence, workerSequence, currentRunRevision, currentGeneration, routingEpoch int64
	var build []byte
	err = tx.QueryRow(ctx, `
SELECT j.workflow_run_id,j.current_attempt_id,j.required_protocol_version,j.authority_backend,j.workflow_authority,
       j.routing_epoch,j.authority_build_hash,a.state,a.fencing_token,a.worker_sequence,
       l.lease_id,l.state,b.current_run_revision,b.current_resume_generation,b.admission_disposition
FROM workflow_runner_jobs j
JOIN workflow_runner_attempts a ON a.attempt_id=j.current_attempt_id
JOIN workflow_runner_leases l ON l.attempt_id=a.attempt_id
JOIN workflow_runner_v2_attempt_bindings b ON b.attempt_id=a.attempt_id
WHERE j.workspace_id=$1 AND j.job_id=$2
FOR UPDATE OF j,a,l,b`, workspaceID, bindingString(stage, "jobId")).Scan(
		&jobRunID, &currentAttemptID, &protocol, &backend, &authority, &routingEpoch, &build,
		&attemptState, &currentFence, &workerSequence, &currentLeaseID, &leaseState,
		&currentRunRevision, &currentGeneration, &admissionDisposition,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorNotFound, "active v2 attempt was not found", err)
		}
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("read authority-binding active attempt", err)
	}
	buildHash := hex.EncodeToString(build)
	if protocol != "openslack.workflow_runner.v2" || backend != "go" || authority != "workflow-control" ||
		jobRunID != bindingString(stage, "runId") || currentAttemptID != bindingString(stage, "runnerAttemptId") ||
		currentLeaseID != bindingString(stage, "leaseId") || currentFence != bindingInt(stage, "fencingToken") ||
		routingEpoch != bindingInt(route, "routingEpoch") || buildHash != bindingString(route, "authorityBuildHash") ||
		currentRunRevision != bindingInt(runnerHead, "expectedGlobalRunRevision") ||
		currentGeneration != bindingInt(runnerHead, "expectedResumeGeneration") ||
		bindingInt(target, "sequence") != workerSequence+1 ||
		(attemptState != "offered" && attemptState != "accepted" && attemptState != "running") ||
		(leaseState != "offered" && leaseState != "active") {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "authority-binding stage differs from the active Go v2 lease", nil)
	}
	if bindingString(stage, "operation") == string(runnerbindingcontract.OperationResumeAdvance) && admissionDisposition != "resume" {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "resume stage lacks a sealed resume admission", nil)
	}
	var outstanding bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM workflow_runner_authority_bindings
WHERE attempt_id=$1 AND state IN ('staged','resolved','runner_committed','reconciliation_required')
)`, currentAttemptID).Scan(&outstanding); err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("read outstanding authority binding", err)
	}
	if outstanding {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "another authority binding is outstanding for the attempt", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	if sentAt, parseErr := runnerstore.ParseTimestamp(bindingString(stage, "sentAt")); parseErr != nil || now.Before(sentAt) {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "authority-binding stage time is ahead of the database commit clock", parseErr)
	}
	receiptValue := phaseBindingReceipt(stage, input.Prepared.BodyHash, now, "stage_event", nil)
	receiptPrepared, err := runnerbindingcontract.PrepareReceipt(receiptValue)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, bindingContractFailure("build authority-binding stage receipt", err)
	}
	if _, err := runnerbindingcontract.ValidateStageReceipt(receiptPrepared.Value, stage); err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, bindingContractFailure("validate authority-binding stage receipt", err)
	}
	stageHash, _ := hex.DecodeString(input.Prepared.BodyHash)
	stageReceiptHashText, _ := runnerbindingcontract.HashReceipt(receiptPrepared.Value)
	stageReceiptHash, _ := hex.DecodeString(stageReceiptHashText)
	targetHash, _ := hex.DecodeString(bindingString(target, "messageDigest"))
	targetFingerprint, _ := decodeFingerprint(bindingString(target, "requestFingerprint"))
	buildBytes, _ := hex.DecodeString(bindingString(route, "authorityBuildHash"))
	_, err = tx.Exec(ctx, `
INSERT INTO workflow_runner_authority_bindings (
 binding_id,operation,state,workspace_id,job_id,run_id,attempt_id,lease_id,fencing_token,
 authority_backend,workflow_authority,routing_epoch,authority_build_hash,
 expected_run_revision,accepted_run_revision,expected_resume_generation,accepted_resume_generation,
 target_event_id,target_kind,target_sequence,target_body_hash,target_idempotency_key,target_request_fingerprint,exact_target_bytes,
 stage_idempotency_key,stage_request_fingerprint,stage_hash,exact_stage_bytes,stage_receipt_hash,exact_stage_receipt_bytes,
 stage_committed_at,created_at,updated_at
) VALUES ($1,$2,'staged',$3,$4,$5,$6,$7,$8,'go','workflow-control',$9,$10,$11,$12,$13,$14,
          $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$28,$28)`,
		bindingID, bindingString(stage, "operation"), workspaceID, bindingString(stage, "jobId"), bindingString(stage, "runId"),
		currentAttemptID, currentLeaseID, currentFence, bindingInt(route, "routingEpoch"), buildBytes,
		bindingInt(runnerHead, "expectedGlobalRunRevision"), bindingInt(runnerHead, "acceptedGlobalRunRevision"),
		bindingInt(runnerHead, "expectedResumeGeneration"), bindingInt(runnerHead, "acceptedResumeGeneration"),
		bindingString(target, "eventId"), bindingString(target, "kind"), bindingInt(target, "sequence"), targetHash,
		bindingString(target, "idempotencyKey"), targetFingerprint, []byte(bindingString(target, "body")),
		input.IdempotencyKey, fingerprint, stageHash, []byte(input.Prepared.Body), stageReceiptHash, []byte(receiptPrepared.Body), now,
	)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, mapWriteFailure("insert authority-binding stage", err)
	}
	if err := repository.commit(ctx, tx); err != nil {
		return repository.recoverBindingReceipt(ctx, workspaceID, input.IdempotencyKey, fingerprint, []byte(input.Prepared.Body), err)
	}
	return runnerstore.V2AuthorityBindingReceipt{Value: receiptPrepared.Value, ExactBytes: []byte(receiptPrepared.Body)}, nil
}

func (repository *Repository) ResolveAuthorityBinding(ctx context.Context, bindingID string, input runnerstore.V2AuthorityBindingInput) (runnerstore.V2AuthorityBindingReceipt, error) {
	if !repository.v2RuntimeDelivery || repository.schemaVersion < 8 {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "schema-8 runtime delivery is disabled", nil)
	}
	resolution, err := validateBindingPrepared(input, runnerbindingcontract.ParseResolutionBytes, runnerbindingcontract.PrepareResolution)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	if bindingString(resolution, "bindingId") != bindingID {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "resolution path and bindingId differ", nil)
	}
	fingerprint, err := decodeFingerprint(input.RequestFingerprint)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("begin authority-binding resolution", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, bindingLockDomain+input.IdempotencyKey, input.WorkspaceID, bindingID); err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	if replay, found, readErr := readBindingReceiptRow(tx.QueryRow(ctx, `
SELECT workspace_id,resolution_request_fingerprint,exact_resolution_bytes,exact_resolution_receipt_bytes
FROM workflow_runner_authority_bindings WHERE resolution_idempotency_key=$1`, input.IdempotencyKey), input.WorkspaceID, fingerprint, []byte(input.Prepared.Body)); readErr != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, readErr
	} else if found {
		replay.Replay = true
		return replay, nil
	}

	var workspaceID, state string
	var exactStage, exactStageReceipt []byte
	if err := tx.QueryRow(ctx, `SELECT workspace_id,state,exact_stage_bytes,exact_stage_receipt_bytes
FROM workflow_runner_authority_bindings WHERE binding_id=$1 FOR UPDATE`, bindingID).Scan(
		&workspaceID, &state, &exactStage, &exactStageReceipt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorNotFound, "authority binding was not found", err)
		}
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("lock authority binding for resolution", err)
	}
	if state != "staged" {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "authority binding is not awaiting its exact resolution", nil)
	}
	if workspaceID != input.WorkspaceID {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorNotFound, "authority binding was not found", nil)
	}
	stage, err := runnerbindingcontract.ParseStageBytes(exactStage)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding stage is invalid", err)
	}
	stageReceipt, err := runnerbindingcontract.ParseReceiptBytes(exactStageReceipt)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding stage receipt is invalid", err)
	}
	if _, err := runnerbindingcontract.ValidateResolutionForStage(resolution, stage, stageReceipt); err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, bindingContractFailure("resolution is not bound to the exact durable stage", err)
	}
	jobID := bindingString(stage, "jobId")
	runnerHead := bindingRecord(stage, "runnerAuthority")
	route := bindingRecord(stage, "route")
	var currentAttemptID, currentLeaseID, jobState, attemptState, leaseState, backend, authority string
	var currentFence, routingEpoch, currentRevision, currentGeneration int64
	var buildHash []byte
	currentErr := tx.QueryRow(ctx, `
SELECT j.current_attempt_id,j.state,j.authority_backend,j.workflow_authority,j.routing_epoch,j.authority_build_hash,
       a.state,a.fencing_token,l.lease_id,l.state,b.current_run_revision,b.current_resume_generation
FROM workflow_runner_jobs j
JOIN workflow_runner_attempts a ON a.attempt_id=j.current_attempt_id
JOIN workflow_runner_leases l ON l.attempt_id=a.attempt_id
JOIN workflow_runner_v2_attempt_bindings b ON b.attempt_id=a.attempt_id
WHERE j.workspace_id=$1 AND j.job_id=$2 FOR UPDATE OF j,a,l,b`, workspaceID, jobID).Scan(
		&currentAttemptID, &jobState, &backend, &authority, &routingEpoch, &buildHash,
		&attemptState, &currentFence, &currentLeaseID, &leaseState, &currentRevision, &currentGeneration,
	)
	driftReason := ""
	if currentErr != nil && !errors.Is(currentErr, pgx.ErrNoRows) {
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("revalidate authority-binding lease before resolution", currentErr)
	}
	if currentErr != nil || currentAttemptID != bindingString(stage, "runnerAttemptId") ||
		currentLeaseID != bindingString(stage, "leaseId") || currentFence != bindingInt(stage, "fencingToken") ||
		backend != bindingString(route, "backend") || authority != bindingString(route, "authority") ||
		routingEpoch != bindingInt(route, "routingEpoch") || hex.EncodeToString(buildHash) != bindingString(route, "authorityBuildHash") ||
		currentRevision != bindingInt(runnerHead, "expectedGlobalRunRevision") ||
		currentGeneration != bindingInt(runnerHead, "expectedResumeGeneration") ||
		(attemptState != "offered" && attemptState != "accepted" && attemptState != "running") ||
		(leaseState != "offered" && leaseState != "active") {
		switch {
		case jobState == "cancelling" || attemptState == "cancelling" || leaseState == "cancelling" || leaseState == "expired" || leaseState == "released" || leaseState == "superseded":
			driftReason = "cancelled_with_outstanding_authority"
		case jobState == "terminal" || attemptState == "terminal" || attemptState == "rejected" || attemptState == "expired":
			driftReason = "terminal_with_outstanding_authority"
		default:
			driftReason = "process_crash"
		}
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	if sentAt, parseErr := runnerstore.ParseTimestamp(bindingString(resolution, "sentAt")); parseErr != nil || now.Before(sentAt) {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "authority-binding resolution time is ahead of the database commit clock", parseErr)
	}
	receiptValue := phaseBindingReceipt(stage, input.Prepared.BodyHash, now, "commit_authority", resolution)
	reconciliationID := ""
	if driftReason != "" {
		reconciliationID, err = randomToken("wfrunner-reconciliation")
		if err != nil {
			return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorDatabase, "generate authority-binding reconciliation token", err)
		}
		receiptValue["status"] = "reconciliation_required"
		receiptValue["committedAt"] = nil
		receiptValue["reconciliationToken"] = reconciliationID
	}
	receiptPrepared, err := runnerbindingcontract.PrepareReceipt(receiptValue)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, bindingContractFailure("build authority-binding resolution receipt", err)
	}
	if _, err := runnerbindingcontract.ValidateResolutionReceipt(receiptPrepared.Value, resolution, stage, stageReceipt); err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, bindingContractFailure("validate authority-binding resolution receipt", err)
	}
	evidence, source := bindingEvidenceFields(resolution)
	resolutionHash := bindingDigestBytes(input.Prepared.BodyHash)
	receiptHashText, _ := runnerbindingcontract.HashReceipt(receiptPrepared.Value)
	receiptHash := bindingDigestBytes(receiptHashText)
	var acceptedRevision any
	if value, ok := source["acceptedRevision"].(int64); ok {
		acceptedRevision = value
	}
	var sourceReceiptHash, sourceRecordHash any
	if value, ok := source["receiptHash"].(string); ok {
		sourceReceiptHash = bindingDigestBytes(value)
	}
	if value, ok := source["recordHash"].(string); ok {
		sourceRecordHash = bindingDigestBytes(value)
	}
	updateSQL := `UPDATE workflow_runner_authority_bindings SET
 state='resolved',resolution_idempotency_key=$2,resolution_request_fingerprint=$3,resolution_hash=$4,
 exact_resolution_bytes=$5,resolution_receipt_hash=$6,exact_resolution_receipt_bytes=$7,resolution_committed_at=$8,
 source_plane=$9,source_evidence_state=$10,source_expected_revision=$11,source_accepted_revision=$12,
 source_expected_resume_generation=$13,source_accepted_resume_generation=$14,source_request_hash=$15,
 source_receipt_hash=$16,source_record_hash=$17,source_authority_build_hash=$18,updated_at=$8
WHERE binding_id=$1 AND state='staged'`
	if driftReason != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO workflow_runner_authority_reconciliations
(reconciliation_id,binding_id,workspace_id,job_id,attempt_id,reason,evidence_hash,created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, reconciliationID, bindingID, workspaceID, jobID,
			bindingString(stage, "runnerAttemptId"), driftReason, resolutionHash, now); err != nil {
			return runnerstore.V2AuthorityBindingReceipt{}, mapWriteFailure("insert authority-binding resolution reconciliation", err)
		}
		updateSQL = `UPDATE workflow_runner_authority_bindings SET
 state='reconciliation_required',resolution_idempotency_key=$2,resolution_request_fingerprint=$3,resolution_hash=$4,
 exact_resolution_bytes=$5,resolution_receipt_hash=$6,exact_resolution_receipt_bytes=$7,resolution_committed_at=$8,
 source_plane=$9,source_evidence_state=$10,source_expected_revision=$11,source_accepted_revision=$12,
 source_expected_resume_generation=$13,source_accepted_resume_generation=$14,source_request_hash=$15,
 source_receipt_hash=$16,source_record_hash=$17,source_authority_build_hash=$18,updated_at=$8,
 reconciliation_id=$19,reconciliation_reason=$20
WHERE binding_id=$1 AND state='staged'`
	}
	arguments := []any{bindingID, input.IdempotencyKey, fingerprint, resolutionHash,
		[]byte(input.Prepared.Body), receiptHash, []byte(receiptPrepared.Body), now,
		bindingString(source, "plane"), bindingString(source, "evidenceState"), bindingInt(source, "expectedRevision"), acceptedRevision,
		bindingInt(source, "expectedResumeGeneration"), bindingInt(source, "acceptedResumeGeneration"),
		bindingDigestBytes(bindingString(source, "requestHash")), sourceReceiptHash, sourceRecordHash,
		bindingDigestBytes(bindingString(source, "authorityBuildHash"))}
	if driftReason != "" {
		arguments = append(arguments, reconciliationID, driftReason)
	}
	tag, err := tx.Exec(ctx, updateSQL, arguments...)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, mapWriteFailure("resolve authority binding", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "authority binding resolution predecessor changed", nil)
	}
	_ = evidence // evidence was contextually validated; only its closed source identity is indexed.
	if err := repository.commit(ctx, tx); err != nil {
		return repository.recoverBindingReceipt(ctx, workspaceID, input.IdempotencyKey, fingerprint, []byte(input.Prepared.Body), err)
	}
	return runnerstore.V2AuthorityBindingReceipt{Value: receiptPrepared.Value, ExactBytes: []byte(receiptPrepared.Body)}, nil
}

func decodeExactAuthorityMessage(exact []byte) (authoritycontract.Message, error) {
	if len(exact) == 0 || exact[len(exact)-1] != '\n' {
		return authoritycontract.Message{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 control frame is not LF framed", nil)
	}
	message, err := authoritycontract.DecodeMessageJSON(exact[:len(exact)-1])
	if err != nil {
		return authoritycontract.Message{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 control frame is invalid", err)
	}
	prepared, err := prepareV2Message(message)
	if err != nil || !bytes.Equal(exact, []byte(prepared.Body)) {
		return authoritycontract.Message{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 control frame is not exact canonical bytes", err)
	}
	return message, nil
}

func (repository *Repository) AcknowledgeV2Control(ctx context.Context, input runnerstore.V2ControlAcknowledgementInput) (runnerstore.V2AuthorityBindingReceipt, error) {
	if !repository.v2RuntimeDelivery || repository.schemaVersion < 8 {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "schema-8 runtime delivery is disabled", nil)
	}
	receipt, err := validateBindingPrepared(runnerstore.V2AuthorityBindingInput{
		WorkspaceID: input.WorkspaceID, Prepared: input.Prepared,
		IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint,
	}, runnerbindingcontract.ParseReceiptBytes, runnerbindingcontract.PrepareReceipt)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	if bindingString(receipt, "phase") != "control_delivery" || bindingString(receipt, "bindingId") != input.BindingID {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "control ACK path and exact receipt identity differ", nil)
	}
	fingerprint, err := decodeFingerprint(input.RequestFingerprint)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("begin authority-binding control ACK", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, bindingLockDomain+input.IdempotencyKey, input.WorkspaceID, input.BindingID); err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	if replay, found, readErr := readBindingReceiptRow(tx.QueryRow(ctx, `
SELECT b.workspace_id,a.ack_request_fingerprint,a.exact_ack_bytes,a.exact_ack_bytes
FROM workflow_runner_authority_control_acks a
JOIN workflow_runner_authority_bindings b ON b.binding_id=a.binding_id
WHERE a.ack_idempotency_key=$1`, input.IdempotencyKey), input.WorkspaceID, fingerprint, []byte(input.Prepared.Body)); readErr != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, readErr
	} else if found {
		replay.Replay = true
		return replay, nil
	}

	var workspaceID, state, operation string
	var attemptID, leaseID string
	var fence int64
	var exactStage, exactStageReceipt, exactResolution, exactResolutionReceipt, exactSourceResult []byte
	if err := tx.QueryRow(ctx, `SELECT workspace_id,state,operation,attempt_id,lease_id,fencing_token,
exact_stage_bytes,exact_stage_receipt_bytes,exact_resolution_bytes,exact_resolution_receipt_bytes,exact_source_result_bytes
FROM workflow_runner_authority_bindings WHERE binding_id=$1 FOR UPDATE`, input.BindingID).Scan(
		&workspaceID, &state, &operation, &attemptID, &leaseID, &fence,
		&exactStage, &exactStageReceipt, &exactResolution, &exactResolutionReceipt, &exactSourceResult,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorNotFound, "authority binding was not found", err)
		}
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("lock authority binding for control ACK", err)
	}
	if workspaceID != input.WorkspaceID {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorNotFound, "authority binding was not found", nil)
	}
	if state != "runner_committed" {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "authority binding is not awaiting an exact control ACK", nil)
	}
	stage, err := runnerbindingcontract.ParseStageBytes(exactStage)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding stage is invalid", err)
	}
	stageReceipt, err := runnerbindingcontract.ParseReceiptBytes(exactStageReceipt)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding stage receipt is invalid", err)
	}
	resolution, err := runnerbindingcontract.ParseResolutionBytes(exactResolution)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding resolution is invalid", err)
	}
	resolutionReceipt, err := runnerbindingcontract.ParseReceiptBytes(exactResolutionReceipt)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding resolution receipt is invalid", err)
	}

	controlEventID := bindingString(receipt, "controlEventId")
	var exactControl []byte
	if err := tx.QueryRow(ctx, `SELECT CASE WHEN c.kind='cancel_request' THEN v.exact_v2_message_bytes ELSE c.exact_message_bytes END
FROM workflow_runner_control_messages c
LEFT JOIN workflow_runner_v2_cancel_bindings v ON v.control_event_id=c.control_event_id
WHERE c.control_event_id=$1 FOR UPDATE OF c`, controlEventID).Scan(&exactControl); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorNotFound, "exact v2 control message was not found", err)
		}
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("lock exact v2 control message for ACK", err)
	}
	message, err := decodeExactAuthorityMessage(exactControl)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	var prior any
	var priorControlEventID any
	if bindingInt(receipt, "companionSequence") == 4 {
		var priorMessageBytes, priorReceiptBytes []byte
		var priorEventID string
		if err := tx.QueryRow(ctx, `SELECT a.control_event_id,c.exact_message_bytes,a.exact_ack_bytes
FROM workflow_runner_authority_control_acks a
JOIN workflow_runner_control_messages c ON c.control_event_id=a.control_event_id
WHERE a.binding_id=$1 AND a.companion_sequence=3`, input.BindingID).Scan(
			&priorEventID, &priorMessageBytes, &priorReceiptBytes,
		); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "control decision ACK lacks its exact event-receipt predecessor", err)
			}
			return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("read prior authority-binding control ACK", err)
		}
		priorMessage, parseErr := decodeExactAuthorityMessage(priorMessageBytes)
		if parseErr != nil {
			return runnerstore.V2AuthorityBindingReceipt{}, parseErr
		}
		priorReceipt, parseErr := runnerbindingcontract.ParseReceiptBytes(priorReceiptBytes)
		if parseErr != nil {
			return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored prior control ACK is invalid", parseErr)
		}
		prior = runnerbindingcontract.Record{"message": priorMessage, "receipt": priorReceipt}
		priorControlEventID = priorEventID
	}
	var budgetSource any
	if message.Kind == authoritycontract.KindBudgetAuthorization {
		evidence := bindingRecord(resolution, "evidence")
		if len(exactSourceResult) == 0 {
			return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "budget authorization lacks its exact durable source result", nil)
		}
		budgetSource, err = runnerbindingcontract.ParseBudgetSourceResultBytes(exactSourceResult, evidence["preparedRequest"])
		if err != nil {
			return runnerstore.V2AuthorityBindingReceipt{}, bindingContractFailure("exact durable budget source result is invalid", err)
		}
	}
	if _, err := runnerbindingcontract.ValidateControlDeliveryReceiptForMessage(receipt, message, runnerbindingcontract.ControlDeliveryValidationContext{
		Stage: stage, Resolution: resolution, ResolutionReceipt: resolutionReceipt,
		StageReceipt: stageReceipt, PriorEventDelivery: prior, BudgetSourceResult: budgetSource,
	}); err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, bindingContractFailure("control ACK is not bound to the exact durable exchange", err)
	}
	processedAt, err := runnerstore.ParseTimestamp(bindingString(receipt, "processedAt"))
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "control ACK processing time is invalid", err)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, err
	}
	if now.Before(processedAt) {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "control ACK processing time is ahead of the database clock", nil)
	}
	ackHash := sha256.Sum256([]byte(input.Prepared.Body))
	messageDigest := bindingDigestBytes(bindingString(receipt, "messageDigest"))
	_, err = tx.Exec(ctx, `INSERT INTO workflow_runner_authority_control_acks (
control_event_id,binding_id,control_kind,control_sequence,companion_sequence,message_digest,
attempt_id,lease_id,fencing_token,disposition,ack_idempotency_key,ack_request_fingerprint,
ack_hash,exact_ack_bytes,prior_control_event_id,processed_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		controlEventID, input.BindingID, bindingString(receipt, "controlKind"), bindingInt(receipt, "controlSequence"),
		bindingInt(receipt, "companionSequence"), messageDigest, attemptID, leaseID, fence,
		bindingString(receipt, "disposition"), input.IdempotencyKey, fingerprint, ackHash[:],
		[]byte(input.Prepared.Body), priorControlEventID, processedAt,
	)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, mapWriteFailure("insert exact authority-binding control ACK", err)
	}
	reconciliationReason := ""
	if bindingString(receipt, "disposition") == "reconciliation_required" {
		reconciliationReason = "control_delivery_unknown"
	} else if message.Kind == authoritycontract.KindCancelRequest {
		reconciliationReason = "cancelled_with_outstanding_authority"
	}
	if reconciliationReason != "" {
		reconciliationID, tokenErr := randomToken("wfrunner-reconciliation")
		if tokenErr != nil {
			return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorDatabase, "generate control ACK reconciliation token", tokenErr)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO workflow_runner_authority_reconciliations
(reconciliation_id,binding_id,workspace_id,job_id,attempt_id,reason,evidence_hash,created_at)
SELECT $1,binding_id,workspace_id,job_id,attempt_id,$2,$3,$4 FROM workflow_runner_authority_bindings WHERE binding_id=$5`,
			reconciliationID, reconciliationReason, ackHash[:], now, input.BindingID); err != nil {
			return runnerstore.V2AuthorityBindingReceipt{}, mapWriteFailure("insert control ACK reconciliation", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_authority_bindings
SET state='reconciliation_required',reconciliation_id=$2,reconciliation_reason=$3,updated_at=$4
WHERE binding_id=$1 AND state='runner_committed'`, input.BindingID, reconciliationID, reconciliationReason, now); err != nil {
			return runnerstore.V2AuthorityBindingReceipt{}, mapWriteFailure("latch control ACK reconciliation", err)
		}
	} else {
		completes := (message.Kind == authoritycontract.KindEventReceipt &&
			(operation == "checkpoint_commit" || operation == "effect_complete" || operation == "budget_settle")) ||
			message.Kind == authoritycontract.KindEffectAuthorization || message.Kind == authoritycontract.KindBudgetAuthorization ||
			message.Kind == authoritycontract.KindResumeOffer
		if completes && message.Kind == authoritycontract.KindEventReceipt {
			var pendingCancel bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM workflow_runner_cancel_controls
WHERE attempt_id=$1 AND state='pending')`, attemptID).Scan(&pendingCancel); err != nil {
				return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("read optional authority companion cancellation", err)
			}
			completes = !pendingCancel
		}
		if completes {
			if _, err := tx.Exec(ctx, `UPDATE workflow_runner_authority_bindings SET state='completed',updated_at=$2
WHERE binding_id=$1 AND state='runner_committed'`, input.BindingID, now); err != nil {
				return runnerstore.V2AuthorityBindingReceipt{}, mapWriteFailure("complete authority binding after exact ACK set", err)
			}
		}
	}
	if err := repository.commit(ctx, tx); err != nil {
		return repository.recoverBindingReceipt(ctx, workspaceID, input.IdempotencyKey, fingerprint, []byte(input.Prepared.Body), err)
	}
	return runnerstore.V2AuthorityBindingReceipt{Value: receipt, ExactBytes: []byte(input.Prepared.Body)}, nil
}

func phaseBindingReceipt(stage runnerbindingcontract.Record, requestHash string, now time.Time, phase string, resolution runnerbindingcontract.Record) runnerbindingcontract.Record {
	target := bindingRecord(stage, "target")
	route := bindingRecord(stage, "route")
	value := runnerbindingcontract.Record{
		"schema": runnerbindingcontract.ReceiptSchema, "contractVersion": runnerbindingcontract.ContractVersion,
		"profile": runnerbindingcontract.FutureRuntimeProfile, "direction": "control-to-runner", "phase": phase,
		"companionSequence": int64(1), "bindingId": bindingString(stage, "bindingId"), "operation": bindingString(stage, "operation"),
		"status": "accepted", "controlBuildHash": bindingString(route, "authorityBuildHash"),
		"committedAt": runnerstore.CanonicalTimestamp(now), "reconciliationToken": nil,
		"requestHash": requestHash, "targetEventId": bindingString(target, "eventId"),
		"targetBodyHash": bindingString(target, "messageDigest"), "evidenceHash": nil,
	}
	if phase == "commit_authority" {
		value["companionSequence"] = int64(2)
		value["stageHash"] = bindingString(resolution, "stageHash")
		value["stageReceiptHash"] = bindingString(resolution, "stageReceiptHash")
		value["evidenceHash"] = bindingString(resolution, "evidenceHash")
		value["controlBuildHash"] = bindingString(bindingRecord(bindingRecord(resolution, "evidence"), "sourceAuthority"), "authorityBuildHash")
	}
	return value
}

func bindingString(record runnerbindingcontract.Record, name string) string {
	value, _ := record[name].(string)
	return value
}

func bindingInt(record runnerbindingcontract.Record, name string) int64 {
	value, _ := record[name].(int64)
	return value
}

func bindingRecord(record runnerbindingcontract.Record, name string) runnerbindingcontract.Record {
	switch value := record[name].(type) {
	case runnerbindingcontract.Record:
		return value
	case map[string]any:
		return runnerbindingcontract.Record(value)
	default:
		return nil
	}
}

func readBindingReceiptRow(row pgx.Row, workspaceID string, fingerprint, request []byte) (runnerstore.V2AuthorityBindingReceipt, bool, error) {
	var stored storedBindingReceipt
	if err := row.Scan(&stored.workspaceID, &stored.fingerprint, &stored.request, &stored.receipt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return runnerstore.V2AuthorityBindingReceipt{}, false, nil
		}
		return runnerstore.V2AuthorityBindingReceipt{}, false, databaseFailure("read authority-binding receipt", err)
	}
	if (workspaceID != "" && stored.workspaceID != workspaceID) || subtle.ConstantTimeCompare(stored.fingerprint, fingerprint) != 1 || !bytes.Equal(stored.request, request) {
		return runnerstore.V2AuthorityBindingReceipt{}, false, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "authority-binding key is bound to different exact bytes", nil)
	}
	value, err := runnerbindingcontract.ParseReceiptBytes(stored.receipt)
	if err != nil {
		return runnerstore.V2AuthorityBindingReceipt{}, false, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding receipt is invalid", err)
	}
	return runnerstore.V2AuthorityBindingReceipt{Value: value, ExactBytes: stored.receipt}, true, nil
}

func (repository *Repository) ReadAuthorityBindingReceipt(ctx context.Context, workspaceID, key string) (runnerstore.V2AuthorityBindingReceipt, error) {
	if !repository.v2RuntimeDelivery || repository.schemaVersion < 8 {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "schema-8 runtime delivery is disabled", nil)
	}
	var storedWorkspace, receiptKind string
	var expectedHash, exact []byte
	err := repository.pool.QueryRow(ctx, `SELECT workspace_id,receipt_kind,expected_hash,exact_receipt_bytes FROM (
 SELECT workspace_id,'binding_receipt' AS receipt_kind,stage_receipt_hash AS expected_hash,exact_stage_receipt_bytes AS exact_receipt_bytes,
        stage_idempotency_key AS idempotency_key
   FROM workflow_runner_authority_bindings
 UNION ALL
 SELECT workspace_id,'binding_receipt',resolution_receipt_hash,exact_resolution_receipt_bytes,resolution_idempotency_key
   FROM workflow_runner_authority_bindings WHERE resolution_idempotency_key IS NOT NULL
 UNION ALL
 SELECT b.workspace_id,'control_ack',a.ack_hash,a.exact_ack_bytes,a.ack_idempotency_key
   FROM workflow_runner_authority_control_acks a JOIN workflow_runner_authority_bindings b ON b.binding_id=a.binding_id
) receipts WHERE idempotency_key=$1`, key).Scan(&storedWorkspace, &receiptKind, &expectedHash, &exact)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorNotFound, "authority-binding receipt was not found", err)
		}
		return runnerstore.V2AuthorityBindingReceipt{}, databaseFailure("read authority-binding receipt", err)
	}
	if storedWorkspace != workspaceID {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorNotFound, "authority-binding receipt was not found", nil)
	}
	value, err := runnerbindingcontract.ParseReceiptBytes(exact)
	hashValid := false
	if receiptKind == "control_ack" {
		digest := sha256.Sum256(exact)
		hashValid = subtle.ConstantTimeCompare(digest[:], expectedHash) == 1
	} else if receiptKind == "binding_receipt" {
		hashValid = ensureReceiptHash(exact, expectedHash) == nil
	}
	if err != nil || !hashValid {
		return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding receipt failed exact integrity validation", err)
	}
	return runnerstore.V2AuthorityBindingReceipt{Value: value, ExactBytes: exact, Replay: true}, nil
}

func scanAuthorityBindingView(row pgx.Row) (runnerstore.V2AuthorityBindingView, error) {
	var view runnerstore.V2AuthorityBindingView
	var operation string
	err := row.Scan(
		&view.BindingID, &operation, &view.State, &view.WorkspaceID, &view.JobID, &view.RunID,
		&view.AttemptID, &view.LeaseID, &view.FencingToken, &view.ExpectedRunRevision, &view.AcceptedRunRevision,
		&view.ExpectedGeneration, &view.AcceptedGeneration, &view.TargetEventID, &view.TargetKind,
		&view.TargetSequence, &view.ExactTargetBytes, &view.ExactStageBytes, &view.ExactStageReceipt,
		&view.ExactResolutionBytes, &view.ExactResolutionReceipt, &view.SourcePlane, &view.SourceEvidenceState,
		&view.ExactSourceResult, &view.SourceResultHash, &view.ReconciliationID, &view.ReconciliationReason,
		&view.CreatedAt, &view.UpdatedAt,
	)
	if err != nil {
		return runnerstore.V2AuthorityBindingView{}, err
	}
	view.Operation = runnerbindingcontract.Operation(operation)
	return view, nil
}

const authorityBindingViewColumns = `binding_id,operation,state,workspace_id,job_id,run_id,attempt_id,lease_id,
fencing_token,expected_run_revision,accepted_run_revision,expected_resume_generation,accepted_resume_generation,
target_event_id,target_kind,target_sequence,exact_target_bytes,exact_stage_bytes,exact_stage_receipt_bytes,
exact_resolution_bytes,exact_resolution_receipt_bytes,source_plane,source_evidence_state,
exact_source_result_bytes,source_result_hash,reconciliation_id,reconciliation_reason,created_at,updated_at`

func (repository *Repository) loadAuthorityBindingACKs(ctx context.Context, bindingID string) ([]runnerstore.V2ControlAcknowledgementView, error) {
	rows, err := repository.pool.Query(ctx, `SELECT a.control_event_id,a.control_kind,a.control_sequence,a.companion_sequence,
a.disposition,CASE WHEN c.kind='cancel_request' THEN v.exact_v2_message_bytes ELSE c.exact_message_bytes END,
a.exact_ack_bytes,a.processed_at
FROM workflow_runner_authority_control_acks a
JOIN workflow_runner_control_messages c ON c.control_event_id=a.control_event_id
LEFT JOIN workflow_runner_v2_cancel_bindings v ON v.control_event_id=c.control_event_id
WHERE a.binding_id=$1 ORDER BY a.companion_sequence`, bindingID)
	if err != nil {
		return nil, databaseFailure("read authority-binding ACK recovery set", err)
	}
	defer rows.Close()
	acks := make([]runnerstore.V2ControlAcknowledgementView, 0, 2)
	for rows.Next() {
		var ack runnerstore.V2ControlAcknowledgementView
		if err := rows.Scan(&ack.ControlEventID, &ack.ControlKind, &ack.ControlSequence, &ack.CompanionSequence,
			&ack.Disposition, &ack.ExactControlBytes, &ack.ExactACKBytes, &ack.ProcessedAt); err != nil {
			return nil, databaseFailure("scan authority-binding ACK recovery set", err)
		}
		if _, err := decodeExactAuthorityMessage(ack.ExactControlBytes); err != nil {
			return nil, err
		}
		if _, err := runnerbindingcontract.ParseReceiptBytes(ack.ExactACKBytes); err != nil {
			return nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding ACK is invalid", err)
		}
		acks = append(acks, ack)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseFailure("iterate authority-binding ACK recovery set", err)
	}
	return acks, nil
}

func validateRecoveredBinding(view runnerstore.V2AuthorityBindingView) error {
	stage, err := runnerbindingcontract.ParseStageBytes(view.ExactStageBytes)
	if err != nil {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding stage is invalid", err)
	}
	stageReceipt, err := runnerbindingcontract.ParseReceiptBytes(view.ExactStageReceipt)
	if err != nil {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding stage receipt is invalid", err)
	}
	if _, err := runnerbindingcontract.ValidateStageReceipt(stageReceipt, stage); err != nil {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding stage receipt is cross-spliced", err)
	}
	hasResolution := len(view.ExactResolutionBytes) != 0 || len(view.ExactResolutionReceipt) != 0
	if !hasResolution {
		if view.State != "staged" && view.State != "reconciliation_required" {
			return runnerstore.Failure(runnerstore.ErrorReconciliation, "authority-binding state requires a durable resolution", nil)
		}
		return nil
	}
	if len(view.ExactResolutionBytes) == 0 || len(view.ExactResolutionReceipt) == 0 {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "authority-binding resolution phase is partially persisted", nil)
	}
	resolution, err := runnerbindingcontract.ParseResolutionBytes(view.ExactResolutionBytes)
	if err != nil {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding resolution is invalid", err)
	}
	resolutionReceipt, err := runnerbindingcontract.ParseReceiptBytes(view.ExactResolutionReceipt)
	if err != nil {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding resolution receipt is invalid", err)
	}
	if _, err := runnerbindingcontract.ValidateResolutionReceipt(resolutionReceipt, resolution, stage, stageReceipt); err != nil {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding resolution receipt is cross-spliced", err)
	}
	if len(view.ExactSourceResult) != 0 {
		digest := sha256.Sum256(view.ExactSourceResult)
		if subtle.ConstantTimeCompare(digest[:], view.SourceResultHash) != 1 {
			return runnerstore.Failure(runnerstore.ErrorReconciliation, "stored authority-binding source result hash differs", nil)
		}
		evidence := bindingRecord(resolution, "evidence")
		switch view.Operation {
		case runnerbindingcontract.OperationBudgetReserve:
			if _, err := runnerbindingcontract.ParseBudgetSourceResultBytes(view.ExactSourceResult, evidence["preparedRequest"]); err != nil {
				return runnerstore.Failure(runnerstore.ErrorReconciliation, "stored budget reserve source result is invalid", err)
			}
		case runnerbindingcontract.OperationBudgetSettle:
			if _, err := runnerbindingcontract.ParseBudgetSettlementSourceReceiptBytes(view.ExactSourceResult, evidence["preparedRequest"]); err != nil {
				return runnerstore.Failure(runnerstore.ErrorReconciliation, "stored budget settlement source receipt is invalid", err)
			}
		default:
			return runnerstore.Failure(runnerstore.ErrorReconciliation, "non-budget authority binding contains a source result", nil)
		}
	} else if (view.State == "runner_committed" || view.State == "completed") &&
		(view.Operation == runnerbindingcontract.OperationBudgetReserve || view.Operation == runnerbindingcontract.OperationBudgetSettle) {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "committed budget authority binding lacks a source result", nil)
	}
	return nil
}

func (repository *Repository) ReadAuthorityBindingForEvent(ctx context.Context, eventID string, exactEventBytes []byte) (runnerstore.V2AuthorityBindingView, error) {
	if !repository.v2RuntimeDelivery || repository.schemaVersion < 8 {
		return runnerstore.V2AuthorityBindingView{}, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "schema-8 runtime delivery is disabled", nil)
	}
	view, err := scanAuthorityBindingView(repository.pool.QueryRow(ctx, `SELECT `+authorityBindingViewColumns+`
FROM workflow_runner_authority_bindings WHERE target_event_id=$1`, eventID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return runnerstore.V2AuthorityBindingView{}, runnerstore.Failure(runnerstore.ErrorNotFound, "authority binding for event was not found", err)
		}
		return runnerstore.V2AuthorityBindingView{}, databaseFailure("read authority binding for event", err)
	}
	if !bytes.Equal(view.ExactTargetBytes, exactEventBytes) {
		return runnerstore.V2AuthorityBindingView{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "authority binding event id is bound to different exact bytes", nil)
	}
	if err := validateRecoveredBinding(view); err != nil {
		return runnerstore.V2AuthorityBindingView{}, err
	}
	view.ControlACKs, err = repository.loadAuthorityBindingACKs(ctx, view.BindingID)
	if err != nil {
		return runnerstore.V2AuthorityBindingView{}, err
	}
	return view, nil
}

func (repository *Repository) RecoverAuthorityBindings(ctx context.Context, workspaceID string, before time.Time, limit int) ([]runnerstore.V2AuthorityBindingView, error) {
	if !repository.v2RuntimeDelivery || repository.schemaVersion < 8 {
		return nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "schema-8 runtime delivery is disabled", nil)
	}
	if limit < 1 || limit > 1000 {
		return nil, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "authority-binding recovery limit is invalid", nil)
	}
	rows, err := repository.pool.Query(ctx, `SELECT `+authorityBindingViewColumns+`
FROM workflow_runner_authority_bindings
WHERE workspace_id=$1 AND state<>'completed' AND updated_at<=$2
ORDER BY updated_at,binding_id LIMIT $3`, workspaceID, before.UTC(), limit)
	if err != nil {
		return nil, databaseFailure("recover authority bindings", err)
	}
	defer rows.Close()
	views := make([]runnerstore.V2AuthorityBindingView, 0, limit)
	for rows.Next() {
		view, scanErr := scanAuthorityBindingView(rows)
		if scanErr != nil {
			return nil, databaseFailure("scan recovered authority binding", scanErr)
		}
		if validateErr := validateRecoveredBinding(view); validateErr != nil {
			return nil, validateErr
		}
		view.ControlACKs, scanErr = repository.loadAuthorityBindingACKs(ctx, view.BindingID)
		if scanErr != nil {
			return nil, scanErr
		}
		views = append(views, view)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseFailure("iterate recovered authority bindings", err)
	}
	return views, nil
}

func (repository *Repository) recoverBindingReceipt(ctx context.Context, workspaceID, key string, fingerprint, request []byte, commitErr error) (runnerstore.V2AuthorityBindingReceipt, error) {
	recovered, found, err := repository.readBindingReceipt(ctx, workspaceID, key, fingerprint, request)
	if err == nil && found {
		recovered.Replay = true
		return recovered, nil
	}
	return runnerstore.V2AuthorityBindingReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "authority-binding commit outcome is unknown", errors.Join(commitErr, err))
}

func (repository *Repository) readBindingReceipt(ctx context.Context, workspaceID, key string, fingerprint, request []byte) (runnerstore.V2AuthorityBindingReceipt, bool, error) {
	return readBindingReceiptRow(repository.pool.QueryRow(ctx, `
SELECT workspace_id,request_fingerprint,exact_request_bytes,exact_receipt_bytes FROM (
 SELECT workspace_id,stage_request_fingerprint AS request_fingerprint,exact_stage_bytes AS exact_request_bytes,
        exact_stage_receipt_bytes AS exact_receipt_bytes,stage_idempotency_key AS idempotency_key
   FROM workflow_runner_authority_bindings
 UNION ALL
 SELECT workspace_id,resolution_request_fingerprint,exact_resolution_bytes,exact_resolution_receipt_bytes,resolution_idempotency_key
   FROM workflow_runner_authority_bindings WHERE resolution_idempotency_key IS NOT NULL
 UNION ALL
 SELECT b.workspace_id,a.ack_request_fingerprint,a.exact_ack_bytes,a.exact_ack_bytes,a.ack_idempotency_key
   FROM workflow_runner_authority_control_acks a JOIN workflow_runner_authority_bindings b ON b.binding_id=a.binding_id
) receipts WHERE idempotency_key=$1`, key), workspaceID, fingerprint, request)
}

func bindingDigestBytes(value string) []byte {
	decoded, _ := hex.DecodeString(value)
	return decoded
}

func bindingFingerprintBytes(value string) []byte {
	decoded, _ := hex.DecodeString(string(bytes.TrimPrefix([]byte(value), []byte("sha256:"))))
	return decoded
}

func bindingEvidenceFields(resolution runnerbindingcontract.Record) (runnerbindingcontract.Record, runnerbindingcontract.Record) {
	evidence := bindingRecord(resolution, "evidence")
	return evidence, bindingRecord(evidence, "sourceAuthority")
}

func ensureReceiptHash(exact []byte, expected []byte) error {
	receipt, err := runnerbindingcontract.ParseReceiptBytes(exact)
	if err != nil {
		return err
	}
	digestText, err := runnerbindingcontract.HashReceipt(receipt)
	if err != nil {
		return err
	}
	digest := bindingDigestBytes(digestText)
	if subtle.ConstantTimeCompare(digest, expected) != 1 {
		return fmt.Errorf("exact receipt SHA-256 differs")
	}
	return nil
}
