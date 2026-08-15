package postgres

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

const v2JobReceiptByKeySQL = `
SELECT r.request_fingerprint, r.exact_receipt_bytes, r.workspace_id, r.job_id,
       r.idempotency_key, encode(r.job_spec_hash,'hex'), j.workflow_run_id,
       r.status, r.reconciliation_id
FROM workflow_runner_job_receipts r
JOIN workflow_runner_jobs j
  ON j.workspace_id=r.workspace_id AND j.job_id=r.job_id
WHERE r.idempotency_key=$1`

func (repository *Repository) SubmitV2(ctx context.Context, input runnerstore.V2SubmitInput) (runnerstore.V2JobReceipt, error) {
	if err := runnerstore.ValidateV2SubmitInput(input); err != nil {
		return runnerstore.V2JobReceipt{}, err
	}
	fingerprint, err := decodeFingerprint(input.RequestFingerprint)
	if err != nil {
		return runnerstore.V2JobReceipt{}, err
	}
	spec := input.Prepared.Spec
	submittedAt, _ := runnerstore.ParseTimestamp(spec.SubmittedAt)
	deadline := submittedAt.Add(time.Duration(spec.WholeTimeoutMS) * time.Millisecond)
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.V2JobReceipt{}, databaseFailure("begin v2 job submission", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, input.IdempotencyKey, spec.WorkspaceID, spec.JobID); err != nil {
		return runnerstore.V2JobReceipt{}, err
	}
	if receipt, raw, readErr := readV2JobReceipt(tx.QueryRow(ctx, v2JobReceiptByKeySQL, input.IdempotencyKey)); readErr == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) != 1 {
			return runnerstore.V2JobReceipt{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "v2 job key is bound to another request", nil)
		}
		if err := runnerstore.ValidateV2JobReceiptForSubmit(receipt, input); err != nil {
			return runnerstore.V2JobReceipt{}, err
		}
		return receipt, nil
	} else if !errors.Is(readErr, pgx.ErrNoRows) {
		return runnerstore.V2JobReceipt{}, databaseFailure("read v2 job receipt", readErr)
	}
	admittedAt, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.V2JobReceipt{}, err
	}
	if submittedAt.After(admittedAt.Add(maxSubmissionFutureSkew)) || submittedAt.Before(admittedAt.Add(-maxSubmissionPastSkew)) {
		return runnerstore.V2JobReceipt{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "v2 job submittedAt is outside the admission window", nil)
	}
	if !deadline.After(admittedAt) || deadline.After(admittedAt.Add(runnerstore.MaxWholeTimeout)) {
		return runnerstore.V2JobReceipt{}, runnerstore.Failure(runnerstore.ErrorTimeout, "v2 job deadline is outside the database-clock bound", nil)
	}
	descriptorHash, _ := hex.DecodeString(spec.ExecutionDescriptorHash)
	jobSpecHash, _ := hex.DecodeString(input.Prepared.JobSpecHash)
	sourceHash, _ := hex.DecodeString(spec.WorkflowSourceHash)
	manifestHash, _ := hex.DecodeString(spec.ManifestHash)
	inputHash, _ := hex.DecodeString(spec.InputHash)
	authorityBuildHash, _ := hex.DecodeString(spec.AuthorityRoute.AuthorityBuildHash)
	_, err = tx.Exec(ctx, `
INSERT INTO workflow_runner_jobs (
 workspace_id,job_id,workflow_run_id,correlation_id,execution_descriptor_ref,execution_descriptor_hash,
 job_spec_hash,exact_spec_bytes,workflow_id,workflow_version,workflow_source_hash,manifest_hash,input_hash,
 whole_deadline,state,revision,created_at,updated_at,required_protocol_version,required_capabilities,
 authority_backend,workflow_authority,routing_epoch,authority_build_hash,required_run_revision,required_resume_generation
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',1,$15,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
		spec.WorkspaceID, spec.JobID, spec.WorkflowRunID, spec.CorrelationID,
		spec.ExecutionDescriptorRef, descriptorHash, jobSpecHash, input.Prepared.ExactBody,
		spec.WorkflowID, spec.WorkflowVersion, sourceHash, manifestHash, inputHash, deadline, admittedAt,
		spec.RequiredProtocolVersion, spec.RequiredCapabilities, spec.AuthorityRoute.Backend,
		spec.AuthorityRoute.Authority, spec.AuthorityRoute.RoutingEpoch, authorityBuildHash,
		spec.RunRevision, spec.ResumeGeneration)
	if err != nil {
		return runnerstore.V2JobReceipt{}, mapWriteFailure("insert v2 runner job", err)
	}
	committedAt, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.V2JobReceipt{}, err
	}
	receiptID, err := randomToken("runner-v2-job-receipt")
	if err != nil {
		return runnerstore.V2JobReceipt{}, err
	}
	receipt := runnerstore.V2JobReceipt{
		Schema: runnerstore.V2JobReceiptSchema, Status: runnerstore.ReceiptAccepted,
		WorkspaceID: spec.WorkspaceID, JobID: spec.JobID, WorkflowRunID: spec.WorkflowRunID,
		State: runnerstore.JobQueued, Revision: 1, JobSpecHash: input.Prepared.JobSpecHash,
		IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint,
		CommittedAt: runnerstore.CanonicalTimestamp(committedAt),
	}
	if err := runnerstore.ValidateV2JobReceiptForSubmit(receipt, input); err != nil {
		return runnerstore.V2JobReceipt{}, err
	}
	receiptBytes, err := canonicaljson.Encode(receipt)
	if err != nil {
		return runnerstore.V2JobReceipt{}, err
	}
	receiptBytes = append(receiptBytes, '\n')
	receipt.ExactBytes = receiptBytes
	if _, err := tx.Exec(ctx, jobReceiptInsertSQL, receiptID, "submit_job", "accepted", spec.WorkspaceID,
		spec.JobID, input.IdempotencyKey, fingerprint, jobSpecHash, receiptBytes, nil, committedAt); err != nil {
		return runnerstore.V2JobReceipt{}, mapWriteFailure("insert v2 runner job receipt", err)
	}
	if err := repository.commit(ctx, tx); err != nil {
		recovered, raw, readErr := readV2JobReceipt(repository.pool.QueryRow(ctx, v2JobReceiptByKeySQL, input.IdempotencyKey))
		if readErr == nil && subtle.ConstantTimeCompare(raw, fingerprint) == 1 {
			if validateErr := runnerstore.ValidateV2JobReceiptForSubmit(recovered, input); validateErr == nil {
				return recovered, nil
			}
		}
		return runnerstore.V2JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "v2 job commit outcome is unknown", err)
	}
	return receipt, nil
}

type rowScanner interface{ Scan(...any) error }

func readV2JobReceipt(row rowScanner) (runnerstore.V2JobReceipt, []byte, error) {
	var fingerprint, exact []byte
	var workspaceID, jobID, idempotencyKey, jobSpecHash, workflowRunID, status string
	var reconciliationID *string
	if err := row.Scan(&fingerprint, &exact, &workspaceID, &jobID, &idempotencyKey,
		&jobSpecHash, &workflowRunID, &status, &reconciliationID); err != nil {
		return runnerstore.V2JobReceipt{}, nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(exact))
	decoder.DisallowUnknownFields()
	var value runnerstore.V2JobReceipt
	if err := decoder.Decode(&value); err != nil {
		return runnerstore.V2JobReceipt{}, nil, databaseFailure("decode v2 job receipt", err)
	}
	canonical, err := canonicaljson.Encode(value)
	canonical = append(canonical, '\n')
	if err != nil || !bytes.Equal(canonical, exact) {
		return runnerstore.V2JobReceipt{}, nil, runnerstore.Failure(runnerstore.ErrorHashMismatch, "stored v2 job receipt is invalid", err)
	}
	if validateErr := runnerstore.ValidateV2JobReceipt(value); validateErr != nil ||
		value.WorkspaceID != workspaceID || value.JobID != jobID || value.WorkflowRunID != workflowRunID ||
		value.IdempotencyKey != idempotencyKey || value.JobSpecHash != jobSpecHash || string(value.Status) != status ||
		!equalOptionalString(value.ReconciliationID, reconciliationID) {
		return runnerstore.V2JobReceipt{}, nil, runnerstore.Failure(runnerstore.ErrorHashMismatch, "stored v2 job receipt does not match durable bindings", validateErr)
	}
	value.ExactBytes = append([]byte(nil), exact...)
	value.Replay = true
	return value, fingerprint, nil
}

func equalOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
