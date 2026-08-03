package postgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore"
)

const (
	idempotencyLockSalt   int64 = 849440630271001
	runLockSalt           int64 = 849440630271002
	reconciliationTimeout       = 5 * time.Second
)

type Repository struct {
	pool              *pgxpool.Pool
	commitTransaction func(context.Context, pgx.Tx) error
}

func New(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

func NewWithCommitter(pool *pgxpool.Pool, commit func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commitTransaction: commit}
}

type head struct {
	exists                 bool
	sourceSequence         int64
	matchedSourceSequence  *int64
	matchedObservationID   *string
	matchedObservationHash []byte
	matchedStatus          *string
	matchedEnvelope        []byte
}

func (repository *Repository) Observe(ctx context.Context, input shadowstore.ObserveInput) (shadowstore.Receipt, error) {
	if err := shadowstore.ValidateIdempotencyKey(input.IdempotencyKey); err != nil {
		return shadowstore.Receipt{}, err
	}
	prepared, err := shadowstore.PrepareObservation(input.ExactBody)
	if err != nil {
		return shadowstore.Receipt{}, err
	}
	if err := shadowstore.ValidateObservationIdempotencyKey(prepared, input.IdempotencyKey); err != nil {
		return shadowstore.Receipt{}, err
	}
	expectedFingerprint := shadowstore.RequestFingerprint(prepared)
	if input.RequestFingerprint != expectedFingerprint {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorInputInvalid, "request fingerprint does not bind the canonical observation", nil)
	}
	fingerprint, err := shadowstore.ParseFingerprint(input.RequestFingerprint)
	if err != nil {
		return shadowstore.Receipt{}, err
	}

	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return shadowstore.Receipt{}, databaseFailure("begin observation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScope(ctx, tx, input.IdempotencyKey, prepared.Envelope.Source); err != nil {
		return shadowstore.Receipt{}, err
	}
	existing, rawFingerprint, err := readReceipt(tx.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	switch {
	case err == nil:
		if subtle.ConstantTimeCompare(rawFingerprint, fingerprint[:]) != 1 {
			return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorIdempotencyConflict, "idempotency key is bound to another request", nil)
		}
		if existing.Status == shadowstore.ReceiptAccepted {
			existing.Status = shadowstore.ReceiptDuplicate
		}
		return existing, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return shadowstore.Receipt{}, databaseFailure("read receipt", err)
	}

	current, err := readHead(ctx, tx, prepared.Envelope.Source)
	if err != nil {
		return shadowstore.Receipt{}, err
	}
	expectedSequence := int64(1)
	if current.exists {
		expectedSequence = current.sourceSequence + 1
	}
	if err := shadowstore.ValidateSourceSequence(expectedSequence, prepared.Envelope.Source.SourceSequence); err != nil {
		return shadowstore.Receipt{}, err
	}

	evaluation := shadowstore.Evaluate(prepared, current.matchedEnvelope)
	observationID, err := randomToken("wobserve")
	if err != nil {
		return shadowstore.Receipt{}, databaseFailure("generate observation id", err)
	}
	observationHash, err := hex.DecodeString(evaluation.ObservationHash)
	if err != nil || len(observationHash) != sha256.Size {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "decode observation hash", err)
	}
	var recordedAt time.Time
	source := prepared.Envelope.Source
	if err := tx.QueryRow(ctx, observationInsertSQL,
		observationID, source.WorkspaceID, source.RunID, source.SourceSequence,
		string(evaluation.Parity), nullableString(evaluation.MismatchCode), string(evaluation.Status),
		prepared.ExactBody, prepared.BodyDigest[:], observationHash, evaluation.ProjectionBytes,
	).Scan(&recordedAt); err != nil {
		return shadowstore.Receipt{}, mapWriteFailure("insert observation", err)
	}

	nextMatchedSequence := current.matchedSourceSequence
	nextObservationID := current.matchedObservationID
	nextObservationHash := current.matchedObservationHash
	nextStatus := current.matchedStatus
	nextEnvelope := current.matchedEnvelope
	if evaluation.Parity == shadowstore.ParityMatched {
		sequence := source.SourceSequence
		status := string(evaluation.Status)
		nextMatchedSequence = &sequence
		nextObservationID = &observationID
		nextObservationHash = append([]byte(nil), observationHash...)
		nextStatus = &status
		nextEnvelope = append([]byte(nil), prepared.ExactBody...)
	}
	if err := writeHead(ctx, tx, source, current, nextMatchedSequence, nextObservationID, nextObservationHash, nextStatus, nextEnvelope); err != nil {
		return shadowstore.Receipt{}, err
	}

	receiptID, err := randomToken("wreceipt")
	if err != nil {
		return shadowstore.Receipt{}, databaseFailure("generate receipt id", err)
	}
	var committedAt, receiptRecordedAt time.Time
	if err := tx.QueryRow(ctx, receiptAcceptedInsertSQL,
		receiptID, string(evaluation.Parity), input.IdempotencyKey, fingerprint[:],
		source.WorkspaceID, source.RunID, source.SourceSequence, prepared.BodyDigest[:],
		observationHash, observationID, nullableString(evaluation.MismatchCode),
	).Scan(&committedAt, &receiptRecordedAt); err != nil {
		return shadowstore.Receipt{}, mapWriteFailure("insert accepted receipt", err)
	}
	receipt := shadowstore.Receipt{
		Schema: shadowstore.ReceiptSchema, Operation: "observation_ingest", Status: shadowstore.ReceiptAccepted,
		Parity: evaluation.Parity, IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint,
		WorkspaceID: source.WorkspaceID, RunID: source.RunID, SourceSequence: source.SourceSequence,
		ObservationDigest: shadowstore.DigestString(prepared.BodyDigest), ObservationHash: evaluation.ObservationHash,
		MismatchCode: evaluation.MismatchCode, CommittedAt: &committedAt, ReceiptID: receiptID, RecordedAt: receiptRecordedAt,
	}
	commit := repository.commitTransaction
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commit(ctx, tx); err != nil {
		return repository.resolveCommitOutcome(prepared, input, fingerprint, err)
	}
	return receipt, nil
}

func (repository *Repository) Projection(ctx context.Context, workspaceID, runID string) (shadowstore.Projection, error) {
	if err := shadowstore.ValidateProjectionIdentity(workspaceID, runID); err != nil {
		return shadowstore.Projection{}, err
	}
	var sourceSequence int64
	var matchedSourceSequence pgtype.Int8
	var rawHash, envelopeBytes []byte
	result := shadowstore.Projection{
		Schema: shadowstore.ProjectionSchema, Authority: shadowstore.Authority, Shadow: "go",
		GoRole: "credential-free-observer-only", AuthorityEligible: false,
		Parity: shadowstore.ParityMatched, WorkspaceID: workspaceID, RunID: runID,
	}
	if err := repository.pool.QueryRow(ctx, projectionSnapshotSQL, workspaceID, runID).Scan(
		&sourceSequence, &matchedSourceSequence, &rawHash, &envelopeBytes,
		&result.MatchedObservations, &result.MismatchedObservations,
	); errors.Is(err, pgx.ErrNoRows) {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorNotFound, "projection not found", err)
	} else if err != nil {
		return shadowstore.Projection{}, databaseFailure("read projection snapshot", err)
	}
	if !matchedSourceSequence.Valid || len(rawHash) == 0 || len(envelopeBytes) == 0 {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorNotFound, "matched observation projection not found", nil)
	}
	if len(rawHash) != sha256.Size {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "stored matched observation hash length is invalid", nil)
	}
	envelope, err := workflowcontrol.ValidateCanonicalShadowEnvelopeBytes(envelopeBytes)
	if err != nil {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "stored matched envelope is invalid", err)
	}
	readModel, matched, err := workflowcontrol.CompareShadowProjection(envelope)
	if err != nil || !matched {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "stored matched projection is invalid", err)
	}
	decodedHash, err := hex.DecodeString(readModel.ObservationHash)
	if err != nil || subtle.ConstantTimeCompare(rawHash, decodedHash) != 1 {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "stored matched observation hash is invalid", err)
	}
	result.SourceSequence = sourceSequence
	result.MatchedSourceSequence = matchedSourceSequence.Int64
	result.MatchedObservationHash = readModel.ObservationHash
	result.ReadModel = readModel
	if result.MismatchedObservations > 0 {
		result.Parity = shadowstore.ParityMismatched
	}
	return result, nil
}

func (repository *Repository) Statistics(ctx context.Context) (shadowstore.Statistics, error) {
	var result shadowstore.Statistics
	if err := repository.pool.QueryRow(ctx, statisticsSQL).Scan(
		&result.Runs, &result.SourceSequenceMax, &result.MatchedObservations,
		&result.MismatchedObservations, &result.ReconciliationPending,
	); err != nil {
		return shadowstore.Statistics{}, databaseFailure("read statistics", err)
	}
	return result, nil
}

func readHead(ctx context.Context, tx pgx.Tx, source workflowcontrol.ShadowSource) (head, error) {
	var result head
	var matchedSequence pgtype.Int8
	var observationID, status pgtype.Text
	err := tx.QueryRow(ctx, headForUpdateSQL, source.WorkspaceID, source.RunID).Scan(
		&result.sourceSequence, &matchedSequence, &observationID,
		&result.matchedObservationHash, &status, &result.matchedEnvelope,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return head{}, databaseFailure("lock shadow run head", err)
	}
	result.exists = true
	if matchedSequence.Valid {
		value := matchedSequence.Int64
		result.matchedSourceSequence = &value
	}
	if observationID.Valid {
		value := observationID.String
		result.matchedObservationID = &value
	}
	if status.Valid {
		value := status.String
		result.matchedStatus = &value
	}
	result.matchedObservationHash = append([]byte(nil), result.matchedObservationHash...)
	result.matchedEnvelope = append([]byte(nil), result.matchedEnvelope...)
	return result, nil
}

func writeHead(
	ctx context.Context,
	tx pgx.Tx,
	source workflowcontrol.ShadowSource,
	current head,
	matchedSequence *int64,
	observationID *string,
	observationHash []byte,
	status *string,
	envelope []byte,
) error {
	if !current.exists {
		if source.SourceSequence != 1 {
			return shadowstore.Failure(shadowstore.ErrorSequenceConflict, "first source sequence must be one", nil)
		}
		_, err := tx.Exec(ctx, headInsertSQL,
			source.WorkspaceID, source.RunID, source.SourceSequence, matchedSequence,
			observationID, nullableBytes(observationHash), status, nullableBytes(envelope),
		)
		if err != nil {
			return mapWriteFailure("insert shadow run head", err)
		}
		return nil
	}
	tag, err := tx.Exec(ctx, headUpdateSQL,
		source.WorkspaceID, source.RunID, current.sourceSequence, source.SourceSequence,
		matchedSequence, observationID, nullableBytes(observationHash), status, nullableBytes(envelope),
	)
	if err != nil {
		return mapWriteFailure("advance shadow run head", err)
	}
	if tag.RowsAffected() != 1 {
		return shadowstore.Failure(shadowstore.ErrorSequenceConflict, "shadow source sequence compare-and-swap lost", nil)
	}
	return nil
}

func lockScope(ctx context.Context, tx pgx.Tx, key string, source workflowcontrol.ShadowSource) error {
	for _, lock := range []struct {
		value     string
		salt      int64
		operation string
	}{
		{key, idempotencyLockSalt, "lock idempotency key"},
		{runLockKey(source), runLockSalt, "lock shadow run"},
	} {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, lock.value, lock.salt); err != nil {
			return databaseFailure(lock.operation, err)
		}
	}
	return nil
}

func runLockKey(source workflowcontrol.ShadowSource) string {
	return strconv.Itoa(len(source.WorkspaceID)) + ":" + source.WorkspaceID +
		strconv.Itoa(len(source.RunID)) + ":" + source.RunID
}

func (repository *Repository) resolveCommitOutcome(
	prepared shadowstore.PreparedObservation,
	input shadowstore.ObserveInput,
	fingerprint [sha256.Size]byte,
	commitErr error,
) (shadowstore.Receipt, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
	defer cancel()
	existing, raw, err := repository.readReceiptByKey(ctx, input.IdempotencyKey)
	if err == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint[:]) == 1 {
			return existing, nil
		}
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorIdempotencyConflict, "commit recovery found another fingerprint", commitErr)
	}
	if !shadowstore.IsCode(err, shadowstore.ErrorNotFound) {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "commit outcome could not be read", errors.Join(commitErr, err))
	}
	receiptID, idErr := randomToken("wreceipt")
	token, tokenErr := randomToken("wreconcile")
	if idErr != nil || tokenErr != nil {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "generate reconciliation identity", errors.Join(commitErr, idErr, tokenErr))
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "begin reconciliation receipt", errors.Join(commitErr, err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	source := prepared.Envelope.Source
	if err := lockScope(ctx, tx, input.IdempotencyKey, source); err != nil {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "lock reconciliation receipt", errors.Join(commitErr, err))
	}
	if _, err := tx.Exec(ctx, receiptReconciliationInsertSQL,
		receiptID, input.IdempotencyKey, fingerprint[:], source.WorkspaceID, source.RunID,
		source.SourceSequence, prepared.BodyDigest[:], token,
	); err != nil && !isUniqueViolation(err) {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "insert reconciliation receipt", errors.Join(commitErr, err))
	}
	persisted, raw, err := readReceipt(tx.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	if err != nil {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "read reconciliation receipt", errors.Join(commitErr, err))
	}
	if subtle.ConstantTimeCompare(raw, fingerprint[:]) != 1 {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorIdempotencyConflict, "reconciliation receipt fingerprint conflict", commitErr)
	}
	if err := tx.Commit(ctx); err != nil {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "commit reconciliation receipt", errors.Join(commitErr, err))
	}
	return persisted, nil
}

func (repository *Repository) readReceiptByKey(ctx context.Context, key string) (shadowstore.Receipt, []byte, error) {
	receipt, raw, err := readReceipt(repository.pool.QueryRow(ctx, receiptByKeySQL, key))
	if errors.Is(err, pgx.ErrNoRows) {
		return shadowstore.Receipt{}, nil, shadowstore.Failure(shadowstore.ErrorNotFound, "receipt not found", err)
	}
	if err != nil {
		return shadowstore.Receipt{}, nil, databaseFailure("read receipt by key", err)
	}
	return receipt, raw, nil
}

func readReceipt(row pgx.Row) (shadowstore.Receipt, []byte, error) {
	var result shadowstore.Receipt
	var status, parity string
	var fingerprint, digest, observationHash []byte
	var mismatch, reconciliation pgtype.Text
	var committed pgtype.Timestamptz
	if err := row.Scan(
		&result.ReceiptID, &result.Operation, &status, &parity, &result.IdempotencyKey, &fingerprint,
		&result.WorkspaceID, &result.RunID, &result.SourceSequence, &digest,
		&observationHash, &mismatch, &committed, &reconciliation, &result.RecordedAt,
	); err != nil {
		return shadowstore.Receipt{}, nil, err
	}
	if len(fingerprint) != sha256.Size || len(digest) != sha256.Size ||
		(len(observationHash) != 0 && len(observationHash) != sha256.Size) {
		return shadowstore.Receipt{}, nil, fmt.Errorf("stored receipt digest length is invalid")
	}
	result.Schema = shadowstore.ReceiptSchema
	result.Status, result.Parity = shadowstore.ReceiptStatus(status), shadowstore.Parity(parity)
	result.RequestFingerprint = "sha256:" + hex.EncodeToString(fingerprint)
	result.ObservationDigest = hex.EncodeToString(digest)
	if len(observationHash) == sha256.Size {
		result.ObservationHash = hex.EncodeToString(observationHash)
	}
	if mismatch.Valid {
		result.MismatchCode = mismatch.String
	}
	if committed.Valid {
		value := committed.Time
		result.CommittedAt = &value
	}
	if reconciliation.Valid {
		value := reconciliation.String
		result.ReconciliationToken = &value
	}
	return result, append([]byte(nil), fingerprint...), nil
}

func randomToken(prefix string) (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return prefix + "-" + base64.RawURLEncoding.EncodeToString(raw), nil
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func databaseFailure(operation string, err error) error {
	return shadowstore.Failure(shadowstore.ErrorDatabase, operation, err)
}

func mapWriteFailure(operation string, err error) error {
	if isUniqueViolation(err) {
		return shadowstore.Failure(shadowstore.ErrorSequenceConflict, operation, err)
	}
	return databaseFailure(operation, err)
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
