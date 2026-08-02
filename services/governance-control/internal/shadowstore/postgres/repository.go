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

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
)

const (
	idempotencyLockSalt   int64 = 738329560154001
	planLockSalt          int64 = 738329560154002
	reconciliationTimeout       = 5 * time.Second
)

type Repository struct {
	pool              *pgxpool.Pool
	commitTransaction func(context.Context, pgx.Tx) error
}

func New(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

type head struct {
	exists          bool
	sourceSequence  int64
	matchedRevision *int64
	matchedHash     []byte
	matchedState    *string
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
	if err := lockScope(ctx, tx, input.IdempotencyKey, prepared.Source); err != nil {
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

	current, err := readHead(ctx, tx, prepared.Source)
	if err != nil {
		return shadowstore.Receipt{}, err
	}
	expectedSequence := int64(1)
	if current.exists {
		expectedSequence = current.sourceSequence + 1
	}
	if prepared.Source.SourceSequence != expectedSequence {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorSequenceConflict, fmt.Sprintf("expected source sequence %d", expectedSequence), nil)
	}

	var historical []byte
	if prepared.Kind == shadowstore.KindRecord {
		if current.matchedRevision != nil {
			historical, err = readRecord(ctx, tx, prepared.Source.WorkspaceID, prepared.Source.PlanID, *current.matchedRevision)
		}
	} else {
		historical, err = readRecord(ctx, tx, prepared.Source.WorkspaceID, prepared.Source.PlanID, prepared.RecordRevision)
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return shadowstore.Receipt{}, databaseFailure("read matched record version", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		historical = nil
	}

	var evaluation shadowstore.Evaluation
	switch prepared.Kind {
	case shadowstore.KindRecord:
		evaluation = shadowstore.EvaluateRecord(prepared, historical)
	case shadowstore.KindConfirmation:
		evaluation = shadowstore.EvaluateConfirmation(prepared, historical)
	case shadowstore.KindAudit:
		evaluation = shadowstore.EvaluateAudit(prepared, historical)
	default:
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "unknown observation kind", nil)
	}

	observationID, err := randomToken("gobserve")
	if err != nil {
		return shadowstore.Receipt{}, databaseFailure("generate observation id", err)
	}
	var recordHash []byte
	if evaluation.RecordHash != "" {
		recordHash, err = hex.DecodeString(evaluation.RecordHash)
		if err != nil {
			return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "decode record hash", err)
		}
	}
	var recordedAt time.Time
	if err := tx.QueryRow(ctx, observationInsertSQL,
		observationID, prepared.Source.WorkspaceID, prepared.Source.PlanID, prepared.Source.SourceSequence,
		string(prepared.Kind), string(evaluation.Parity), nullableString(evaluation.MismatchCode), nullableRevision(prepared.RecordRevision),
		recordHash, prepared.ExactBody, prepared.BodyDigest[:], evaluation.ProjectionBytes,
	).Scan(&recordedAt); err != nil {
		return shadowstore.Receipt{}, mapWriteFailure("insert observation", err)
	}

	nextRevision := current.matchedRevision
	nextHash := current.matchedHash
	nextState := current.matchedState
	if prepared.Kind == shadowstore.KindRecord && evaluation.Parity == shadowstore.ParityMatched {
		projection, projectErr := governance.Project(prepared.Record)
		if projectErr != nil {
			return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "project matched record", projectErr)
		}
		if _, err := tx.Exec(ctx, recordVersionInsertSQL,
			prepared.Source.WorkspaceID, prepared.Source.PlanID, prepared.RecordRevision,
			observationID, string(projection.State), recordHash, prepared.RecordBytes,
		); err != nil {
			return shadowstore.Receipt{}, mapWriteFailure("insert matched record version", err)
		}
		revision := prepared.RecordRevision
		state := string(projection.State)
		nextRevision, nextHash, nextState = &revision, append([]byte(nil), recordHash...), &state
	}
	if err := writeHead(ctx, tx, prepared.Source, current, nextRevision, nextHash, nextState); err != nil {
		return shadowstore.Receipt{}, err
	}

	receiptID, err := randomToken("greceipt")
	if err != nil {
		return shadowstore.Receipt{}, databaseFailure("generate receipt id", err)
	}
	var committedAt time.Time
	var receiptRecordedAt time.Time
	if err := tx.QueryRow(ctx, receiptAcceptedInsertSQL,
		receiptID, string(evaluation.Parity), input.IdempotencyKey, fingerprint[:],
		prepared.Source.WorkspaceID, prepared.Source.PlanID, prepared.Source.SourceSequence,
		string(prepared.Kind), prepared.BodyDigest[:], observationID, nullableString(evaluation.MismatchCode),
	).Scan(&committedAt, &receiptRecordedAt); err != nil {
		return shadowstore.Receipt{}, mapWriteFailure("insert accepted receipt", err)
	}
	receipt := shadowstore.Receipt{
		Schema: shadowstore.ReceiptSchema, Operation: "observation_ingest", Status: shadowstore.ReceiptAccepted,
		Parity: evaluation.Parity, IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint,
		WorkspaceID: prepared.Source.WorkspaceID, PlanID: prepared.Source.PlanID, SourceSequence: prepared.Source.SourceSequence,
		ObservationKind: prepared.Kind, ObservationDigest: shadowstore.DigestString(prepared.BodyDigest), MismatchCode: evaluation.MismatchCode,
		CommittedAt: &committedAt, ReceiptID: receiptID, RecordedAt: receiptRecordedAt,
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

func (repository *Repository) Projection(ctx context.Context, workspaceID, planID string) (shadowstore.Projection, error) {
	if err := shadowstore.ValidateProjectionIdentity(workspaceID, planID); err != nil {
		return shadowstore.Projection{}, err
	}
	var sourceSequence int64
	var revision pgtype.Int8
	if err := repository.pool.QueryRow(ctx, projectionHeadSQL, workspaceID, planID).Scan(&sourceSequence, &revision); errors.Is(err, pgx.ErrNoRows) {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorNotFound, "projection not found", err)
	} else if err != nil {
		return shadowstore.Projection{}, databaseFailure("read projection head", err)
	}
	if !revision.Valid {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorNotFound, "matched record projection not found", nil)
	}
	recordBytes, err := readRecord(ctx, repository.pool, workspaceID, planID, revision.Int64)
	if err != nil {
		return shadowstore.Projection{}, databaseFailure("read projected record", err)
	}
	record, err := governance.ValidateCanonicalRecordBytes(recordBytes)
	if err != nil {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "stored projected record is invalid", err)
	}
	readModel, err := governance.Project(record)
	if err != nil {
		return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorContentInvalid, "project stored record", err)
	}
	result := shadowstore.Projection{Schema: shadowstore.ProjectionSchema, Authority: shadowstore.Authority, Shadow: "go", Parity: shadowstore.ParityMatched,
		WorkspaceID: workspaceID, PlanID: planID, SourceSequence: sourceSequence, MatchedRecordRevision: revision.Int64, ReadModel: readModel}
	if err := repository.pool.QueryRow(ctx, projectionCountsSQL, workspaceID, planID).Scan(
		&result.MatchedObservations, &result.MismatchedObservations, &result.ConfirmationMatched,
		&result.ConfirmationMismatched, &result.AuditMatched, &result.AuditMismatched,
	); err != nil {
		return shadowstore.Projection{}, databaseFailure("read projection counts", err)
	}
	if result.MismatchedObservations > 0 {
		result.Parity = shadowstore.ParityMismatched
	}
	return result, nil
}

func (repository *Repository) Statistics(ctx context.Context) (shadowstore.Statistics, error) {
	var result shadowstore.Statistics
	if err := repository.pool.QueryRow(ctx, statisticsSQL).Scan(&result.Plans, &result.SourceSequenceMax, &result.MatchedObservations, &result.MismatchedObservations, &result.ReconciliationPending); err != nil {
		return shadowstore.Statistics{}, databaseFailure("read statistics", err)
	}
	return result, nil
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readRecord(ctx context.Context, query rowQuerier, workspaceID, planID string, revision int64) ([]byte, error) {
	var value []byte
	err := query.QueryRow(ctx, recordVersionSQL, workspaceID, planID, revision).Scan(&value)
	return append([]byte(nil), value...), err
}

func readHead(ctx context.Context, tx pgx.Tx, source shadowstore.Source) (head, error) {
	var result head
	var revision pgtype.Int8
	var hash []byte
	var state pgtype.Text
	err := tx.QueryRow(ctx, headForUpdateSQL, source.WorkspaceID, source.PlanID).Scan(&result.sourceSequence, &revision, &hash, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return head{}, databaseFailure("lock shadow plan head", err)
	}
	result.exists = true
	if revision.Valid {
		value := revision.Int64
		result.matchedRevision = &value
	}
	if state.Valid {
		value := state.String
		result.matchedState = &value
	}
	result.matchedHash = append([]byte(nil), hash...)
	return result, nil
}

func writeHead(ctx context.Context, tx pgx.Tx, source shadowstore.Source, current head, revision *int64, hash []byte, state *string) error {
	if !current.exists {
		if source.SourceSequence != 1 {
			return shadowstore.Failure(shadowstore.ErrorSequenceConflict, "first source sequence must be one", nil)
		}
		_, err := tx.Exec(ctx, headInsertSQL, source.WorkspaceID, source.PlanID, source.SourceSequence, revision, hash, state)
		if err != nil {
			return mapWriteFailure("insert shadow plan head", err)
		}
		return nil
	}
	tag, err := tx.Exec(ctx, headUpdateSQL, source.WorkspaceID, source.PlanID, current.sourceSequence, source.SourceSequence, revision, hash, state)
	if err != nil {
		return mapWriteFailure("advance shadow plan head", err)
	}
	if tag.RowsAffected() != 1 {
		return shadowstore.Failure(shadowstore.ErrorSequenceConflict, "shadow source sequence compare-and-swap lost", nil)
	}
	return nil
}

func lockScope(ctx context.Context, tx pgx.Tx, key string, source shadowstore.Source) error {
	for _, lock := range []struct {
		value     string
		salt      int64
		operation string
	}{
		{key, idempotencyLockSalt, "lock idempotency key"},
		{planLockKey(source), planLockSalt, "lock shadow plan"},
	} {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, lock.value, lock.salt); err != nil {
			return databaseFailure(lock.operation, err)
		}
	}
	return nil
}

// planLockKey is a collision-free, PostgreSQL-text-safe encoding of the
// authoritative composite identity. PostgreSQL text values cannot carry NUL,
// so the wire value must not reuse the in-memory NUL separator convention.
func planLockKey(source shadowstore.Source) string {
	return strconv.Itoa(len(source.WorkspaceID)) + ":" + source.WorkspaceID +
		strconv.Itoa(len(source.PlanID)) + ":" + source.PlanID
}

func (repository *Repository) resolveCommitOutcome(prepared shadowstore.PreparedObservation, input shadowstore.ObserveInput, fingerprint [sha256.Size]byte, commitErr error) (shadowstore.Receipt, error) {
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
	receiptID, idErr := randomToken("greceipt")
	token, tokenErr := randomToken("greconcile")
	if idErr != nil || tokenErr != nil {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "generate reconciliation identity", errors.Join(commitErr, idErr, tokenErr))
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "begin reconciliation receipt", errors.Join(commitErr, err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScope(ctx, tx, input.IdempotencyKey, prepared.Source); err != nil {
		return shadowstore.Receipt{}, shadowstore.Failure(shadowstore.ErrorCommitUnknown, "lock reconciliation receipt", errors.Join(commitErr, err))
	}
	if _, err := tx.Exec(ctx, receiptReconciliationInsertSQL,
		receiptID, input.IdempotencyKey, fingerprint[:], prepared.Source.WorkspaceID, prepared.Source.PlanID,
		prepared.Source.SourceSequence, string(prepared.Kind), prepared.BodyDigest[:], token,
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
	var status, parity, kind string
	var fingerprint, digest []byte
	var mismatch pgtype.Text
	var committed pgtype.Timestamptz
	var reconciliation pgtype.Text
	if err := row.Scan(&result.ReceiptID, &result.Operation, &status, &parity, &result.IdempotencyKey, &fingerprint,
		&result.WorkspaceID, &result.PlanID, &result.SourceSequence, &kind, &digest, &mismatch,
		&committed, &reconciliation, &result.RecordedAt); err != nil {
		return shadowstore.Receipt{}, nil, err
	}
	if len(fingerprint) != sha256.Size || len(digest) != sha256.Size {
		return shadowstore.Receipt{}, nil, fmt.Errorf("stored receipt digest length is invalid")
	}
	result.Schema = shadowstore.ReceiptSchema
	result.Status, result.Parity, result.ObservationKind = shadowstore.ReceiptStatus(status), shadowstore.Parity(parity), shadowstore.Kind(kind)
	result.RequestFingerprint = "sha256:" + hex.EncodeToString(fingerprint)
	result.ObservationDigest = hex.EncodeToString(digest)
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
func nullableRevision(value int64) any {
	if value == 0 {
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
