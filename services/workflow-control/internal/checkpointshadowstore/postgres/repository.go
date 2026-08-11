// Package postgres persists the GS9-C checkpoint shadow independently from
// every authority and runner table.
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
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointshadowstore"
)

const idempotencyLockSalt int64 = 628239560154301
const runLockSalt int64 = 628239560154302
const reconciliationTimeout = 5 * time.Second

type Repository struct {
	pool                 *pgxpool.Pool
	commit               func(context.Context, pgx.Tx) error
	commitReconciliation func(context.Context, pgx.Tx) error
}

func New(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

// NewWithCommitter injects the commit boundary. The callback must end the
// transaction: nil only after Commit; an error after Commit models response
// loss, while an error after Rollback models an unknown outcome.
func NewWithCommitter(pool *pgxpool.Pool, commit func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commit: commit}
}
func NewWithCommitters(pool *pgxpool.Pool, commit, reconciliation func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commit: commit, commitReconciliation: reconciliation}
}

func (r *Repository) Observe(ctx context.Context, input checkpointshadowstore.ObserveInput) (checkpointshadowstore.Receipt, error) {
	fingerprint, err := decodeHash(input.RequestFingerprint)
	if err != nil || !validIdempotency(input.IdempotencyKey) {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorInputInvalid, "observation identity is invalid", err)
	}
	build, err := decodeHash(input.ServiceBuildHash)
	if err != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorInputInvalid, "service build hash is invalid", err)
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return checkpointshadowstore.Receipt{}, databaseFailure("begin checkpoint observation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	o := input.Prepared.Envelope.Observation
	if err := lockScope(ctx, tx, input.IdempotencyKey, o.Runner.WorkspaceID, o.RunID); err != nil {
		return checkpointshadowstore.Receipt{}, err
	}
	existing, rawFingerprint, err := readReceipt(tx.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	if err == nil {
		if subtle.ConstantTimeCompare(rawFingerprint, fingerprint) != 1 {
			return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIdempotencyConflict, "idempotency key is bound to another observation", nil)
		}
		existing.Replay = true
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return checkpointshadowstore.Receipt{}, mapReadFailure("read checkpoint receipt", err)
	}
	var reconciliationOpen bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workflow_control_checkpoint_shadow_reconciliations WHERE workspace_id=$1 AND run_id=$2 AND status='open')`, o.Runner.WorkspaceID, o.RunID).Scan(&reconciliationOpen); err != nil {
		return checkpointshadowstore.Receipt{}, databaseFailure("read checkpoint reconciliation gate", err)
	}
	if reconciliationOpen {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorConflict, "checkpoint run has an open reconciliation", nil)
	}
	previous, err := readHead(tx.QueryRow(ctx, headForUpdateSQL, o.Runner.WorkspaceID, o.RunID))
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return checkpointshadowstore.Receipt{}, mapReadFailure("read checkpoint head", err)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		previous = nil
	}
	if previous == nil && input.Prepared.Envelope.SourceSequence != 1 {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorConflict, "first checkpoint source sequence must be one", nil)
	}
	if previous != nil && input.Prepared.Envelope.SourceSequence != previous.SourceSequence+1 {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorConflict, "checkpoint source sequence is not contiguous", nil)
	}
	parity, mismatch := checkpointshadowstore.Compare(input.Prepared.Envelope, previous)
	observationID, err := randomToken("wccs-observation")
	if err != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorDatabase, "generate observation identity", err)
	}
	receiptID, err := randomToken("wccs-receipt")
	if err != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorDatabase, "generate receipt identity", err)
	}
	envelopeHash := mustDecodeHash(input.Prepared.EnvelopeHash)
	observationHash := mustDecodeHash(input.Prepared.Envelope.ObservationHash)
	if _, err := tx.Exec(ctx, observationInsertSQL, observationID, o.Runner.WorkspaceID, o.RunID, input.Prepared.Envelope.SourceSequence, input.Prepared.Envelope.Operation, parity, nullableMismatch(mismatch), envelopeHash, input.Prepared.ExactBody, observationHash, input.Prepared.ObservationBytes); err != nil {
		return checkpointshadowstore.Receipt{}, classifyWrite("insert checkpoint observation", err)
	}
	if err := writeHead(ctx, tx, previous, input.Prepared, parity == "matched"); err != nil {
		return checkpointshadowstore.Receipt{}, err
	}
	var committed time.Time
	if err := tx.QueryRow(ctx, `SELECT date_trunc('milliseconds', clock_timestamp())`).Scan(&committed); err != nil {
		return checkpointshadowstore.Receipt{}, databaseFailure("read checkpoint commit time", err)
	}
	committedText := committed.UTC().Format("2006-01-02T15:04:05.000Z")
	value := checkpointshadowstore.ReceiptValue{Schema: checkpointshadowstore.ReceiptSchema, Status: "accepted", IdempotencyKey: input.IdempotencyKey, ReceiptID: receiptID, ObservationID: &observationID, WorkspaceID: o.Runner.WorkspaceID, RunID: o.RunID, SourceSequence: input.Prepared.Envelope.SourceSequence, Operation: input.Prepared.Envelope.Operation, Parity: parity, MismatchCode: mismatchPointer(mismatch), EnvelopeHash: input.Prepared.EnvelopeHash, ObservationHash: input.Prepared.Envelope.ObservationHash, ServiceBuildHash: input.ServiceBuildHash, CommittedAt: &committedText}
	if err := checkpointshadowstore.ValidateReceiptValue(value); err != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "construct checkpoint receipt", err)
	}
	exact, err := canonicaljson.Encode(value)
	if err != nil || len(exact) > checkpointshadowstore.MaxReceiptBytes {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "encode exact checkpoint receipt", err)
	}
	if _, err := tx.Exec(ctx, receiptInsertSQL, receiptID, input.IdempotencyKey, fingerprint, o.Runner.WorkspaceID, o.RunID, input.Prepared.Envelope.SourceSequence, input.Prepared.Envelope.Operation, "accepted", parity, nullableMismatch(mismatch), observationID, envelopeHash, observationHash, build, nil, exact, committed); err != nil {
		return checkpointshadowstore.Receipt{}, classifyWrite("insert checkpoint receipt", err)
	}
	result := checkpointshadowstore.Receipt{Value: value, ExactBytes: exact}
	commit := r.commit
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commit(ctx, tx); err != nil {
		return r.resolveCommitOutcome(input, fingerprint, err)
	}
	return result, nil
}

func writeHead(ctx context.Context, tx pgx.Tx, previous *checkpointshadowstore.Head, prepared checkpointshadowstore.PreparedObservation, matched bool) error {
	o, sequence := prepared.Envelope.Observation, prepared.Envelope.SourceSequence
	if previous == nil {
		var matchedSequence any
		var hash any
		var body any
		if matched {
			matchedSequence, hash, body = sequence, mustDecodeHash(prepared.Envelope.ObservationHash), prepared.ObservationBytes
		}
		_, err := tx.Exec(ctx, `INSERT INTO workflow_control_checkpoint_shadow_heads (workspace_id,run_id,source_sequence,operation,matched_source_sequence,mismatch_latched,observation_hash,exact_observation_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, o.Runner.WorkspaceID, o.RunID, sequence, prepared.Envelope.Operation, matchedSequence, !matched, hash, body)
		if err != nil {
			return classifyWrite("insert checkpoint head", err)
		}
		return nil
	}
	matchedSequence, hash, body := previous.MatchedSourceSequence, any(nil), any(nil)
	headOperation := previous.Operation
	if previous.ObservationHash != nil {
		hash = mustDecodeHash(*previous.ObservationHash)
		encoded, err := canonicaljson.Encode(previous.Observation)
		if err != nil {
			return checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "encode stored checkpoint head", err)
		}
		body = encoded
	}
	if matched {
		matchedSequence, hash, body = &sequence, mustDecodeHash(prepared.Envelope.ObservationHash), prepared.ObservationBytes
		headOperation = prepared.Envelope.Operation
	}
	_, err := tx.Exec(ctx, `UPDATE workflow_control_checkpoint_shadow_heads SET source_sequence=$3,operation=$4,matched_source_sequence=$5,mismatch_latched=$6,observation_hash=$7,exact_observation_bytes=$8,updated_at=clock_timestamp() WHERE workspace_id=$1 AND run_id=$2`, o.Runner.WorkspaceID, o.RunID, sequence, headOperation, matchedSequence, previous.MismatchLatched || !matched, hash, body)
	if err != nil {
		return classifyWrite("update checkpoint head", err)
	}
	return nil
}

func (r *Repository) ReadHead(ctx context.Context, workspaceID, runID string) (checkpointshadowstore.Head, error) {
	head, err := readHead(r.pool.QueryRow(ctx, headSQL, workspaceID, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return checkpointshadowstore.Head{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorNotFound, "checkpoint head not found", err)
	}
	if err != nil {
		return checkpointshadowstore.Head{}, mapReadFailure("read checkpoint head", err)
	}
	return *head, nil
}
func (r *Repository) ReadReceipt(ctx context.Context, workspaceID, key string) (checkpointshadowstore.Receipt, error) {
	receipt, _, err := readReceipt(r.pool.QueryRow(ctx, receiptByWorkspaceKeySQL, workspaceID, key))
	if errors.Is(err, pgx.ErrNoRows) {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorNotFound, "checkpoint receipt not found", err)
	}
	if err != nil {
		return checkpointshadowstore.Receipt{}, mapReadFailure("read checkpoint receipt", err)
	}
	return receipt, nil
}
func (r *Repository) Ready(ctx context.Context) error {
	var one int
	if err := r.pool.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil || one != 1 {
		return databaseFailure("checkpoint repository readiness", err)
	}
	return nil
}
func (r *Repository) Statistics(ctx context.Context) (checkpointshadowstore.Statistics, error) {
	var s checkpointshadowstore.Statistics
	err := r.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM workflow_control_checkpoint_shadow_heads),(SELECT count(*) FROM workflow_control_checkpoint_shadow_observations),(SELECT count(*) FROM workflow_control_checkpoint_shadow_receipts),(SELECT count(*) FROM workflow_control_checkpoint_shadow_reconciliations WHERE status='open')`).Scan(&s.Runs, &s.Observations, &s.Receipts, &s.ReconciliationPending)
	if err != nil {
		return s, databaseFailure("read checkpoint statistics", err)
	}
	return s, nil
}

func (r *Repository) resolveCommitOutcome(input checkpointshadowstore.ObserveInput, fingerprint []byte, commitErr error) (checkpointshadowstore.Receipt, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
	defer cancel()
	receipt, raw, err := readReceipt(r.pool.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	if err == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) == 1 {
			return receipt, nil
		}
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIdempotencyConflict, "commit recovery fingerprint conflict", commitErr)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return checkpointshadowstore.Receipt{}, mapReadFailure("recover checkpoint commit", err)
	}
	token, tokenErr := randomToken("wccs-reconciliation")
	if tokenErr != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorCommitUnknown, "generate checkpoint reconciliation", errors.Join(commitErr, tokenErr))
	}
	receiptID, receiptIDErr := randomToken("wccs-receipt")
	if receiptIDErr != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorCommitUnknown, "generate checkpoint reconciliation receipt", errors.Join(commitErr, receiptIDErr))
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorCommitUnknown, "begin checkpoint reconciliation", errors.Join(commitErr, err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	o := input.Prepared.Envelope.Observation
	if err := lockScope(ctx, tx, input.IdempotencyKey, o.Runner.WorkspaceID, o.RunID); err != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorCommitUnknown, "lock checkpoint reconciliation", errors.Join(commitErr, err))
	}
	value := checkpointshadowstore.ReceiptValue{Schema: checkpointshadowstore.ReceiptSchema, Status: "reconciliation_required", IdempotencyKey: input.IdempotencyKey, ReceiptID: receiptID, WorkspaceID: o.Runner.WorkspaceID, RunID: o.RunID, SourceSequence: input.Prepared.Envelope.SourceSequence, Operation: input.Prepared.Envelope.Operation, Parity: "unknown", EnvelopeHash: input.Prepared.EnvelopeHash, ObservationHash: input.Prepared.Envelope.ObservationHash, ServiceBuildHash: input.ServiceBuildHash, ReconciliationToken: &token}
	if validationErr := checkpointshadowstore.ValidateReceiptValue(value); validationErr != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorCommitUnknown, "construct checkpoint reconciliation receipt", errors.Join(commitErr, validationErr))
	}
	exact, encodeErr := canonicaljson.Encode(value)
	if encodeErr != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorCommitUnknown, "encode checkpoint reconciliation receipt", errors.Join(commitErr, encodeErr))
	}
	_, err = tx.Exec(ctx, receiptInsertSQL, receiptID, input.IdempotencyKey, fingerprint, o.Runner.WorkspaceID, o.RunID, input.Prepared.Envelope.SourceSequence, input.Prepared.Envelope.Operation, "reconciliation_required", "unknown", nil, nil, mustDecodeHash(input.Prepared.EnvelopeHash), mustDecodeHash(input.Prepared.Envelope.ObservationHash), mustDecodeHash(input.ServiceBuildHash), token, exact, nil)
	if err != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorCommitUnknown, "insert checkpoint reconciliation receipt", errors.Join(commitErr, err))
	}
	errorHash := sha256.Sum256([]byte(commitErr.Error()))
	_, err = tx.Exec(ctx, `INSERT INTO workflow_control_checkpoint_shadow_reconciliations (reconciliation_token,receipt_id,idempotency_key,request_fingerprint,workspace_id,run_id,source_sequence,observation_hash,commit_error_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, token, receiptID, input.IdempotencyKey, fingerprint, o.Runner.WorkspaceID, o.RunID, input.Prepared.Envelope.SourceSequence, mustDecodeHash(input.Prepared.Envelope.ObservationHash), errorHash[:])
	if err != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorCommitUnknown, "persist checkpoint reconciliation", errors.Join(commitErr, err))
	}
	commit := r.commitReconciliation
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commit(ctx, tx); err != nil {
		return checkpointshadowstore.Receipt{}, checkpointshadowstore.Failure(checkpointshadowstore.ErrorCommitUnknown, "checkpoint reconciliation commit is unknown", errors.Join(commitErr, err))
	}
	return checkpointshadowstore.Receipt{Value: value, ExactBytes: exact}, nil
}

func readHead(row pgx.Row) (*checkpointshadowstore.Head, error) {
	var h checkpointshadowstore.Head
	var matched pgtype.Int8
	var hash, body []byte
	var updated time.Time
	if err := row.Scan(&h.WorkspaceID, &h.RunID, &h.SourceSequence, &h.Operation, &matched, &h.MismatchLatched, &hash, &body, &updated); err != nil {
		return nil, err
	}
	h.Schema, h.GoRole, h.UpdatedAt = checkpointshadowstore.HeadSchema, "observer_only", updated.UTC().Format("2006-01-02T15:04:05.000Z")
	if matched.Valid {
		value := matched.Int64
		h.MatchedSourceSequence = &value
	}
	if len(hash) == 0 && len(body) == 0 {
		return &h, nil
	}
	if len(hash) != sha256.Size || len(body) == 0 {
		return nil, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "stored checkpoint head framing is invalid", nil)
	}
	digest := sha256.Sum256(body)
	if !bytes.Equal(digest[:], hash) {
		return nil, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "stored checkpoint head hash is invalid", nil)
	}
	preparedBody, err := canonicalObservation(body)
	text := hex.EncodeToString(hash)
	if err != nil || preparedBody.RunID != h.RunID || preparedBody.Runner.WorkspaceID != h.WorkspaceID || h.MatchedSourceSequence == nil {
		return nil, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "stored checkpoint head is invalid", err)
	}
	if validationErr := checkpointshadowstore.ValidateStoredObservation(h.Operation, *h.MatchedSourceSequence, preparedBody, text); validationErr != nil {
		return nil, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "stored checkpoint head contract is invalid", validationErr)
	}
	h.Observation = &preparedBody
	h.ObservationHash = &text
	return &h, nil
}

type rowScanner interface{ Scan(...any) error }

func readReceipt(row rowScanner) (checkpointshadowstore.Receipt, []byte, error) {
	var exact, fingerprint, envelopeHash, observationHash, build []byte
	var receiptID, workspace, run, key string
	var sequence int64
	var operation, status, parity string
	var mismatch, observationID, reconciliation pgtype.Text
	var committed pgtype.Timestamptz
	if err := row.Scan(&receiptID, &key, &fingerprint, &workspace, &run, &sequence, &operation, &status, &parity, &mismatch, &observationID, &envelopeHash, &observationHash, &build, &reconciliation, &exact, &committed); err != nil {
		return checkpointshadowstore.Receipt{}, nil, err
	}
	if len(fingerprint) != sha256.Size || len(envelopeHash) != sha256.Size || len(observationHash) != sha256.Size || len(build) != sha256.Size || len(exact) == 0 {
		return checkpointshadowstore.Receipt{}, nil, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "stored checkpoint receipt framing is invalid", nil)
	}
	var value checkpointshadowstore.ReceiptValue
	decoder := json.NewDecoder(bytes.NewReader(exact))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return checkpointshadowstore.Receipt{}, nil, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "stored checkpoint receipt is invalid", err)
	}
	canonical, err := canonicaljson.Encode(value)
	if validationErr := checkpointshadowstore.ValidateReceiptValue(value); validationErr != nil {
		return checkpointshadowstore.Receipt{}, nil, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "stored checkpoint receipt contract is invalid", validationErr)
	}
	wantMismatch := textPointer(mismatch)
	wantObservation := textPointer(observationID)
	wantReconciliation := textPointer(reconciliation)
	wantCommitted := timePointer(committed)
	if err != nil || !bytes.Equal(canonical, exact) || value.Schema != checkpointshadowstore.ReceiptSchema || value.ReceiptID != receiptID || value.IdempotencyKey != key || value.WorkspaceID != workspace || value.RunID != run || value.SourceSequence != sequence || string(value.Operation) != operation || value.Status != status || value.Parity != parity || !equalText(value.MismatchCode, wantMismatch) || !equalText(value.ObservationID, wantObservation) || !equalText(value.ReconciliationToken, wantReconciliation) || value.EnvelopeHash != hex.EncodeToString(envelopeHash) || value.ObservationHash != hex.EncodeToString(observationHash) || value.ServiceBuildHash != hex.EncodeToString(build) || !equalText(value.CommittedAt, wantCommitted) {
		return checkpointshadowstore.Receipt{}, nil, checkpointshadowstore.Failure(checkpointshadowstore.ErrorIntegrity, "stored checkpoint receipt columns do not match exact bytes", err)
	}
	return checkpointshadowstore.Receipt{Value: value, ExactBytes: exact}, fingerprint, nil
}

func canonicalObservation(body []byte) (checkpointshadowstore.Observation, error) {
	var value checkpointshadowstore.Observation
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	canonical, err := canonicaljson.Encode(value)
	if err != nil || !bytes.Equal(canonical, body) {
		return value, fmt.Errorf("observation bytes are not canonical")
	}
	return value, nil
}
func lockScope(ctx context.Context, tx pgx.Tx, key, workspace, run string) error {
	for _, lock := range []struct {
		value string
		salt  int64
	}{
		{value: key, salt: idempotencyLockSalt},
		{value: checkpointRunLockKey(workspace, run), salt: runLockSalt},
	} {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, lock.value, lock.salt); err != nil {
			return databaseFailure("lock checkpoint scope", err)
		}
	}
	return nil
}

func checkpointRunLockKey(workspace, run string) string {
	return strconv.Itoa(len(workspace)) + ":" + workspace + strconv.Itoa(len(run)) + ":" + run
}
func randomToken(prefix string) (string, error) {
	raw := make([]byte, 18)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return prefix + "-" + base64.RawURLEncoding.EncodeToString(raw), nil
}
func validIdempotency(value string) bool {
	return len(value) == len(checkpointshadowstore.IdempotencyPrefix)+64 && len(value) > 64 && value[:len(checkpointshadowstore.IdempotencyPrefix)] == checkpointshadowstore.IdempotencyPrefix && isHash(value[len(checkpointshadowstore.IdempotencyPrefix):])
}
func isHash(value string) bool { _, err := decodeHash(value); return err == nil }
func decodeHash(value string) ([]byte, error) {
	raw, err := hex.DecodeString(value)
	if err != nil || len(raw) != sha256.Size {
		return nil, fmt.Errorf("digest must be 64 lowercase hexadecimal characters")
	}
	if hex.EncodeToString(raw) != value {
		return nil, fmt.Errorf("digest must be lowercase")
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
	result := value.Time.UTC().Format("2006-01-02T15:04:05.000Z")
	return &result
}
func equalText(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
func databaseFailure(operation string, err error) error {
	return checkpointshadowstore.Failure(checkpointshadowstore.ErrorDatabase, operation, err)
}
func mapReadFailure(operation string, err error) error {
	if checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorIntegrity) {
		return err
	}
	return databaseFailure(operation, err)
}
func classifyWrite(operation string, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23514" || pgErr.Code == "P0001") {
		return checkpointshadowstore.Failure(checkpointshadowstore.ErrorConflict, operation, err)
	}
	return databaseFailure(operation, err)
}

const headForUpdateSQL = `SELECT workspace_id,run_id,source_sequence,operation,matched_source_sequence,mismatch_latched,observation_hash,exact_observation_bytes,updated_at FROM workflow_control_checkpoint_shadow_heads WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE`
const headSQL = `SELECT workspace_id,run_id,source_sequence,operation,matched_source_sequence,mismatch_latched,observation_hash,exact_observation_bytes,updated_at FROM workflow_control_checkpoint_shadow_heads WHERE workspace_id=$1 AND run_id=$2`
const observationInsertSQL = `INSERT INTO workflow_control_checkpoint_shadow_observations (observation_id,workspace_id,run_id,source_sequence,operation,parity,mismatch_code,envelope_hash,exact_envelope_bytes,observation_hash,exact_observation_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`
const receiptInsertSQL = `INSERT INTO workflow_control_checkpoint_shadow_receipts (receipt_id,idempotency_key,request_fingerprint,workspace_id,run_id,source_sequence,operation,status,parity,mismatch_code,observation_id,envelope_hash,observation_hash,service_build_hash,reconciliation_token,exact_receipt_bytes,committed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`
const receiptByKeySQL = `SELECT receipt_id,idempotency_key,request_fingerprint,workspace_id,run_id,source_sequence,operation,status,parity,mismatch_code,observation_id,envelope_hash,observation_hash,service_build_hash,reconciliation_token,exact_receipt_bytes,committed_at FROM workflow_control_checkpoint_shadow_receipts WHERE idempotency_key=$1`
const receiptByWorkspaceKeySQL = `SELECT receipt_id,idempotency_key,request_fingerprint,workspace_id,run_id,source_sequence,operation,status,parity,mismatch_code,observation_id,envelope_hash,observation_hash,service_build_hash,reconciliation_token,exact_receipt_bytes,committed_at FROM workflow_control_checkpoint_shadow_receipts WHERE workspace_id=$1 AND idempotency_key=$2`
