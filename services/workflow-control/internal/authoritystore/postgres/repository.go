package postgres

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

const (
	idempotencyLockSalt   int64 = 628239560154201
	runLockSalt           int64 = 628239560154202
	reconciliationTimeout       = 5 * time.Second
)

type Repository struct {
	pool                 *pgxpool.Pool
	commitTransaction    func(context.Context, pgx.Tx) error
	commitReconciliation func(context.Context, pgx.Tx) error
}

func New(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

// NewWithCommitter injects the commit boundary so qualification can prove
// response-loss recovery and ambiguous uncommitted reconciliation.
func NewWithCommitter(pool *pgxpool.Pool, commit func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commitTransaction: commit}
}

// NewWithCommitters additionally injects the reconciliation commit boundary.
// It is limited to qualification of the second unknown-outcome failure.
func NewWithCommitters(
	pool *pgxpool.Pool,
	mutationCommit func(context.Context, pgx.Tx) error,
	reconciliationCommit func(context.Context, pgx.Tx) error,
) *Repository {
	return &Repository{pool: pool, commitTransaction: mutationCommit, commitReconciliation: reconciliationCommit}
}

type head struct {
	exists             bool
	workflowID         string
	workflowVersion    string
	workflowSourceHash []byte
	manifestHash       []byte
	inputHash          []byte
	route              authoritystore.Route
	state              authoritystore.RunState
	revision           int64
	phaseID            *string
	phaseIndex         *int64
	resumeGeneration   int64
	recordHash         []byte
	recordBytes        []byte
	updatedAt          time.Time
}

func (repository *Repository) Mutate(ctx context.Context, input authoritystore.MutateInput) (authoritystore.Receipt, error) {
	if err := validateInputShape(input); err != nil {
		return authoritystore.Receipt{}, err
	}
	fingerprint, _ := authoritystore.ParseFingerprint(input.RequestFingerprint)

	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return authoritystore.Receipt{}, databaseFailure("begin workflow authority mutation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	request := input.Prepared.Envelope
	if err := lockScope(ctx, tx, input.IdempotencyKey, request.WorkspaceID, request.RunID); err != nil {
		return authoritystore.Receipt{}, err
	}

	existing, rawFingerprint, err := readReceipt(tx.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	switch {
	case err == nil:
		if subtle.ConstantTimeCompare(rawFingerprint, fingerprint[:]) != 1 {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorIdempotencyConflict, "idempotency key is bound to another request fingerprint", nil)
		}
		existing.Replay = true
		return existing, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return authoritystore.Receipt{}, databaseFailure("read workflow authority receipt", err)
	}
	if err := validateExactBindings(input); err != nil {
		return authoritystore.Receipt{}, err
	}

	var reconciliationOpen bool
	if err := tx.QueryRow(ctx, openReconciliationSQL, request.WorkspaceID, request.RunID).Scan(&reconciliationOpen); err != nil {
		return authoritystore.Receipt{}, databaseFailure("read workflow authority reconciliation gate", err)
	}
	if reconciliationOpen {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "workflow run has an open reconciliation", nil)
	}

	current, err := readHead(ctx, tx, request.WorkspaceID, request.RunID)
	if err != nil {
		return authoritystore.Receipt{}, err
	}
	if request.Operation == authoritystore.OperationAccept {
		if current.exists {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "workflow run already exists", nil)
		}
		if err := ensureEpoch(ctx, tx, request.WorkspaceID, request.Route); err != nil {
			return authoritystore.Receipt{}, err
		}
	} else {
		if !current.exists {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorNotFound, "workflow run was not found", nil)
		}
		if err := validateCASBinding(request, current); err != nil {
			return authoritystore.Receipt{}, err
		}
	}

	recordHash, _ := hex.DecodeString(input.Prepared.RecordHash)
	requestHash, _ := hex.DecodeString(input.Prepared.RequestHash)
	buildHash, _ := hex.DecodeString(input.ServiceBuildHash)
	receiptID, err := randomToken("wca-receipt")
	if err != nil {
		return authoritystore.Receipt{}, databaseFailure("generate workflow authority receipt identity", err)
	}
	eventID, err := randomToken("wca-event")
	if err != nil {
		return authoritystore.Receipt{}, databaseFailure("generate workflow authority event identity", err)
	}
	outboxID, err := randomToken("wca-outbox")
	if err != nil {
		return authoritystore.Receipt{}, databaseFailure("generate workflow authority outbox identity", err)
	}
	var committedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT date_trunc('milliseconds', clock_timestamp())`).Scan(&committedAt); err != nil {
		return authoritystore.Receipt{}, databaseFailure("read workflow authority commit timestamp", err)
	}
	committedText := canonicalTimestamp(committedAt)
	acceptedRevision := request.Record.Revision
	recordHashText := input.Prepared.RecordHash
	receiptValue := authoritycontract.Receipt{
		Schema: authoritycontract.ReceiptSchema, Operation: authoritycontract.ReceiptRunTransition,
		Status: authoritycontract.ReceiptAccepted, WorkspaceID: request.WorkspaceID, RunID: request.RunID,
		ExpectedRevision: request.Expected.Revision, AcceptedRevision: &acceptedRevision,
		ResumeGeneration: request.Record.ResumeGeneration, Route: request.Route,
		IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint,
		RequestHash: input.Prepared.RequestHash, RecordHash: &recordHashText,
		CorrelationID: request.CorrelationID, ServiceBuildHash: input.ServiceBuildHash,
		CommittedAt: &committedText,
	}
	receiptBytes, err := exactReceiptBytes(receiptValue)
	if err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorContentInvalid, "encode accepted workflow authority receipt", err)
	}
	outboxBytes, outboxHash, outboxKey, err := prepareOutbox(eventID, receiptID, input.Prepared)
	if err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorContentInvalid, "encode workflow authority outbox", err)
	}
	outboxHashBytes, _ := hex.DecodeString(outboxHash)

	if _, err := tx.Exec(ctx, eventInsertSQL,
		eventID, receiptID, request.WorkspaceID, request.RunID,
		request.Expected.Revision, request.Record.Revision, nullableState(request.Expected.State),
		string(request.Record.State), nullableString(request.Expected.CurrentPhaseID), nullableInt64(request.Expected.CurrentPhaseIndex),
		nullableString(request.Record.CurrentPhaseID), nullableInt64(request.Record.CurrentPhaseIndex),
		request.Expected.ResumeGeneration, request.Record.ResumeGeneration, request.Route.Backend,
		request.Route.Authority, request.Route.RoutingEpoch, buildHash, requestHash, recordHash,
		request.CorrelationID, input.Prepared.RecordBytes,
	); err != nil {
		return authoritystore.Receipt{}, mapWriteFailure("insert workflow authority transition event", err)
	}
	if request.Operation == authoritystore.OperationAccept {
		if _, err := tx.Exec(ctx, runInsertSQL,
			request.WorkspaceID, request.RunID, request.Record.WorkflowID, request.Record.WorkflowVersion,
			mustDecodeHash(request.Record.WorkflowSourceHash), mustDecodeHash(request.Record.ManifestHash), mustDecodeHash(request.Record.InputHash),
			request.Route.Backend, request.Route.Authority, request.Route.RoutingEpoch, buildHash,
			string(request.Record.State), request.Record.Revision, nullableString(request.Record.CurrentPhaseID),
			nullableInt64(request.Record.CurrentPhaseIndex), request.Record.ResumeGeneration, recordHash,
			input.Prepared.RecordBytes, committedAt,
		); err != nil {
			return authoritystore.Receipt{}, mapWriteFailure("insert workflow authority run", err)
		}
	} else {
		tag, err := tx.Exec(ctx, runCASUpdateSQL,
			request.WorkspaceID, request.RunID, request.Record.WorkflowID, request.Record.WorkflowVersion,
			mustDecodeHash(request.Record.WorkflowSourceHash), mustDecodeHash(request.Record.ManifestHash), mustDecodeHash(request.Record.InputHash),
			request.Route.Backend, request.Route.Authority, request.Route.RoutingEpoch, buildHash,
			request.Expected.Revision, string(*request.Expected.State), nullableString(request.Expected.CurrentPhaseID),
			nullableInt64(request.Expected.CurrentPhaseIndex), request.Expected.ResumeGeneration,
			string(request.Record.State), request.Record.Revision, nullableString(request.Record.CurrentPhaseID),
			nullableInt64(request.Record.CurrentPhaseIndex), request.Record.ResumeGeneration, recordHash,
			input.Prepared.RecordBytes, committedAt,
		)
		if err != nil {
			return authoritystore.Receipt{}, mapWriteFailure("advance workflow authority run", err)
		}
		if tag.RowsAffected() != 1 {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "workflow run compare-and-swap lost", nil)
		}
	}

	var recordedAt time.Time
	if err := tx.QueryRow(ctx, receiptAcceptedInsertSQL,
		receiptID, input.IdempotencyKey, fingerprint[:], requestHash, request.WorkspaceID,
		request.RunID, request.Expected.Revision, request.Record.Revision, request.Record.ResumeGeneration,
		request.Route.Backend, request.Route.Authority, request.Route.RoutingEpoch, buildHash,
		recordHash, request.CorrelationID, buildHash, committedAt, receiptBytes,
	).Scan(&recordedAt); err != nil {
		return authoritystore.Receipt{}, mapWriteFailure("insert workflow authority receipt", err)
	}
	if _, err := tx.Exec(ctx, outboxInsertSQL,
		outboxID, eventID, request.WorkspaceID, request.RunID, request.Record.Revision,
		authoritystore.OutboxEventType, outboxKey, outboxHashBytes, outboxBytes,
	); err != nil {
		return authoritystore.Receipt{}, mapWriteFailure("insert workflow authority outbox", err)
	}

	result := authoritystore.Receipt{Value: receiptValue, ExactBytes: receiptBytes, ReceiptID: receiptID, RecordedAt: recordedAt}
	commit := repository.commitTransaction
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commit(ctx, tx); err != nil {
		return repository.resolveCommitOutcome(input, fingerprint, err)
	}
	return result, nil
}

func validateInputShape(input authoritystore.MutateInput) error {
	if err := authoritystore.ValidateIdempotencyKey(input.IdempotencyKey); err != nil {
		return err
	}
	if _, err := authoritystore.ParseFingerprint(input.RequestFingerprint); err != nil {
		return err
	}
	if !isHash(input.ServiceBuildHash) || input.ServiceBuildHash != input.Prepared.ExpectedServiceBuild ||
		input.Prepared.Envelope.Route.Backend != authoritystore.Backend || input.Prepared.Envelope.Route.Authority != authoritystore.Authority {
		return authoritystore.Failure(authoritystore.ErrorInputInvalid, "request is not bound to the active Go authority build", nil)
	}
	return nil
}

func validateExactBindings(input authoritystore.MutateInput) error {
	reprepared, err := authoritystore.PrepareRequest(
		input.Prepared.ExactBody, input.Prepared.CallerID, input.Prepared.Envelope.WorkspaceID,
		strconv.FormatInt(input.Prepared.Envelope.Route.RoutingEpoch, 10), input.Prepared.ExpectedServiceBuild,
	)
	if err != nil || !reflect.DeepEqual(reprepared.Envelope, input.Prepared.Envelope) ||
		!bytes.Equal(reprepared.RecordBytes, input.Prepared.RecordBytes) || reprepared.RecordHash != input.Prepared.RecordHash ||
		reprepared.RequestHash != input.Prepared.RequestHash {
		return authoritystore.Failure(authoritystore.ErrorInputInvalid, "prepared workflow authority request binding is invalid", err)
	}
	if input.IdempotencyKey != authoritystore.ExpectedIdempotencyKey(input.Prepared.ExactBody) {
		return authoritystore.Failure(authoritystore.ErrorInputInvalid, "Idempotency-Key does not bind the exact canonical request", nil)
	}
	path := authoritystore.RequestPath(input.Prepared.Envelope.Operation, input.Prepared.Envelope.RunID)
	if path == "" || input.RequestFingerprint != authoritystore.RequestFingerprint("POST", path, input.Prepared) {
		return authoritystore.Failure(authoritystore.ErrorInputInvalid, "request fingerprint does not bind the exact authority request", nil)
	}
	return nil
}

func validateCASBinding(request authoritystore.RequestEnvelope, current head) error {
	if current.route != request.Route || current.revision != request.Expected.Revision || current.state != *request.Expected.State ||
		!equalNullableString(current.phaseID, request.Expected.CurrentPhaseID) ||
		!equalNullableInt64(current.phaseIndex, request.Expected.CurrentPhaseIndex) || current.resumeGeneration != request.Expected.ResumeGeneration {
		return authoritystore.Failure(authoritystore.ErrorConflict, "workflow run revision/state/phase/resume/route compare-and-swap failed", nil)
	}
	record := request.Record
	if current.workflowID != record.WorkflowID || current.workflowVersion != record.WorkflowVersion ||
		subtle.ConstantTimeCompare(current.workflowSourceHash, mustDecodeHash(record.WorkflowSourceHash)) != 1 ||
		subtle.ConstantTimeCompare(current.manifestHash, mustDecodeHash(record.ManifestHash)) != 1 ||
		subtle.ConstantTimeCompare(current.inputHash, mustDecodeHash(record.InputHash)) != 1 {
		return authoritystore.Failure(authoritystore.ErrorConflict, "workflow run immutable binding drifted", nil)
	}
	return nil
}

func ensureEpoch(ctx context.Context, tx pgx.Tx, workspaceID string, route authoritystore.Route) error {
	buildHash := mustDecodeHash(route.AuthorityBuildHash)
	if _, err := tx.Exec(ctx, epochInsertSQL, workspaceID, route.RoutingEpoch, route.Backend, route.Authority, buildHash); err != nil {
		return mapWriteFailure("register workflow authority epoch", err)
	}
	var backend, authority string
	var storedBuild []byte
	if err := tx.QueryRow(ctx, epochReadSQL, workspaceID, route.RoutingEpoch).Scan(&backend, &authority, &storedBuild); err != nil {
		return databaseFailure("read workflow authority epoch", err)
	}
	if backend != route.Backend || authority != route.Authority || subtle.ConstantTimeCompare(storedBuild, buildHash) != 1 {
		return authoritystore.Failure(authoritystore.ErrorConflict, "routing epoch is already bound to another authority build", nil)
	}
	return nil
}

func readHead(ctx context.Context, tx pgx.Tx, workspaceID, runID string) (head, error) {
	var result head
	var phaseID pgtype.Text
	var phaseIndex pgtype.Int8
	var authorityBuildHash []byte
	if err := tx.QueryRow(ctx, headForUpdateSQL, workspaceID, runID).Scan(
		&result.workflowID, &result.workflowVersion, &result.workflowSourceHash, &result.manifestHash, &result.inputHash,
		&result.route.Backend, &result.route.Authority, &result.route.RoutingEpoch, &authorityBuildHash,
		&result.state, &result.revision, &phaseID, &phaseIndex, &result.resumeGeneration,
		&result.recordHash, &result.recordBytes, &result.updatedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	} else if err != nil {
		return head{}, databaseFailure("lock workflow authority run", err)
	}
	result.route.AuthorityBuildHash = hex.EncodeToString(authorityBuildHash)
	if phaseID.Valid {
		value := phaseID.String
		result.phaseID = &value
	}
	if phaseIndex.Valid {
		value := phaseIndex.Int64
		result.phaseIndex = &value
	}
	result.exists = true
	return result, nil
}

func (repository *Repository) Read(ctx context.Context, workspaceID, runID string) (authoritystore.RunHead, error) {
	if err := authoritystore.ValidateReadIdentity(workspaceID, runID); err != nil {
		return authoritystore.RunHead{}, err
	}
	result := authoritystore.RunHead{Schema: authoritystore.ReadSchema, WorkspaceID: workspaceID, RunID: runID}
	var phaseID pgtype.Text
	var phaseIndex pgtype.Int8
	if err := repository.pool.QueryRow(ctx, readSQL, workspaceID, runID).Scan(
		&result.WorkflowID, &result.WorkflowVersion, &result.WorkflowSourceHash, &result.ManifestHash, &result.InputHash,
		&result.Route.Backend, &result.Route.Authority, &result.Route.RoutingEpoch, &result.Route.AuthorityBuildHash,
		&result.State, &result.Revision, &phaseID, &phaseIndex, &result.ResumeGeneration,
		&result.RecordHash, &result.RecordBytes, &result.ServiceBuildHash, &result.UpdatedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return authoritystore.RunHead{}, authoritystore.Failure(authoritystore.ErrorNotFound, "workflow authority run not found", err)
	} else if err != nil {
		return authoritystore.RunHead{}, databaseFailure("read workflow authority run", err)
	}
	if phaseID.Valid {
		value := phaseID.String
		result.CurrentPhaseID = &value
	}
	if phaseIndex.Valid {
		value := phaseIndex.Int64
		result.CurrentPhaseIndex = &value
	}
	digest := sha256.Sum256(result.RecordBytes)
	if result.RecordHash != hex.EncodeToString(digest[:]) || result.ServiceBuildHash != result.Route.AuthorityBuildHash {
		return authoritystore.RunHead{}, authoritystore.Failure(authoritystore.ErrorContentInvalid, "stored workflow authority run integrity check failed", nil)
	}
	return result, nil
}

func (repository *Repository) ReadReceipt(ctx context.Context, workspaceID, key string) (authoritystore.Receipt, error) {
	if err := authoritystore.ValidateReceiptIdentity(workspaceID, key); err != nil {
		return authoritystore.Receipt{}, err
	}
	result, _, err := readReceipt(repository.pool.QueryRow(ctx, receiptByWorkspaceKeySQL, key, workspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorNotFound, "workflow authority receipt not found", err)
	}
	if err != nil {
		return authoritystore.Receipt{}, databaseFailure("read workflow authority receipt", err)
	}
	return result, nil
}

func (repository *Repository) ReadOutbox(ctx context.Context, workspaceID, runID string, revision int64) (authoritystore.OutboxRecord, error) {
	if err := authoritystore.ValidateReadIdentity(workspaceID, runID); err != nil || revision < 1 || revision > authoritycontract.MaxSafeInteger {
		return authoritystore.OutboxRecord{}, authoritystore.Failure(authoritystore.ErrorInputInvalid, "workflow authority outbox identity is invalid", err)
	}
	result := authoritystore.OutboxRecord{Schema: authoritystore.OutboxSchema}
	if err := repository.pool.QueryRow(ctx, outboxReadSQL, workspaceID, runID, revision).Scan(
		&result.OutboxID, &result.EventID, &result.WorkspaceID, &result.RunID, &result.RunRevision,
		&result.EventType, &result.Status, &result.IdempotencyKey, &result.PayloadHash,
		&result.PayloadBytes, &result.AttemptCount, &result.CreatedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return authoritystore.OutboxRecord{}, authoritystore.Failure(authoritystore.ErrorNotFound, "workflow authority outbox record not found", err)
	} else if err != nil {
		return authoritystore.OutboxRecord{}, databaseFailure("read workflow authority outbox", err)
	}
	digest := sha256.Sum256(result.PayloadBytes)
	if result.PayloadHash != hex.EncodeToString(digest[:]) {
		return authoritystore.OutboxRecord{}, authoritystore.Failure(authoritystore.ErrorContentInvalid, "stored workflow authority outbox integrity check failed", nil)
	}
	return result, nil
}

func (repository *Repository) Statistics(ctx context.Context) (authoritystore.Statistics, error) {
	var result authoritystore.Statistics
	if err := repository.pool.QueryRow(ctx, statisticsSQL).Scan(
		&result.Runs, &result.Receipts, &result.TransitionEvents, &result.OutboxPending, &result.ReconciliationPending,
	); err != nil {
		return authoritystore.Statistics{}, databaseFailure("read workflow authority statistics", err)
	}
	return result, nil
}

func (repository *Repository) resolveCommitOutcome(input authoritystore.MutateInput, fingerprint [sha256.Size]byte, commitErr error) (authoritystore.Receipt, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
	defer cancel()
	existing, raw, err := repository.readReceiptByKey(ctx, input.IdempotencyKey)
	if err == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint[:]) == 1 {
			return existing, nil
		}
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorIdempotencyConflict, "commit recovery found another request fingerprint", commitErr)
	}
	if !authoritystore.IsCode(err, authoritystore.ErrorNotFound) {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "commit outcome could not be read", errors.Join(commitErr, err))
	}
	return repository.persistReconciliation(ctx, input, fingerprint, commitErr)
}

func (repository *Repository) persistReconciliation(ctx context.Context, input authoritystore.MutateInput, fingerprint [sha256.Size]byte, commitErr error) (authoritystore.Receipt, error) {
	receiptID, idErr := randomToken("wca-receipt")
	token, tokenErr := randomToken(authoritystore.ReconciliationPrefix)
	if idErr != nil || tokenErr != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "generate reconciliation identity", errors.Join(commitErr, idErr, tokenErr))
	}
	request := input.Prepared.Envelope
	reconciliationValue := authoritycontract.Receipt{
		Schema: authoritycontract.ReceiptSchema, Operation: authoritycontract.ReceiptRunTransition,
		Status: authoritycontract.ReceiptReconciliationRequired, WorkspaceID: request.WorkspaceID,
		RunID: request.RunID, ExpectedRevision: request.Expected.Revision,
		ResumeGeneration: request.Record.ResumeGeneration, Route: request.Route,
		IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint,
		RequestHash: input.Prepared.RequestHash, CorrelationID: request.CorrelationID,
		ServiceBuildHash: input.ServiceBuildHash, ReconciliationToken: &token,
	}
	receiptBytes, err := exactReceiptBytes(reconciliationValue)
	if err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "encode reconciliation receipt", errors.Join(commitErr, err))
	}
	requestHash := mustDecodeHash(input.Prepared.RequestHash)
	buildHash := mustDecodeHash(input.ServiceBuildHash)
	evidenceDigest := sha256.Sum256([]byte(commitErr.Error() + "\n" + input.Prepared.RequestHash))

	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "begin reconciliation record", errors.Join(commitErr, err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScope(ctx, tx, input.IdempotencyKey, request.WorkspaceID, request.RunID); err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "lock reconciliation record", errors.Join(commitErr, err))
	}
	tag, err := tx.Exec(ctx, receiptReconciliationInsertSQL,
		receiptID, input.IdempotencyKey, fingerprint[:], requestHash, request.WorkspaceID,
		request.RunID, request.Expected.Revision, request.Record.ResumeGeneration,
		request.Route.Backend, request.Route.Authority, request.Route.RoutingEpoch, buildHash,
		request.CorrelationID, buildHash, token, receiptBytes,
	)
	if err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "insert reconciliation receipt", errors.Join(commitErr, err))
	}
	if tag.RowsAffected() == 1 {
		if _, err := tx.Exec(ctx, reconciliationInsertSQL,
			token, receiptID, input.IdempotencyKey, fingerprint[:], requestHash, evidenceDigest[:],
			request.WorkspaceID, request.RunID, request.Expected.Revision, nullableState(request.Expected.State),
			nullableString(request.Expected.CurrentPhaseID), nullableInt64(request.Expected.CurrentPhaseIndex),
			request.Expected.ResumeGeneration, request.Record.Revision, string(request.Record.State),
			nullableString(request.Record.CurrentPhaseID), nullableInt64(request.Record.CurrentPhaseIndex),
			request.Record.ResumeGeneration, request.Route.Backend, request.Route.Authority,
			request.Route.RoutingEpoch, buildHash, mustDecodeHash(input.Prepared.RecordHash),
		); err != nil {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "insert reconciliation evidence", errors.Join(commitErr, err))
		}
	}
	persisted, raw, err := readReceipt(tx.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	if err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "read reconciliation receipt", errors.Join(commitErr, err))
	}
	if subtle.ConstantTimeCompare(raw, fingerprint[:]) != 1 {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorIdempotencyConflict, "reconciliation receipt fingerprint conflict", commitErr)
	}
	commit := repository.commitReconciliation
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if reconciliationErr := commit(ctx, tx); reconciliationErr != nil {
		verificationContext, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
		defer cancel()
		verified, raw, readErr := repository.readReceiptByKey(verificationContext, input.IdempotencyKey)
		if readErr == nil && subtle.ConstantTimeCompare(raw, fingerprint[:]) == 1 &&
			verified.Value.Status == authoritycontract.ReceiptReconciliationRequired {
			return verified, nil
		}
		return authoritystore.Receipt{}, authoritystore.Failure(
			authoritystore.ErrorCommitUnknown, "reconciliation commit outcome is unknown",
			errors.Join(commitErr, reconciliationErr, readErr),
		)
	}
	return persisted, nil
}

func (repository *Repository) readReceiptByKey(ctx context.Context, key string) (authoritystore.Receipt, []byte, error) {
	result, raw, err := readReceipt(repository.pool.QueryRow(ctx, receiptByKeySQL, key))
	if errors.Is(err, pgx.ErrNoRows) {
		return authoritystore.Receipt{}, nil, authoritystore.Failure(authoritystore.ErrorNotFound, "workflow authority receipt not found", err)
	}
	if err != nil {
		return authoritystore.Receipt{}, nil, databaseFailure("read workflow authority receipt", err)
	}
	return result, raw, nil
}

func readReceipt(row pgx.Row) (authoritystore.Receipt, []byte, error) {
	var result authoritystore.Receipt
	var operation, status string
	var fingerprint, requestHash, routeBuildHash, serviceBuildHash []byte
	var acceptedRevision pgtype.Int8
	var recordHash []byte
	var committed pgtype.Timestamptz
	var reconciliation pgtype.Text
	var workspaceID, runID, idempotencyKey, correlationID string
	var expectedRevision, resumeGeneration, routingEpoch int64
	var backend, authority string
	if err := row.Scan(
		&result.ReceiptID, &operation, &status, &idempotencyKey, &fingerprint,
		&requestHash, &workspaceID, &runID, &expectedRevision, &acceptedRevision,
		&resumeGeneration, &backend, &authority, &routingEpoch, &routeBuildHash,
		&recordHash, &correlationID, &serviceBuildHash, &committed, &reconciliation,
		&result.ExactBytes, &result.RecordedAt,
	); err != nil {
		return authoritystore.Receipt{}, nil, err
	}
	if len(fingerprint) != sha256.Size || len(requestHash) != sha256.Size || len(routeBuildHash) != sha256.Size || len(serviceBuildHash) != sha256.Size {
		return authoritystore.Receipt{}, nil, fmt.Errorf("stored workflow authority receipt digest length is invalid")
	}
	value, err := authoritycontract.DecodeReceiptJSON(result.ExactBytes)
	if err != nil {
		return authoritystore.Receipt{}, nil, fmt.Errorf("stored workflow authority receipt is invalid: %w", err)
	}
	wantFingerprint := "sha256:" + hex.EncodeToString(fingerprint)
	wantRequestHash := hex.EncodeToString(requestHash)
	wantBuildHash := hex.EncodeToString(routeBuildHash)
	wantServiceBuildHash := hex.EncodeToString(serviceBuildHash)
	if operation != string(value.Operation) || status != string(value.Status) || idempotencyKey != value.IdempotencyKey ||
		workspaceID != value.WorkspaceID || runID != value.RunID || expectedRevision != value.ExpectedRevision ||
		resumeGeneration != value.ResumeGeneration || backend != value.Route.Backend || authority != value.Route.Authority ||
		routingEpoch != value.Route.RoutingEpoch || wantBuildHash != value.Route.AuthorityBuildHash || wantServiceBuildHash != value.ServiceBuildHash ||
		wantFingerprint != value.RequestFingerprint || wantRequestHash != value.RequestHash || correlationID != value.CorrelationID {
		return authoritystore.Receipt{}, nil, fmt.Errorf("stored workflow authority receipt columns do not match exact bytes")
	}
	if acceptedRevision.Valid {
		if value.AcceptedRevision == nil || *value.AcceptedRevision != acceptedRevision.Int64 {
			return authoritystore.Receipt{}, nil, fmt.Errorf("stored accepted revision does not match exact receipt")
		}
	} else if value.AcceptedRevision != nil {
		return authoritystore.Receipt{}, nil, fmt.Errorf("stored reconciliation receipt claims an accepted revision")
	}
	if len(recordHash) == sha256.Size {
		if value.RecordHash == nil || *value.RecordHash != hex.EncodeToString(recordHash) {
			return authoritystore.Receipt{}, nil, fmt.Errorf("stored record hash does not match exact receipt")
		}
	} else if len(recordHash) != 0 || value.RecordHash != nil {
		return authoritystore.Receipt{}, nil, fmt.Errorf("stored reconciliation record hash is invalid")
	}
	if committed.Valid != (value.CommittedAt != nil) || reconciliation.Valid != (value.ReconciliationToken != nil) {
		return authoritystore.Receipt{}, nil, fmt.Errorf("stored receipt outcome shape does not match exact bytes")
	}
	if committed.Valid && canonicalTimestamp(committed.Time) != *value.CommittedAt {
		return authoritystore.Receipt{}, nil, fmt.Errorf("stored committed timestamp does not match exact receipt")
	}
	if reconciliation.Valid && reconciliation.String != *value.ReconciliationToken {
		return authoritystore.Receipt{}, nil, fmt.Errorf("stored reconciliation token does not match exact receipt")
	}
	result.Value = value
	return result, append([]byte(nil), fingerprint...), nil
}

type outboxPayload struct {
	Schema        string                         `json:"schema"`
	EventID       string                         `json:"eventId"`
	ReceiptID     string                         `json:"receiptId"`
	WorkspaceID   string                         `json:"workspaceId"`
	RunID         string                         `json:"runId"`
	Expected      authoritystore.ExpectedBinding `json:"expected"`
	Record        authoritystore.RunRecord       `json:"record"`
	RecordHash    string                         `json:"recordHash"`
	CorrelationID string                         `json:"correlationId"`
}

func prepareOutbox(eventID, receiptID string, prepared authoritystore.PreparedRequest) ([]byte, string, string, error) {
	payload := outboxPayload{
		Schema: authoritystore.OutboxSchema, EventID: eventID, ReceiptID: receiptID,
		WorkspaceID: prepared.Envelope.WorkspaceID, RunID: prepared.Envelope.RunID,
		Expected: prepared.Envelope.Expected, Record: prepared.Envelope.Record,
		RecordHash: prepared.RecordHash, CorrelationID: prepared.Envelope.CorrelationID,
	}
	encoded, err := canonicaljson.Encode(payload)
	if err != nil {
		return nil, "", "", err
	}
	encoded = append(encoded, '\n')
	digest := sha256.Sum256(encoded)
	hash := hex.EncodeToString(digest[:])
	return encoded, hash, authoritystore.OutboxKeyPrefix + hash, nil
}

func exactReceiptBytes(value authoritycontract.Receipt) ([]byte, error) {
	encoded, err := authoritycontract.CanonicalJSON(value)
	if err != nil {
		return nil, err
	}
	exact := append(encoded, '\n')
	if _, err := authoritycontract.DecodeReceiptJSON(exact); err != nil {
		return nil, err
	}
	return exact, nil
}

func lockScope(ctx context.Context, tx pgx.Tx, key, workspaceID, runID string) error {
	for _, lock := range []struct {
		value string
		salt  int64
		name  string
	}{
		{key, idempotencyLockSalt, "lock workflow authority idempotency key"},
		{runLockKey(workspaceID, runID), runLockSalt, "lock workflow authority run"},
	} {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, lock.value, lock.salt); err != nil {
			return databaseFailure(lock.name, err)
		}
	}
	return nil
}

func runLockKey(workspaceID, runID string) string {
	return strconv.Itoa(len(workspaceID)) + ":" + workspaceID + strconv.Itoa(len(runID)) + ":" + runID
}

func randomToken(prefix string) (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return prefix + "-" + base64.RawURLEncoding.EncodeToString(raw), nil
}

func nullableState(value *authoritystore.RunState) any {
	if value == nil {
		return nil
	}
	return string(*value)
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func equalNullableString(left, right *string) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func equalNullableInt64(left, right *int64) bool {
	return (left == nil && right == nil) || (left != nil && right != nil && *left == *right)
}

func mustDecodeHash(value string) []byte {
	decoded, _ := hex.DecodeString(value)
	return decoded
}

func isHash(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == hex.EncodeToString(decoded)
}

func canonicalTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func databaseFailure(operation string, err error) error {
	return authoritystore.Failure(authoritystore.ErrorDatabase, operation, err)
}

func mapWriteFailure(operation string, err error) error {
	if isUniqueViolation(err) || isForeignKeyViolation(err) || isCheckViolation(err) {
		return authoritystore.Failure(authoritystore.ErrorConflict, operation, err)
	}
	return databaseFailure(operation, err)
}

func isUniqueViolation(err error) bool     { return postgresCode(err) == "23505" }
func isForeignKeyViolation(err error) bool { return postgresCode(err) == "23503" }
func isCheckViolation(err error) bool      { return postgresCode(err) == "23514" }

func postgresCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}
