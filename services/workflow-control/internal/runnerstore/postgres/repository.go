package postgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	budgetpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

const (
	idempotencyLockSalt     int64 = 849440630271101
	jobLockSalt             int64 = 849440630271102
	commitRecoveryTimeout         = 5 * time.Second
	maxSubmissionPastSkew         = 5 * time.Minute
	maxSubmissionFutureSkew       = time.Second
)

type Repository struct {
	pool              *pgxpool.Pool
	commitTransaction func(context.Context, pgx.Tx) error
	staleFenceRejects atomic.Int64
	v2Authorities     runnerstore.V2AuthorityPorts
	v2BudgetResults   interface {
		ReadMutationResult(context.Context, string, string) (budgetstore.MutationResult, error)
	}
	schemaVersion     int64
	v2RuntimeDelivery bool
}

func New(pool *pgxpool.Pool) *Repository {
	return NewForSchema(pool, databaseready.CurrentSchemaVersion)
}

func NewForSchema(pool *pgxpool.Pool, schemaVersion int64) *Repository {
	return &Repository{pool: pool, schemaVersion: schemaVersion}
}

func NewWithV2Authorities(pool *pgxpool.Pool, authorities runnerstore.V2AuthorityPorts) *Repository {
	return &Repository{pool: pool, v2Authorities: authorities, schemaVersion: databaseready.CurrentSchemaVersion}
}

// NewForV2RuntimeDelivery is the only composition path that admits the
// qualification-only Go route and schema-8 authority-binding sideband.
func NewForV2RuntimeDelivery(pool *pgxpool.Pool, authorities runnerstore.V2AuthorityPorts) *Repository {
	return &Repository{
		pool: pool, v2Authorities: authorities,
		v2BudgetResults: budgetpostgres.New(pool),
		schemaVersion:   databaseready.CurrentSchemaVersion, v2RuntimeDelivery: true,
	}
}

func NewWithCommitter(pool *pgxpool.Pool, commit func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commitTransaction: commit, schemaVersion: databaseready.CurrentSchemaVersion}
}

func (repository *Repository) Submit(ctx context.Context, input runnerstore.SubmitInput) (runnerstore.JobReceipt, error) {
	if err := runnerstore.ValidateSubmitInput(input); err != nil {
		return runnerstore.JobReceipt{}, err
	}
	fingerprint, err := decodeFingerprint(input.RequestFingerprint)
	if err != nil {
		return runnerstore.JobReceipt{}, err
	}
	spec := input.Prepared.Spec
	submittedAt, _ := runnerstore.ParseTimestamp(spec.SubmittedAt)
	deadline := submittedAt.Add(time.Duration(spec.WholeTimeoutMS) * time.Millisecond)

	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.JobReceipt{}, databaseFailure("begin job submission", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, input.IdempotencyKey, spec.WorkspaceID, spec.JobID); err != nil {
		return runnerstore.JobReceipt{}, err
	}
	if receipt, raw, readErr := readJobReceipt(tx.QueryRow(ctx, jobReceiptByKeySQL, input.IdempotencyKey)); readErr == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) != 1 {
			return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "idempotency key is bound to another job request", nil)
		}
		return receipt, nil
	} else if !errors.Is(readErr, pgx.ErrNoRows) {
		return runnerstore.JobReceipt{}, databaseFailure("read job receipt", readErr)
	}
	admittedAt, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.JobReceipt{}, err
	}
	if submittedAt.After(admittedAt.Add(maxSubmissionFutureSkew)) {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "job submittedAt is ahead of the database clock", nil)
	}
	if submittedAt.Before(admittedAt.Add(-maxSubmissionPastSkew)) {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "job submittedAt is outside the admission window", nil)
	}
	if !deadline.After(admittedAt) {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorTimeout, "job deadline elapsed before admission", nil)
	}
	if deadline.After(admittedAt.Add(runnerstore.MaxWholeTimeout)) {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "job deadline exceeds the database-clock timeout bound", nil)
	}

	descriptorHash, _ := hex.DecodeString(spec.ExecutionDescriptorHash)
	jobSpecHash, _ := hex.DecodeString(input.Prepared.JobSpecHash)
	sourceHash, _ := hex.DecodeString(spec.WorkflowSourceHash)
	manifestHash, _ := hex.DecodeString(spec.ManifestHash)
	inputHash, _ := hex.DecodeString(spec.InputHash)
	if _, err := tx.Exec(ctx, jobInsertSQL,
		spec.WorkspaceID, spec.JobID, spec.WorkflowRunID, spec.CorrelationID,
		spec.ExecutionDescriptorRef, descriptorHash, jobSpecHash, input.Prepared.ExactBody,
		spec.WorkflowID, spec.WorkflowVersion, sourceHash, manifestHash, inputHash,
		deadline, admittedAt,
	); err != nil {
		return runnerstore.JobReceipt{}, mapWriteFailure("insert runner job", err)
	}

	committedAt, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.JobReceipt{}, err
	}
	receiptID, err := randomToken("runner-job-receipt")
	if err != nil {
		return runnerstore.JobReceipt{}, databaseFailure("generate job receipt identity", err)
	}
	receipt := runnerstore.JobReceipt{
		Schema: runnerstore.JobReceiptSchema, Status: runnerstore.ReceiptAccepted,
		WorkspaceID: spec.WorkspaceID, JobID: spec.JobID, WorkflowRunID: spec.WorkflowRunID,
		State: runnerstore.JobQueued, Revision: 1, JobSpecHash: input.Prepared.JobSpecHash,
		IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint,
		CommittedAt: runnerstore.CanonicalTimestamp(committedAt), ReconciliationID: nil,
	}
	receiptBytes, err := canonicalReceiptBytes(receipt)
	if err != nil {
		return runnerstore.JobReceipt{}, err
	}
	receipt.ExactBytes = receiptBytes
	if _, err := tx.Exec(ctx, jobReceiptInsertSQL,
		receiptID, "submit_job", "accepted", spec.WorkspaceID, spec.JobID,
		input.IdempotencyKey, fingerprint, jobSpecHash, receiptBytes, nil, committedAt,
	); err != nil {
		return runnerstore.JobReceipt{}, mapWriteFailure("insert runner job receipt", err)
	}
	if err := repository.commit(ctx, tx); err != nil {
		return repository.resolveSubmitCommit(input, fingerprint, err)
	}
	return receipt, nil
}

func (repository *Repository) ReadJob(ctx context.Context, workspaceID, jobID string) (runnerstore.JobView, error) {
	if err := validateID(workspaceID, "workspaceId"); err != nil {
		return runnerstore.JobView{}, err
	}
	if err := validateID(jobID, "jobId"); err != nil {
		return runnerstore.JobView{}, err
	}
	return readJobView(repository.pool.QueryRow(ctx, jobViewSQL, workspaceID, jobID))
}

func (repository *Repository) Statistics(ctx context.Context) (runnerstore.Statistics, error) {
	var result runnerstore.Statistics
	if err := repository.pool.QueryRow(ctx, statisticsSQL).Scan(
		&result.QueuedJobs, &result.ActiveLeases, &result.ExpiredLeases,
		&result.Takeovers, &result.StaleFenceRejects, &result.ProcessCrashes,
		&result.ForcedTerminations, &result.ReconciliationPending,
	); err != nil {
		return runnerstore.Statistics{}, databaseFailure("read runner statistics", err)
	}
	result.StaleFenceRejects = repository.staleFenceRejects.Load()
	return result, nil
}

func (repository *Repository) staleFence(message string, cause error) error {
	repository.staleFenceRejects.Add(1)
	return runnerstore.Failure(runnerstore.ErrorStaleFence, message, cause)
}

func (repository *Repository) commit(ctx context.Context, tx pgx.Tx) error {
	if repository.commitTransaction != nil {
		return repository.commitTransaction(ctx, tx)
	}
	return tx.Commit(ctx)
}

func (repository *Repository) resolveSubmitCommit(input runnerstore.SubmitInput, fingerprint []byte, commitErr error) (runnerstore.JobReceipt, error) {
	ctx, cancel := context.WithTimeout(context.Background(), commitRecoveryTimeout)
	defer cancel()
	receipt, raw, err := readJobReceipt(repository.pool.QueryRow(ctx, jobReceiptByKeySQL, input.IdempotencyKey))
	if err == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) != 1 {
			return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "commit recovery found another job fingerprint", commitErr)
		}
		return receipt, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "job commit outcome cannot be read", errors.Join(commitErr, err))
	}
	return repository.persistSubmitReconciliation(ctx, input, fingerprint, commitErr)
}

func (repository *Repository) persistSubmitReconciliation(ctx context.Context, input runnerstore.SubmitInput, fingerprint []byte, commitErr error) (runnerstore.JobReceipt, error) {
	// A PostgreSQL primary has no delayed-visibility commit. Once a fresh
	// transaction proves the exact receipt absent, create a stable
	// reconciliation job instead of retrying the possibly accepted execution.
	spec := input.Prepared.Spec
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "begin job reconciliation", errors.Join(commitErr, err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, input.IdempotencyKey, spec.WorkspaceID, spec.JobID); err != nil {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "lock job reconciliation", errors.Join(commitErr, err))
	}
	if receipt, raw, readErr := readJobReceipt(tx.QueryRow(ctx, jobReceiptByKeySQL, input.IdempotencyKey)); readErr == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) != 1 {
			return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "reconciliation found another fingerprint", commitErr)
		}
		return receipt, nil
	} else if !errors.Is(readErr, pgx.ErrNoRows) {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "read job reconciliation state", errors.Join(commitErr, readErr))
	}

	// If the original job row exists without its receipt, never infer that it
	// is safe to dispatch. Convert it to reconciliation under the job lock.
	reconciliationID, tokenErr := randomToken("runner-reconciliation")
	if tokenErr != nil {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "generate job reconciliation identity", errors.Join(commitErr, tokenErr))
	}
	var jobSpecHash []byte
	var workflowRunID string
	var revision int64
	rowErr := tx.QueryRow(ctx, `
SELECT workflow_run_id, job_spec_hash, revision
FROM workflow_runner_jobs
WHERE workspace_id=$1 AND job_id=$2
FOR UPDATE`, spec.WorkspaceID, spec.JobID).Scan(&workflowRunID, &jobSpecHash, &revision)
	jobMissing := errors.Is(rowErr, pgx.ErrNoRows)
	if rowErr != nil && !jobMissing {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "lock reconciled job", errors.Join(commitErr, rowErr))
	}
	expectedHash, _ := hex.DecodeString(input.Prepared.JobSpecHash)
	if !jobMissing && (subtle.ConstantTimeCompare(jobSpecHash, expectedHash) != 1 || workflowRunID != spec.WorkflowRunID) {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "reconciled job identity differs", commitErr)
	}
	committedAt, timeErr := databaseTime(ctx, tx)
	if timeErr != nil {
		return runnerstore.JobReceipt{}, timeErr
	}
	if jobMissing {
		descriptorHash, _ := hex.DecodeString(spec.ExecutionDescriptorHash)
		sourceHash, _ := hex.DecodeString(spec.WorkflowSourceHash)
		manifestHash, _ := hex.DecodeString(spec.ManifestHash)
		inputHash, _ := hex.DecodeString(spec.InputHash)
		submittedAt, _ := runnerstore.ParseTimestamp(spec.SubmittedAt)
		deadline := submittedAt.Add(time.Duration(spec.WholeTimeoutMS) * time.Millisecond)
		if !deadline.After(committedAt) {
			// The tombstone is never dispatchable. Keep the schema's temporal
			// invariant without extending executable authority.
			deadline = committedAt.Add(time.Millisecond)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO workflow_runner_jobs (
    workspace_id, job_id, workflow_run_id, correlation_id,
    execution_descriptor_ref, execution_descriptor_hash, job_spec_hash, exact_spec_bytes,
    workflow_id, workflow_version, workflow_source_hash, manifest_hash, input_hash,
    whole_deadline, state, revision, current_fence, current_attempt_id,
    terminal_status, terminal_reason, result_hash, reconciliation_id, created_at, updated_at
) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
    'reconciliation_required',1,0,NULL,
    'reconciliation_required','commit_outcome_unknown',NULL,$15,$16,$17
)`,
			spec.WorkspaceID, spec.JobID, spec.WorkflowRunID, spec.CorrelationID,
			spec.ExecutionDescriptorRef, descriptorHash, expectedHash, input.Prepared.ExactBody,
			spec.WorkflowID, spec.WorkflowVersion, sourceHash, manifestHash, inputHash,
			deadline, reconciliationID, committedAt, committedAt,
		); err != nil {
			return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "insert reconciled job tombstone", errors.Join(commitErr, err))
		}
		revision = 1
	}
	evidenceHash := sha256.Sum256(append([]byte("openslack.workflow-runner.submit-reconciliation.v1\x00"), input.Prepared.ExactBody...))
	if _, err := tx.Exec(ctx, `
INSERT INTO workflow_runner_reconciliations (
    reconciliation_id, workspace_id, job_id, attempt_id, code, evidence_hash, created_at
) VALUES ($1,$2,$3,NULL,'WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN',$4,$5)`,
		reconciliationID, spec.WorkspaceID, spec.JobID, evidenceHash[:], committedAt,
	); err != nil {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "insert job reconciliation", errors.Join(commitErr, err))
	}
	if !jobMissing {
		if _, err := tx.Exec(ctx, `
UPDATE workflow_runner_jobs
SET state='reconciliation_required', revision=revision+1,
    terminal_status='reconciliation_required', terminal_reason='commit_outcome_unknown',
    reconciliation_id=$1, updated_at=$2
WHERE workspace_id=$3 AND job_id=$4`, reconciliationID, committedAt, spec.WorkspaceID, spec.JobID); err != nil {
			return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "mark reconciled job", errors.Join(commitErr, err))
		}
		revision++
	}
	receipt := runnerstore.JobReceipt{
		Schema: runnerstore.JobReceiptSchema, Status: runnerstore.ReceiptReconciliationRequired,
		WorkspaceID: spec.WorkspaceID, JobID: spec.JobID, WorkflowRunID: spec.WorkflowRunID,
		State: runnerstore.JobReconciliationRequired, Revision: revision,
		JobSpecHash: input.Prepared.JobSpecHash, IdempotencyKey: input.IdempotencyKey,
		RequestFingerprint: input.RequestFingerprint, CommittedAt: runnerstore.CanonicalTimestamp(committedAt),
		ReconciliationID: &reconciliationID,
	}
	receiptBytes, encodeErr := canonicalReceiptBytes(receipt)
	if encodeErr != nil {
		return runnerstore.JobReceipt{}, encodeErr
	}
	receipt.ExactBytes = receiptBytes
	receiptID, idErr := randomToken("runner-job-receipt")
	if idErr != nil {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "generate reconciliation receipt", errors.Join(commitErr, idErr))
	}
	if _, err := tx.Exec(ctx, jobReceiptInsertSQL,
		receiptID, "submit_job", "reconciliation_required", spec.WorkspaceID, spec.JobID,
		input.IdempotencyKey, fingerprint, expectedHash, receiptBytes, reconciliationID, committedAt,
	); err != nil {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "insert reconciliation receipt", errors.Join(commitErr, err))
	}
	if err := tx.Commit(ctx); err != nil {
		return runnerstore.JobReceipt{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "commit reconciliation receipt", errors.Join(commitErr, err))
	}
	return receipt, nil
}

func canonicalReceiptBytes(receipt runnerstore.JobReceipt) ([]byte, error) {
	value := map[string]any{
		"schema": receipt.Schema, "status": receipt.Status,
		"workspaceId": receipt.WorkspaceID, "jobId": receipt.JobID,
		"workflowRunId": receipt.WorkflowRunID, "state": receipt.State,
		"revision": receipt.Revision, "jobSpecHash": receipt.JobSpecHash,
		"idempotencyKey":     receipt.IdempotencyKey,
		"requestFingerprint": receipt.RequestFingerprint,
		"committedAt":        receipt.CommittedAt, "reconciliationId": receipt.ReconciliationID,
	}
	encoded, err := canonicaljson.Encode(value)
	if err != nil {
		return nil, runnerstore.Failure(runnerstore.ErrorInputInvalid, "encode job receipt", err)
	}
	return append(encoded, '\n'), nil
}

func readJobReceipt(row pgx.Row) (runnerstore.JobReceipt, []byte, error) {
	var fingerprint, exact []byte
	if err := row.Scan(&fingerprint, &exact); err != nil {
		return runnerstore.JobReceipt{}, nil, err
	}
	var receipt runnerstore.JobReceipt
	if err := json.Unmarshal(exact, &receipt); err != nil {
		return runnerstore.JobReceipt{}, nil, runnerstore.Failure(runnerstore.ErrorDatabase, "stored job receipt is invalid", err)
	}
	receipt.ExactBytes = append([]byte(nil), exact...)
	return receipt, append([]byte(nil), fingerprint...), nil
}

func readJobView(row pgx.Row) (runnerstore.JobView, error) {
	var result runnerstore.JobView
	result.Schema = runnerstore.JobViewSchema
	var attemptID, leaseID, attemptState pgtype.Text
	var leaseExpires pgtype.Timestamptz
	var terminalStatus, terminalReason, reconciliationID, reconciliationCode pgtype.Text
	var resultHash []byte
	var createdAt, updatedAt time.Time
	if err := row.Scan(
		&result.WorkspaceID, &result.JobID, &result.WorkflowRunID, &result.CorrelationID,
		&result.State, &result.Revision, &result.FencingToken, &attemptID,
		&leaseID, &attemptState, &leaseExpires,
		&terminalStatus, &terminalReason, &resultHash,
		&result.OpenEffectCount, &reconciliationID, &reconciliationCode,
		&result.ExecutionStarted, &createdAt, &updatedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorNotFound, "runner job was not found", err)
	} else if err != nil {
		return runnerstore.JobView{}, databaseFailure("read runner job", err)
	}
	if attemptID.Valid {
		value := attemptID.String
		result.AttemptID = &value
	}
	if leaseID.Valid {
		value := leaseID.String
		result.LeaseID = &value
	}
	if attemptState.Valid {
		value := runnerstore.AttemptState(attemptState.String)
		result.AttemptState = &value
	}
	if leaseExpires.Valid {
		value := runnerstore.CanonicalTimestamp(leaseExpires.Time)
		result.LeaseExpiresAt = &value
	}
	if terminalStatus.Valid {
		value := runnerprotocol.TerminalStatus(terminalStatus.String)
		result.TerminalStatus = &value
	}
	if terminalReason.Valid {
		value := terminalReason.String
		result.TerminalReason = &value
	}
	if len(resultHash) > 0 {
		value := hex.EncodeToString(resultHash)
		result.ResultHash = &value
	}
	if reconciliationID.Valid {
		value := reconciliationID.String
		result.ReconciliationID = &value
	}
	if reconciliationCode.Valid {
		value := reconciliationCode.String
		result.ReconciliationCode = &value
	}
	result.CreatedAt = runnerstore.CanonicalTimestamp(createdAt)
	result.UpdatedAt = runnerstore.CanonicalTimestamp(updatedAt)
	return result, nil
}

func lockScopes(ctx context.Context, tx pgx.Tx, key, workspaceID, jobID string) error {
	for _, lock := range []struct {
		value string
		salt  int64
		label string
	}{
		// PostgreSQL text cannot carry NUL bytes. Hex preserves the exact
		// domain-separated byte identity without delimiter collisions.
		{hex.EncodeToString([]byte(key)), idempotencyLockSalt, "idempotency key"},
		{hex.EncodeToString([]byte(workspaceID + "\x00" + jobID)), jobLockSalt, "runner job"},
	} {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, lock.value, lock.salt); err != nil {
			return databaseFailure("lock "+lock.label, err)
		}
	}
	return nil
}

func databaseTime(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	var value time.Time
	if err := tx.QueryRow(ctx, `SELECT date_trunc('milliseconds', clock_timestamp())`).Scan(&value); err != nil {
		return time.Time{}, databaseFailure("read database time", err)
	}
	return value.UTC(), nil
}

func randomToken(prefix string) (string, error) {
	value := make([]byte, 18)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return prefix + "." + base64.RawURLEncoding.EncodeToString(value), nil
}

func decodeFingerprint(value string) ([]byte, error) {
	if len(value) != 71 || value[:7] != "sha256:" {
		return nil, runnerstore.Failure(runnerstore.ErrorInputInvalid, "request fingerprint is invalid", nil)
	}
	decoded, err := hex.DecodeString(value[7:])
	if err != nil || len(decoded) != sha256.Size {
		return nil, runnerstore.Failure(runnerstore.ErrorInputInvalid, "request fingerprint is invalid", err)
	}
	return decoded, nil
}

func validateID(value, label string) error {
	if value == "" || len(value) > runnerprotocol.MaxIdentifierBytes {
		return runnerstore.Failure(runnerstore.ErrorInputInvalid, label+" is invalid", nil)
	}
	for index, char := range []byte(value) {
		allowed := char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' ||
			(index > 0 && (char == '.' || char == '_' || char == ':' || char == '@' || char == '-'))
		if !allowed {
			return runnerstore.Failure(runnerstore.ErrorInputInvalid, label+" is invalid", nil)
		}
	}
	return nil
}

func databaseFailure(operation string, err error) error {
	return runnerstore.Failure(runnerstore.ErrorDatabase, operation, err)
}

func mapWriteFailure(operation string, err error) error {
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) {
		switch databaseError.Code {
		case "23505", "23503", "23514", "23P01":
			return runnerstore.Failure(runnerstore.ErrorConflict, operation+" conflicted", err)
		}
	}
	return databaseFailure(operation, err)
}

var _ runnerstore.Store = (*Repository)(nil)
