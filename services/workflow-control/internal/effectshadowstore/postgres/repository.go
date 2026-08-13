// Package postgres persists the GS9-D effect shadow independently from every
// authority and runner table.
package postgres

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/effectshadowstore"
)

const idempotencyLockSalt int64 = 628239560154401
const approvalLockSalt int64 = 628239560154402
const reconciliationTimeout = 5 * time.Second

type Repository struct {
	pool                 *pgxpool.Pool
	commit               func(context.Context, pgx.Tx) error
	commitReconciliation func(context.Context, pgx.Tx) error
	beforeReconcileLock  func()
}

func New(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

// NewWithCommitter injects the commit boundary. The callback must end the
// transaction: nil only after Commit; an error after Commit models response
// loss, while an error after Rollback models an unknown outcome.
func NewWithCommitter(pool *pgxpool.Pool, commit func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commit: commit}
}

// NewWithCommitters follows the same transaction-ending contract for both
// callbacks. It exists only for response-loss and double-unknown qualification.
func NewWithCommitters(pool *pgxpool.Pool, commit, reconciliation func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commit: commit, commitReconciliation: reconciliation}
}

func (r *Repository) Observe(ctx context.Context, input effectshadowstore.ObserveInput) (effectshadowstore.Receipt, error) {
	fingerprint, err := decodeHash(input.RequestFingerprint)
	if err != nil || !effectshadowstore.IdempotencyKeyMatchesEnvelope(input.IdempotencyKey, input.Prepared.EnvelopeHash) {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorInputInvalid, "observation identity is invalid", err)
	}
	build, err := decodeHash(input.ServiceBuildHash)
	if err != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorInputInvalid, "service build hash is invalid", err)
	}
	o := input.Prepared.Envelope.Observation
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return effectshadowstore.Receipt{}, databaseFailure("begin effect observation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScope(ctx, tx, input.IdempotencyKey, o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID); err != nil {
		return effectshadowstore.Receipt{}, err
	}
	existing, rawFingerprint, err := readReceipt(tx.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	if err == nil {
		if subtle.ConstantTimeCompare(rawFingerprint, fingerprint) != 1 {
			return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorIdempotencyConflict, "idempotency key is bound to another observation", nil)
		}
		existing.Replay = true
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return effectshadowstore.Receipt{}, mapReadFailure("read effect receipt", err)
	}
	var reconciliationOpen bool
	if err := tx.QueryRow(ctx, reconciliationOpenSQL, o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID).Scan(&reconciliationOpen); err != nil {
		return effectshadowstore.Receipt{}, databaseFailure("read effect reconciliation gate", err)
	}
	if reconciliationOpen {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorConflict, "effect approval has an open reconciliation", nil)
	}
	previous, err := readHead(tx.QueryRow(ctx, headForUpdateSQL, o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID))
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return effectshadowstore.Receipt{}, mapReadFailure("read effect head", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		previous = nil
	}
	if previous == nil && input.Prepared.Envelope.SourceSequence != 1 {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorConflict, "first effect source sequence must be one", nil)
	}
	if previous != nil && input.Prepared.Envelope.SourceSequence != previous.SourceSequence+1 {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorConflict, "effect source sequence is not contiguous", nil)
	}
	parity, mismatch := effectshadowstore.Compare(input.Prepared.Envelope, previous)
	observationID, err := randomToken("wces-observation")
	if err != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorDatabase, "generate observation identity", err)
	}
	receiptID, err := randomToken("wces-receipt")
	if err != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorDatabase, "generate receipt identity", err)
	}
	envelopeHash := mustDecodeHash(input.Prepared.EnvelopeHash)
	observationHash := mustDecodeHash(input.Prepared.Envelope.ObservationHash)
	if _, err := tx.Exec(ctx, observationInsertSQL,
		observationID, o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID,
		input.Prepared.Envelope.SourceSequence, input.Prepared.Envelope.Operation, parity,
		nullableMismatch(mismatch), envelopeHash, input.Prepared.ExactBody,
		observationHash, input.Prepared.ObservationBytes,
	); err != nil {
		return effectshadowstore.Receipt{}, classifyWrite("insert effect observation", err)
	}
	if err := writeHead(ctx, tx, previous, input.Prepared, input.ServiceBuildHash, parity == "matched", mismatch); err != nil {
		return effectshadowstore.Receipt{}, err
	}
	if parity == "matched" {
		if err := writeOutbox(ctx, tx, observationID, input.Prepared); err != nil {
			return effectshadowstore.Receipt{}, err
		}
	}
	var committed time.Time
	if err := tx.QueryRow(ctx, `SELECT date_trunc('milliseconds', clock_timestamp())`).Scan(&committed); err != nil {
		return effectshadowstore.Receipt{}, databaseFailure("read effect commit time", err)
	}
	committedText := committed.UTC().Format(timeLayout)
	value := effectshadowstore.ReceiptValue{
		Schema: effectshadowstore.ReceiptSchema, Status: "accepted",
		IdempotencyKey: input.IdempotencyKey, ReceiptID: receiptID, ObservationID: &observationID,
		WorkspaceID: o.WorkspaceID, RunID: o.RunID, OccurrenceID: o.OccurrenceID,
		ApprovalID: o.ApprovalID, SourceSequence: input.Prepared.Envelope.SourceSequence,
		Operation: input.Prepared.Envelope.Operation, Parity: parity,
		MismatchCode: mismatchPointer(mismatch), EnvelopeHash: input.Prepared.EnvelopeHash,
		ObservationHash:  input.Prepared.Envelope.ObservationHash,
		ServiceBuildHash: input.ServiceBuildHash, CommittedAt: &committedText,
	}
	if err := effectshadowstore.ValidateReceiptValue(value); err != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "construct effect receipt", err)
	}
	exact, err := canonicaljson.Encode(value)
	if err != nil || len(exact) > effectshadowstore.MaxReceiptBytes {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "encode exact effect receipt", err)
	}
	if _, err := tx.Exec(ctx, receiptInsertSQL,
		receiptID, input.IdempotencyKey, fingerprint, o.WorkspaceID, o.RunID, o.OccurrenceID,
		o.ApprovalID, input.Prepared.Envelope.SourceSequence, input.Prepared.Envelope.Operation,
		"accepted", parity, nullableMismatch(mismatch), observationID, envelopeHash,
		observationHash, build, nil, exact, committed,
	); err != nil {
		return effectshadowstore.Receipt{}, classifyWrite("insert effect receipt", err)
	}
	result := effectshadowstore.Receipt{Value: value, ExactBytes: exact}
	commit := r.commit
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commit(ctx, tx); err != nil {
		return r.resolveCommitOutcome(input, fingerprint, err)
	}
	return result, nil
}

func writeOutbox(ctx context.Context, tx pgx.Tx, observationID string, prepared effectshadowstore.PreparedObservation) error {
	o := prepared.Envelope.Observation
	if o.Operation == effectshadowstore.OperationApprovalCreated {
		return nil
	}
	eventType := effectshadowstore.OutboxEffectDecisionObserved
	if o.Operation == effectshadowstore.OperationAuditRecorded {
		eventType = effectshadowstore.OutboxEffectAuditRecorded
	}
	if o.Decision == nil || o.AuditEventID == nil || o.BindingHash == nil {
		return effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "construct effect outbox payload", nil)
	}
	eventID, err := randomToken("wces-outbox")
	if err != nil {
		return effectshadowstore.Failure(effectshadowstore.ErrorDatabase, "generate effect outbox identity", err)
	}
	payload := effectshadowstore.OutboxPayload{
		Schema: effectshadowstore.OutboxPayloadSchema, EventID: eventID, EventType: eventType,
		Authority: "typescript", GoRole: "observer_only", NonAuthorizingObservation: true,
		GoEffectDecisionAuthority: false, GoEffectExecutionAuthority: false,
		WorkspaceID: o.WorkspaceID, RunID: o.RunID, OccurrenceID: o.OccurrenceID,
		ApprovalID: o.ApprovalID, SourceSequence: prepared.Envelope.SourceSequence,
		Operation: o.Operation, ObservationID: observationID,
		ObservationHash: prepared.Envelope.ObservationHash, ApprovalStatus: o.ApprovalStatus,
		Decision: *o.Decision, AuditEventID: *o.AuditEventID, BindingHash: *o.BindingHash,
		ObservedAt: o.ObservedAt,
	}
	if err := effectshadowstore.ValidateOutboxPayload(payload); err != nil {
		return effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "construct effect outbox payload", err)
	}
	exact, err := canonicaljson.Encode(payload)
	if err != nil || len(exact) == 0 || len(exact) > effectshadowstore.MaxOutboxBytes {
		return effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "encode effect outbox payload", err)
	}
	payloadHash := sha256.Sum256(exact)
	if _, err := tx.Exec(ctx, outboxInsertSQL,
		eventID, eventType, o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID,
		prepared.Envelope.SourceSequence, o.Operation, observationID,
		mustDecodeHash(prepared.Envelope.ObservationHash), payloadHash[:], exact,
	); err != nil {
		return classifyWrite("insert effect outbox", err)
	}
	return nil
}

func writeHead(ctx context.Context, tx pgx.Tx, previous *effectshadowstore.Head, prepared effectshadowstore.PreparedObservation, serviceBuildHash string, matched bool, mismatch string) error {
	o := prepared.Envelope.Observation
	sequence := prepared.Envelope.SourceSequence
	lastHash := mustDecodeHash(prepared.Envelope.ObservationHash)
	build := mustDecodeHash(serviceBuildHash)
	if previous == nil {
		var matchedSequence, matchedOperation, matchedHash, matchedBody any
		if matched {
			matchedSequence, matchedOperation = sequence, prepared.Envelope.Operation
			matchedHash, matchedBody = lastHash, prepared.ObservationBytes
		}
		_, err := tx.Exec(ctx, headInsertSQL,
			o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID,
			sequence, prepared.Envelope.Operation, lastHash,
			matchedSequence, matchedOperation, matchedHash, matchedBody,
			!matched, nullableMismatch(mismatch), build,
		)
		if err != nil {
			return classifyWrite("insert effect head", err)
		}
		return nil
	}
	matchedSequence := any(previous.MatchedSourceSequence)
	matchedOperation := any(previous.MatchedOperation)
	matchedHash := any(nil)
	matchedBody := any(nil)
	if previous.MatchedObservationHash != nil && previous.Observation != nil {
		matchedHash = mustDecodeHash(*previous.MatchedObservationHash)
		encoded, err := canonicaljson.Encode(previous.Observation)
		if err != nil {
			return effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "encode stored effect head", err)
		}
		matchedBody = encoded
	}
	if matched {
		matchedSequence, matchedOperation = sequence, prepared.Envelope.Operation
		matchedHash, matchedBody = lastHash, prepared.ObservationBytes
	}
	mismatchLatched := previous.MismatchLatched || !matched
	mismatchCode := previous.MismatchCode
	if !matched && mismatchCode == nil {
		mismatchCode = &mismatch
	}
	_, err := tx.Exec(ctx, headUpdateSQL,
		o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID,
		sequence, prepared.Envelope.Operation, lastHash,
		matchedSequence, matchedOperation, matchedHash, matchedBody,
		mismatchLatched, mismatchCode, build,
	)
	if err != nil {
		return classifyWrite("update effect head", err)
	}
	return nil
}

func (r *Repository) ReadHead(ctx context.Context, workspaceID, runID, occurrenceID, approvalID string) (effectshadowstore.Head, error) {
	head, err := readHead(r.pool.QueryRow(ctx, headSQL, workspaceID, runID, occurrenceID, approvalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return effectshadowstore.Head{}, effectshadowstore.Failure(effectshadowstore.ErrorNotFound, "effect head not found", err)
	}
	if err != nil {
		return effectshadowstore.Head{}, mapReadFailure("read effect head", err)
	}
	return *head, nil
}

func (r *Repository) ReadReceipt(ctx context.Context, workspaceID, key string) (effectshadowstore.Receipt, error) {
	receipt, _, err := readReceipt(r.pool.QueryRow(ctx, receiptByWorkspaceKeySQL, workspaceID, key))
	if errors.Is(err, pgx.ErrNoRows) {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorNotFound, "effect receipt not found", err)
	}
	if err != nil {
		return effectshadowstore.Receipt{}, mapReadFailure("read effect receipt", err)
	}
	return receipt, nil
}

func (r *Repository) ReadPendingOutbox(ctx context.Context, workspaceID string, limit int, cursor string) (effectshadowstore.OutboxPage, error) {
	if limit < 1 || limit > effectshadowstore.MaxOutboxReadLimit {
		return effectshadowstore.OutboxPage{}, effectshadowstore.Failure(effectshadowstore.ErrorInputInvalid, "effect outbox limit is invalid", nil)
	}
	recordedAt, eventID, err := effectshadowstore.DecodeOutboxCursor(cursor)
	if err != nil {
		return effectshadowstore.OutboxPage{}, err
	}
	var after pgtype.Timestamptz
	if !recordedAt.IsZero() {
		after = pgtype.Timestamptz{Time: recordedAt, Valid: true}
	}
	rows, err := r.pool.Query(ctx, outboxPendingSQL, workspaceID, limit+1, after, eventID)
	if err != nil {
		return effectshadowstore.OutboxPage{}, databaseFailure("read pending effect outbox", err)
	}
	defer rows.Close()
	items := make([]effectshadowstore.OutboxRead, 0, limit+1)
	for rows.Next() {
		value, err := readOutbox(rows)
		if err != nil {
			return effectshadowstore.OutboxPage{}, mapReadFailure("read pending effect outbox row", err)
		}
		items = append(items, value)
	}
	if err := rows.Err(); err != nil {
		return effectshadowstore.OutboxPage{}, databaseFailure("iterate pending effect outbox", err)
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		encoded, encodeErr := effectshadowstore.EncodeOutboxCursor(items[len(items)-1].CursorRecordedAt, items[len(items)-1].EventID)
		if encodeErr != nil {
			return effectshadowstore.OutboxPage{}, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "encode pending effect outbox cursor", encodeErr)
		}
		next = &encoded
	}
	if items == nil {
		items = []effectshadowstore.OutboxRead{}
	}
	return effectshadowstore.OutboxPage{Schema: effectshadowstore.OutboxPageSchema, Items: items, Count: len(items), NextCursor: next}, nil
}

func (r *Repository) Ready(ctx context.Context) error {
	var one int
	if err := r.pool.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil {
		return databaseFailure("effect repository readiness", err)
	}
	if one != 1 {
		return effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "effect repository readiness returned an invalid value", nil)
	}
	return nil
}

func (r *Repository) Statistics(ctx context.Context) (effectshadowstore.Statistics, error) {
	var result effectshadowstore.Statistics
	err := r.pool.QueryRow(ctx, statisticsSQL).Scan(
		&result.Heads, &result.Observations, &result.Receipts, &result.OutboxPending, &result.ReconciliationPending,
	)
	if err != nil {
		return result, databaseFailure("read effect statistics", err)
	}
	return result, nil
}

func readOutbox(row rowScanner) (effectshadowstore.OutboxRead, error) {
	var result effectshadowstore.OutboxRead
	var exact, observationHash, payloadHash []byte
	var eventType, operation string
	var recorded time.Time
	if err := row.Scan(
		&result.EventID, &eventType, &result.WorkspaceID, &result.RunID,
		&result.OccurrenceID, &result.ApprovalID, &result.SourceSequence, &operation,
		&result.ObservationID, &observationHash, &payloadHash, &exact, &recorded,
	); err != nil {
		return result, err
	}
	if len(observationHash) != sha256.Size || len(payloadHash) != sha256.Size || len(exact) == 0 || len(exact) > effectshadowstore.MaxOutboxBytes {
		return result, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect outbox framing is invalid", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(exact))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result.Payload); err != nil {
		return result, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect outbox payload is invalid", err)
	}
	if err := requireEOF(decoder); err != nil {
		return result, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect outbox payload has trailing data", err)
	}
	canonical, err := canonicaljson.Encode(result.Payload)
	digest := sha256.Sum256(exact)
	result.Schema = effectshadowstore.OutboxReadSchema
	result.Status = "pending"
	result.EventType = effectshadowstore.OutboxEventType(eventType)
	result.Operation = effectshadowstore.Operation(operation)
	result.ObservationHash = hex.EncodeToString(observationHash)
	result.PayloadHash = hex.EncodeToString(payloadHash)
	result.RecordedAt = recorded.UTC().Format(timeLayout)
	result.CursorRecordedAt = recorded.UTC()
	if err != nil || !bytes.Equal(canonical, exact) || !bytes.Equal(digest[:], payloadHash) {
		return result, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect outbox canonical bytes are invalid", err)
	}
	if err := effectshadowstore.ValidateOutboxRead(result); err != nil {
		return result, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect outbox columns do not match exact payload", err)
	}
	return result, nil
}

func (r *Repository) resolveCommitOutcome(input effectshadowstore.ObserveInput, fingerprint []byte, commitErr error) (effectshadowstore.Receipt, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
	defer cancel()
	receipt, raw, err := readReceipt(r.pool.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	if err == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) == 1 {
			return receipt, nil
		}
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorIdempotencyConflict, "commit recovery fingerprint conflict", commitErr)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return effectshadowstore.Receipt{}, mapReadFailure("recover effect commit", err)
	}
	if r.beforeReconcileLock != nil {
		r.beforeReconcileLock()
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorCommitUnknown, "begin effect reconciliation", errors.Join(commitErr, err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	o := input.Prepared.Envelope.Observation
	if err := lockScope(ctx, tx, input.IdempotencyKey, o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID); err != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorCommitUnknown, "lock effect reconciliation", errors.Join(commitErr, err))
	}
	receipt, raw, err = readReceipt(tx.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	if err == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) == 1 {
			return receipt, nil
		}
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorIdempotencyConflict, "commit recovery fingerprint conflict", commitErr)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorCommitUnknown, "reread effect reconciliation receipt", errors.Join(commitErr, err))
	}
	token, tokenErr := randomToken("wces-reconciliation")
	receiptID, receiptIDErr := randomToken("wces-receipt")
	if tokenErr != nil || receiptIDErr != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorCommitUnknown, "generate effect reconciliation identity", errors.Join(commitErr, tokenErr, receiptIDErr))
	}
	value := effectshadowstore.ReceiptValue{
		Schema: effectshadowstore.ReceiptSchema, Status: "reconciliation_required",
		IdempotencyKey: input.IdempotencyKey, ReceiptID: receiptID,
		WorkspaceID: o.WorkspaceID, RunID: o.RunID, OccurrenceID: o.OccurrenceID,
		ApprovalID: o.ApprovalID, SourceSequence: input.Prepared.Envelope.SourceSequence,
		Operation: input.Prepared.Envelope.Operation, Parity: "unknown",
		EnvelopeHash:     input.Prepared.EnvelopeHash,
		ObservationHash:  input.Prepared.Envelope.ObservationHash,
		ServiceBuildHash: input.ServiceBuildHash, ReconciliationToken: &token,
	}
	if validationErr := effectshadowstore.ValidateReceiptValue(value); validationErr != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorCommitUnknown, "construct effect reconciliation receipt", errors.Join(commitErr, validationErr))
	}
	exact, encodeErr := canonicaljson.Encode(value)
	if encodeErr != nil || len(exact) > effectshadowstore.MaxReceiptBytes {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorCommitUnknown, "encode effect reconciliation receipt", errors.Join(commitErr, encodeErr))
	}
	if _, err = tx.Exec(ctx, receiptInsertSQL,
		receiptID, input.IdempotencyKey, fingerprint, o.WorkspaceID, o.RunID, o.OccurrenceID,
		o.ApprovalID, input.Prepared.Envelope.SourceSequence, input.Prepared.Envelope.Operation,
		"reconciliation_required", "unknown", nil, nil,
		mustDecodeHash(input.Prepared.EnvelopeHash), mustDecodeHash(input.Prepared.Envelope.ObservationHash),
		mustDecodeHash(input.ServiceBuildHash), token, exact, nil,
	); err != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorCommitUnknown, "insert effect reconciliation receipt", errors.Join(commitErr, err))
	}
	errorHash := sha256.Sum256([]byte(commitErr.Error()))
	if _, err = tx.Exec(ctx, reconciliationInsertSQL,
		token, receiptID, input.IdempotencyKey, fingerprint, o.WorkspaceID, o.RunID,
		o.OccurrenceID, o.ApprovalID, input.Prepared.Envelope.SourceSequence,
		mustDecodeHash(input.Prepared.Envelope.ObservationHash), errorHash[:],
	); err != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorCommitUnknown, "persist effect reconciliation", errors.Join(commitErr, err))
	}
	commit := r.commitReconciliation
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commit(ctx, tx); err != nil {
		return effectshadowstore.Receipt{}, effectshadowstore.Failure(effectshadowstore.ErrorCommitUnknown, "effect reconciliation commit is unknown", errors.Join(commitErr, err))
	}
	return effectshadowstore.Receipt{Value: value, ExactBytes: exact}, nil
}

func readHead(row pgx.Row) (*effectshadowstore.Head, error) {
	var result effectshadowstore.Head
	var matchedSequence pgtype.Int8
	var matchedOperation, mismatchCode, latestOperation pgtype.Text
	var lastHash, matchedHash, matchedBody, build, latestHash, latestBody []byte
	var updated time.Time
	if err := row.Scan(
		&result.WorkspaceID, &result.RunID, &result.OccurrenceID, &result.ApprovalID,
		&result.SourceSequence, &result.Operation, &lastHash,
		&matchedSequence, &matchedOperation, &matchedHash, &matchedBody,
		&result.MismatchLatched, &mismatchCode, &build, &updated,
		&latestOperation, &latestHash, &latestBody,
	); err != nil {
		return nil, err
	}
	if len(lastHash) != sha256.Size || len(build) != sha256.Size {
		return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head digest framing is invalid", nil)
	}
	result.Schema = effectshadowstore.HeadSchema
	result.LastObservationHash = hex.EncodeToString(lastHash)
	result.ServiceBuildHash = hex.EncodeToString(build)
	result.UpdatedAt = updated.UTC().Format(timeLayout)
	result.MismatchCode = textPointer(mismatchCode)
	if !latestOperation.Valid || len(latestHash) != sha256.Size || len(latestBody) == 0 {
		return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head latest observation is missing", nil)
	}
	latest, latestErr := canonicalObservation(latestBody)
	latestWantHash := effectObservationHash(latestBody)
	if latestErr != nil || !bytes.Equal(latestHash, mustDecodeHash(latestWantHash)) || latestWantHash != result.LastObservationHash || effectshadowstore.Operation(latestOperation.String) != result.Operation || latest.WorkspaceID != result.WorkspaceID || latest.RunID != result.RunID || latest.OccurrenceID != result.OccurrenceID || latest.ApprovalID != result.ApprovalID {
		return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head latest observation is invalid", latestErr)
	}
	if validationErr := effectshadowstore.ValidateStoredObservation(result.Operation, result.SourceSequence, latest, latestWantHash); validationErr != nil {
		return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head latest contract is invalid", validationErr)
	}
	if matchedSequence.Valid {
		value := matchedSequence.Int64
		result.MatchedSourceSequence = &value
	}
	if matchedOperation.Valid {
		value := effectshadowstore.Operation(matchedOperation.String)
		result.MatchedOperation = &value
	}
	if len(matchedHash) == 0 && len(matchedBody) == 0 {
		if result.MatchedSourceSequence != nil || result.MatchedOperation != nil || !result.MismatchLatched {
			return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head matched prefix is incomplete", nil)
		}
		return &result, nil
	}
	if len(matchedHash) != sha256.Size || len(matchedBody) == 0 || result.MatchedSourceSequence == nil || result.MatchedOperation == nil {
		return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head matched framing is invalid", nil)
	}
	observation, err := canonicalObservation(matchedBody)
	wantHash := effectObservationHash(matchedBody)
	if err != nil || !bytes.Equal(matchedHash, mustDecodeHash(wantHash)) || observation.WorkspaceID != result.WorkspaceID || observation.RunID != result.RunID || observation.OccurrenceID != result.OccurrenceID || observation.ApprovalID != result.ApprovalID {
		return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head matched observation is invalid", err)
	}
	if validationErr := effectshadowstore.ValidateStoredObservation(*result.MatchedOperation, *result.MatchedSourceSequence, observation, wantHash); validationErr != nil {
		return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head contract is invalid", validationErr)
	}
	result.MatchedObservationHash = &wantHash
	result.Observation = &observation
	if !result.MismatchLatched && (result.SourceSequence != *result.MatchedSourceSequence || result.Operation != *result.MatchedOperation || result.LastObservationHash != wantHash || result.MismatchCode != nil) {
		return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head live prefix is inconsistent", nil)
	}
	if result.MismatchLatched && result.MismatchCode == nil {
		return nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect head mismatch has no code", nil)
	}
	return &result, nil
}

type rowScanner interface{ Scan(...any) error }

func readReceipt(row rowScanner) (effectshadowstore.Receipt, []byte, error) {
	var exact, fingerprint, envelopeHash, observationHash, build []byte
	var receiptID, workspace, run, occurrence, approval, key string
	var sequence int64
	var operation, status, parity string
	var mismatch, observationID, reconciliation pgtype.Text
	var committed pgtype.Timestamptz
	if err := row.Scan(
		&receiptID, &key, &fingerprint, &workspace, &run, &occurrence, &approval,
		&sequence, &operation, &status, &parity, &mismatch, &observationID,
		&envelopeHash, &observationHash, &build, &reconciliation, &exact, &committed,
	); err != nil {
		return effectshadowstore.Receipt{}, nil, err
	}
	if len(fingerprint) != sha256.Size || len(envelopeHash) != sha256.Size || len(observationHash) != sha256.Size || len(build) != sha256.Size || len(exact) == 0 || len(exact) > effectshadowstore.MaxReceiptBytes {
		return effectshadowstore.Receipt{}, nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect receipt framing is invalid", nil)
	}
	var value effectshadowstore.ReceiptValue
	decoder := json.NewDecoder(bytes.NewReader(exact))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return effectshadowstore.Receipt{}, nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect receipt is invalid", err)
	}
	if err := requireEOF(decoder); err != nil {
		return effectshadowstore.Receipt{}, nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect receipt has trailing data", err)
	}
	canonical, err := canonicaljson.Encode(value)
	if validationErr := effectshadowstore.ValidateReceiptValue(value); validationErr != nil {
		return effectshadowstore.Receipt{}, nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect receipt contract is invalid", validationErr)
	}
	wantMismatch := textPointer(mismatch)
	wantObservation := textPointer(observationID)
	wantReconciliation := textPointer(reconciliation)
	wantCommitted := timePointer(committed)
	if err != nil || !bytes.Equal(canonical, exact) || value.ReceiptID != receiptID || value.IdempotencyKey != key || value.WorkspaceID != workspace || value.RunID != run || value.OccurrenceID != occurrence || value.ApprovalID != approval || value.SourceSequence != sequence || string(value.Operation) != operation || value.Status != status || value.Parity != parity || !equalText(value.MismatchCode, wantMismatch) || !equalText(value.ObservationID, wantObservation) || !equalText(value.ReconciliationToken, wantReconciliation) || value.EnvelopeHash != hex.EncodeToString(envelopeHash) || value.ObservationHash != hex.EncodeToString(observationHash) || value.ServiceBuildHash != hex.EncodeToString(build) || !equalText(value.CommittedAt, wantCommitted) {
		return effectshadowstore.Receipt{}, nil, effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "stored effect receipt columns do not match exact bytes", err)
	}
	return effectshadowstore.Receipt{Value: value, ExactBytes: exact}, fingerprint, nil
}

func canonicalObservation(body []byte) (effectshadowstore.Observation, error) {
	var value effectshadowstore.Observation
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	if err := requireEOF(decoder); err != nil {
		return value, err
	}
	canonical, err := canonicaljson.Encode(value)
	if err != nil || !bytes.Equal(canonical, body) {
		return value, fmt.Errorf("observation bytes are not canonical")
	}
	if err := effectshadowstore.ValidateObservation(value); err != nil {
		return value, err
	}
	return value, nil
}

func effectObservationHash(canonical []byte) string {
	digest := sha256.New()
	_, _ = fmt.Fprintf(digest, "openslack.workflow-effect-control.observation.v1%c", byte(0))
	_, _ = digest.Write(canonical)
	return hex.EncodeToString(digest.Sum(nil))
}

func lockScope(ctx context.Context, tx pgx.Tx, key, workspace, run, occurrence, approval string) error {
	for _, lock := range []struct {
		value string
		salt  int64
	}{
		{value: key, salt: idempotencyLockSalt},
		{value: approvalScopeKey(workspace, run, occurrence, approval), salt: approvalLockSalt},
	} {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, lock.value, lock.salt); err != nil {
			return databaseFailure("lock effect scope", err)
		}
	}
	return nil
}

func approvalScopeKey(values ...string) string {
	result := ""
	for _, value := range values {
		result += strconv.Itoa(len(value)) + ":" + value
	}
	return result
}

func randomToken(prefix string) (string, error) {
	raw := make([]byte, 18)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return prefix + "-" + base64.RawURLEncoding.EncodeToString(raw), nil
}

func validIdempotency(value string) bool {
	return len(value) == len(effectshadowstore.IdempotencyPrefix)+64 && value[:len(effectshadowstore.IdempotencyPrefix)] == effectshadowstore.IdempotencyPrefix && isHash(value[len(effectshadowstore.IdempotencyPrefix):])
}

func isHash(value string) bool { _, err := decodeHash(value); return err == nil }

func decodeHash(value string) ([]byte, error) {
	raw, err := hex.DecodeString(value)
	if err != nil || len(raw) != sha256.Size || hex.EncodeToString(raw) != value {
		return nil, fmt.Errorf("digest must be 64 lowercase hexadecimal characters")
	}
	return raw, nil
}

func mustDecodeHash(value string) []byte { raw, _ := decodeHash(value); return raw }
func nullableMismatch(value string) any {
	if value == "" {
		return nil
	}
	return value
}
func mismatchPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func textPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}
func timePointer(value pgtype.Timestamptz) *string {
	if !value.Valid {
		return nil
	}
	result := value.Time.UTC().Format(timeLayout)
	return &result
}
func equalText(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	return fmt.Errorf("multiple JSON values")
}

func databaseFailure(operation string, err error) error {
	return effectshadowstore.Failure(effectshadowstore.ErrorDatabase, operation, err)
}
func mapReadFailure(operation string, err error) error {
	if effectshadowstore.IsCode(err, effectshadowstore.ErrorIntegrity) {
		return err
	}
	return databaseFailure(operation, err)
}
func classifyWrite(operation string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23514" || pgErr.Code == "P0001") {
		return effectshadowstore.Failure(effectshadowstore.ErrorConflict, operation, err)
	}
	return databaseFailure(operation, err)
}

const timeLayout = "2006-01-02T15:04:05.000Z"

const headSelectColumns = `h.workspace_id,h.run_id,h.occurrence_id,h.approval_id,h.last_source_sequence,h.last_operation,h.last_observation_hash,h.matched_source_sequence,h.matched_operation,h.matched_observation_hash,h.exact_matched_observation_bytes,h.mismatch_latched,h.mismatch_code,h.service_build_hash,h.updated_at,o.operation,o.observation_hash,o.exact_observation_bytes`
const headJoinSQL = ` FROM workflow_control_effect_shadow_heads h LEFT JOIN workflow_control_effect_shadow_observations o ON o.workspace_id=h.workspace_id AND o.run_id=h.run_id AND o.occurrence_id=h.occurrence_id AND o.approval_id=h.approval_id AND o.source_sequence=h.last_source_sequence WHERE h.workspace_id=$1 AND h.run_id=$2 AND h.occurrence_id=$3 AND h.approval_id=$4`
const headForUpdateSQL = `SELECT ` + headSelectColumns + headJoinSQL + ` FOR UPDATE OF h`
const headSQL = `SELECT ` + headSelectColumns + headJoinSQL
const headInsertSQL = `INSERT INTO workflow_control_effect_shadow_heads (workspace_id,run_id,occurrence_id,approval_id,last_source_sequence,last_operation,last_observation_hash,matched_source_sequence,matched_operation,matched_observation_hash,exact_matched_observation_bytes,mismatch_latched,mismatch_code,service_build_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`
const headUpdateSQL = `UPDATE workflow_control_effect_shadow_heads SET last_source_sequence=$5,last_operation=$6,last_observation_hash=$7,matched_source_sequence=$8,matched_operation=$9,matched_observation_hash=$10,exact_matched_observation_bytes=$11,mismatch_latched=$12,mismatch_code=$13,service_build_hash=$14,updated_at=clock_timestamp() WHERE workspace_id=$1 AND run_id=$2 AND occurrence_id=$3 AND approval_id=$4`
const observationInsertSQL = `INSERT INTO workflow_control_effect_shadow_observations (observation_id,workspace_id,run_id,occurrence_id,approval_id,source_sequence,operation,parity,mismatch_code,envelope_hash,exact_envelope_bytes,observation_hash,exact_observation_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`
const outboxInsertSQL = `INSERT INTO workflow_control_effect_shadow_outbox (event_id,event_type,workspace_id,run_id,occurrence_id,approval_id,source_sequence,operation,observation_id,observation_hash,payload_hash,canonical_payload_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`
const outboxPendingSQL = `SELECT event_id,event_type,workspace_id,run_id,occurrence_id,approval_id,source_sequence,operation,observation_id,observation_hash,payload_hash,canonical_payload_bytes,recorded_at FROM workflow_control_effect_shadow_outbox WHERE workspace_id=$1 AND status='pending' AND ($3::timestamptz IS NULL OR (recorded_at,event_id)>($3,$4)) ORDER BY recorded_at,event_id LIMIT $2`
const receiptInsertSQL = `INSERT INTO workflow_control_effect_shadow_receipts (receipt_id,idempotency_key,request_fingerprint,workspace_id,run_id,occurrence_id,approval_id,source_sequence,operation,status,parity,mismatch_code,observation_id,envelope_hash,observation_hash,service_build_hash,reconciliation_token,exact_receipt_bytes,committed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`
const receiptSelectColumns = `receipt_id,idempotency_key,request_fingerprint,workspace_id,run_id,occurrence_id,approval_id,source_sequence,operation,status,parity,mismatch_code,observation_id,envelope_hash,observation_hash,service_build_hash,reconciliation_token,exact_receipt_bytes,committed_at`
const receiptByKeySQL = `SELECT ` + receiptSelectColumns + ` FROM workflow_control_effect_shadow_receipts WHERE idempotency_key=$1`
const receiptByWorkspaceKeySQL = `SELECT ` + receiptSelectColumns + ` FROM workflow_control_effect_shadow_receipts WHERE workspace_id=$1 AND idempotency_key=$2`
const reconciliationOpenSQL = `SELECT EXISTS (SELECT 1 FROM workflow_control_effect_shadow_reconciliations WHERE workspace_id=$1 AND run_id=$2 AND occurrence_id=$3 AND approval_id=$4 AND status='open')`
const reconciliationInsertSQL = `INSERT INTO workflow_control_effect_shadow_reconciliations (reconciliation_token,receipt_id,idempotency_key,request_fingerprint,workspace_id,run_id,occurrence_id,approval_id,source_sequence,observation_hash,commit_error_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`
const statisticsSQL = `SELECT (SELECT count(*) FROM workflow_control_effect_shadow_heads),(SELECT count(*) FROM workflow_control_effect_shadow_observations),(SELECT count(*) FROM workflow_control_effect_shadow_receipts),(SELECT count(*) FROM workflow_control_effect_shadow_outbox WHERE status='pending'),(SELECT count(*) FROM workflow_control_effect_shadow_reconciliations WHERE status='open')`
