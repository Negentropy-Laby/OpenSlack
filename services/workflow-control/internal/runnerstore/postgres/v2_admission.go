package postgres

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

const v2RuntimeAdmissionByKeySQL = `SELECT workspace_id,request_fingerprint,exact_request_bytes,exact_receipt_bytes,
attempt_id,job_id,workflow_run_id,lease_id,fencing_token,encode(job_spec_hash,'hex'),admission_disposition,idempotency_key
FROM workflow_runner_v2_runtime_admissions WHERE idempotency_key=$1`

func (repository *Repository) SealV2RuntimeAdmission(ctx context.Context, input runnerstore.V2RuntimeAdmissionInput) (runnerstore.V2RuntimeAdmissionReceipt, error) {
	if !repository.v2RuntimeDelivery || repository.schemaVersion < 8 {
		return runnerstore.V2RuntimeAdmissionReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "schema-8 runtime delivery is disabled", nil)
	}
	trusted, err := runnerstore.PrepareV2RuntimeAdmission(input.Prepared.Value)
	if err != nil || !bytes.Equal(trusted.ExactBytes, input.Prepared.ExactBytes) ||
		trusted.IdempotencyKey != input.IdempotencyKey || trusted.RequestFingerprint != input.RequestFingerprint ||
		input.WorkspaceID != trusted.Value.WorkspaceID {
		return runnerstore.V2RuntimeAdmissionReceipt{}, runnerstore.Failure(runnerstore.ErrorHashMismatch, "v2 runtime admission body and headers differ", err)
	}
	fingerprint, err := decodeFingerprint(input.RequestFingerprint)
	if err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, databaseFailure("begin v2 runtime admission", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, input.IdempotencyKey, trusted.Value.WorkspaceID, trusted.Value.JobID); err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, err
	}
	if receipt, found, err := readV2RuntimeAdmissionReceipt(tx.QueryRow(ctx, v2RuntimeAdmissionByKeySQL, input.IdempotencyKey), trusted.Value.WorkspaceID, fingerprint, trusted.ExactBytes); err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, err
	} else if found {
		receipt.Replay = true
		return receipt, nil
	}
	value := trusted.Value
	var workflowRunID, attemptState, leaseState string
	var fence, workerSequence int64
	var jobSpecHash []byte
	err = tx.QueryRow(ctx, `SELECT job.workflow_run_id,job.job_spec_hash,attempt.state,attempt.fencing_token,
attempt.worker_sequence,lease.state
FROM workflow_runner_jobs job
JOIN workflow_runner_attempts attempt ON attempt.attempt_id=job.current_attempt_id
JOIN workflow_runner_leases lease ON lease.lease_id=$5 AND lease.attempt_id=attempt.attempt_id
JOIN workflow_runner_v2_attempt_bindings binding ON binding.attempt_id=attempt.attempt_id
WHERE job.workspace_id=$1 AND job.job_id=$2 AND attempt.attempt_id=$3
  AND lease.fencing_token=$4 AND binding.admission_disposition IS NULL
FOR UPDATE OF job,attempt,lease,binding`, value.WorkspaceID, value.JobID, value.AttemptID, value.FencingToken, value.LeaseID).Scan(
		&workflowRunID, &jobSpecHash, &attemptState, &fence, &workerSequence, &leaseState,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return runnerstore.V2RuntimeAdmissionReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 runtime admission has no unsealed offered lease", err)
	}
	if err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, databaseFailure("read v2 runtime admission lease", err)
	}
	if workflowRunID != value.WorkflowRunID || hex.EncodeToString(jobSpecHash) != value.JobSpecHash ||
		attemptState != "offered" || leaseState != "offered" || workerSequence != 0 || fence != value.FencingToken {
		return runnerstore.V2RuntimeAdmissionReceipt{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 runtime admission differs from the exact offered lease", nil)
	}
	committedAt, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, err
	}
	receipt := runnerstore.V2RuntimeAdmissionReceipt{
		Schema: runnerstore.V2RuntimeAdmissionReceiptSchema, Status: "accepted",
		WorkspaceID: value.WorkspaceID, JobID: value.JobID, WorkflowRunID: value.WorkflowRunID,
		AttemptID: value.AttemptID, LeaseID: value.LeaseID, FencingToken: value.FencingToken,
		JobSpecHash: value.JobSpecHash, Disposition: value.Disposition,
		IdempotencyKey: trusted.IdempotencyKey, RequestFingerprint: trusted.RequestFingerprint,
		CommittedAt: runnerstore.CanonicalTimestamp(committedAt),
	}
	receiptBytes, err := runnerstore.PrepareV2RuntimeAdmissionReceipt(receipt)
	if err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, err
	}
	receipt.ExactBytes = receiptBytes
	if _, err := tx.Exec(ctx, `INSERT INTO workflow_runner_v2_runtime_admissions
(attempt_id,workspace_id,job_id,workflow_run_id,lease_id,fencing_token,job_spec_hash,
 admission_disposition,idempotency_key,request_fingerprint,exact_request_bytes,exact_receipt_bytes,admitted_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, value.AttemptID, value.WorkspaceID,
		value.JobID, value.WorkflowRunID, value.LeaseID, value.FencingToken, jobSpecHash,
		value.Disposition, trusted.IdempotencyKey, fingerprint, trusted.ExactBytes, receiptBytes, committedAt); err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, mapWriteFailure("insert v2 runtime admission", err)
	}
	tag, err := tx.Exec(ctx, `UPDATE workflow_runner_v2_attempt_bindings
SET admission_disposition=$2,admission_job_spec_hash=$3
WHERE attempt_id=$1 AND admission_disposition IS NULL AND admission_job_spec_hash IS NULL`,
		value.AttemptID, value.Disposition, jobSpecHash)
	if err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, mapWriteFailure("seal v2 attempt admission", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.V2RuntimeAdmissionReceipt{}, runnerstore.Failure(runnerstore.ErrorConflict, "v2 attempt admission seal CAS lost", nil)
	}
	if err := repository.commit(ctx, tx); err != nil {
		if recovered, found, readErr := readV2RuntimeAdmissionReceipt(repository.pool.QueryRow(ctx, v2RuntimeAdmissionByKeySQL, input.IdempotencyKey), trusted.Value.WorkspaceID, fingerprint, trusted.ExactBytes); readErr == nil && found {
			recovered.Replay = true
			return recovered, nil
		}
		return runnerstore.V2RuntimeAdmissionReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "v2 runtime admission commit outcome is unknown", err)
	}
	return receipt, nil
}

func readV2RuntimeAdmissionReceipt(row rowScanner, workspaceID string, fingerprint, exactRequest []byte) (runnerstore.V2RuntimeAdmissionReceipt, bool, error) {
	var storedWorkspace, attemptID, jobID, workflowRunID, leaseID, jobSpecHash, disposition, idempotencyKey string
	var fencingToken int64
	var storedFingerprint, storedRequest, exactReceipt []byte
	if err := row.Scan(&storedWorkspace, &storedFingerprint, &storedRequest, &exactReceipt,
		&attemptID, &jobID, &workflowRunID, &leaseID, &fencingToken, &jobSpecHash, &disposition, &idempotencyKey); errors.Is(err, pgx.ErrNoRows) {
		return runnerstore.V2RuntimeAdmissionReceipt{}, false, nil
	} else if err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, false, databaseFailure("read v2 runtime admission receipt", err)
	}
	if storedWorkspace != workspaceID || subtle.ConstantTimeCompare(storedFingerprint, fingerprint) != 1 || !bytes.Equal(storedRequest, exactRequest) {
		return runnerstore.V2RuntimeAdmissionReceipt{}, false, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "v2 runtime admission key is bound to different exact evidence", nil)
	}
	prepared, err := runnerstore.ParseV2RuntimeAdmission(storedRequest)
	if err != nil || prepared.IdempotencyKey != idempotencyKey || prepared.RequestFingerprint != "sha256:"+hex.EncodeToString(storedFingerprint) ||
		prepared.Value.WorkspaceID != storedWorkspace || prepared.Value.AttemptID != attemptID || prepared.Value.JobID != jobID ||
		prepared.Value.WorkflowRunID != workflowRunID || prepared.Value.LeaseID != leaseID || prepared.Value.FencingToken != fencingToken ||
		prepared.Value.JobSpecHash != jobSpecHash || prepared.Value.Disposition != disposition {
		return runnerstore.V2RuntimeAdmissionReceipt{}, false, runnerstore.Failure(runnerstore.ErrorHashMismatch, "stored v2 runtime admission request and columns are cross-spliced", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(exactReceipt))
	decoder.DisallowUnknownFields()
	var receipt runnerstore.V2RuntimeAdmissionReceipt
	if err := decoder.Decode(&receipt); err != nil {
		return runnerstore.V2RuntimeAdmissionReceipt{}, false, databaseFailure("decode v2 runtime admission receipt", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return runnerstore.V2RuntimeAdmissionReceipt{}, false, runnerstore.Failure(runnerstore.ErrorHashMismatch, "stored v2 runtime admission receipt has trailing content", err)
	}
	canonical, err := runnerstore.PrepareV2RuntimeAdmissionReceipt(receipt)
	if err != nil || !bytes.Equal(canonical, exactReceipt) {
		return runnerstore.V2RuntimeAdmissionReceipt{}, false, runnerstore.Failure(runnerstore.ErrorHashMismatch, "stored v2 runtime admission receipt is not exact", err)
	}
	value := prepared.Value
	if receipt.WorkspaceID != value.WorkspaceID || receipt.JobID != value.JobID || receipt.WorkflowRunID != value.WorkflowRunID ||
		receipt.AttemptID != value.AttemptID || receipt.LeaseID != value.LeaseID || receipt.FencingToken != value.FencingToken ||
		receipt.JobSpecHash != value.JobSpecHash || receipt.Disposition != value.Disposition ||
		receipt.IdempotencyKey != prepared.IdempotencyKey || receipt.RequestFingerprint != prepared.RequestFingerprint {
		return runnerstore.V2RuntimeAdmissionReceipt{}, false, runnerstore.Failure(runnerstore.ErrorHashMismatch, "stored v2 runtime admission receipt and request are cross-spliced", nil)
	}
	receipt.ExactBytes = append([]byte(nil), exactReceipt...)
	return receipt, true, nil
}
