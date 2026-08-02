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
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
)

const (
	idempotencyLockSalt   int64 = 738329560154101
	planLockSalt          int64 = 738329560154102
	reconciliationTimeout       = 5 * time.Second
)

type Repository struct {
	pool                   *pgxpool.Pool
	commitTransaction      func(context.Context, pgx.Tx) error
	commitAuditTransaction func(context.Context, pgx.Tx) error
}

func New(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

// NewWithCommitter constructs a repository with an injected mutation commit
// boundary. It exists so qualification can exercise ambiguous commit outcomes
// without weakening the production transaction path.
func NewWithCommitter(pool *pgxpool.Pool, commit func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commitTransaction: commit}
}

type head struct {
	exists      bool
	route       authoritystore.Route
	revision    int64
	state       governance.State
	recordHash  []byte
	recordBytes []byte
}

func (repository *Repository) Mutate(ctx context.Context, input authoritystore.MutateInput) (authoritystore.Receipt, error) {
	if err := validateInput(input); err != nil {
		return authoritystore.Receipt{}, err
	}
	fingerprint, _ := authoritystore.ParseFingerprint(input.RequestFingerprint)
	recordHash, _ := hex.DecodeString(input.Prepared.RecordHash)
	buildHash, _ := hex.DecodeString(input.ServiceBuildSHA)

	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return authoritystore.Receipt{}, databaseFailure("begin authority mutation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScope(ctx, tx, input.IdempotencyKey, input.Prepared.WorkspaceID, input.Prepared.PlanID); err != nil {
		return authoritystore.Receipt{}, err
	}
	existing, rawFingerprint, err := readReceipt(tx.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	switch {
	case err == nil:
		if subtle.ConstantTimeCompare(rawFingerprint, fingerprint[:]) != 1 {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorIdempotencyConflict, "idempotency key is bound to another request", nil)
		}
		if existing.Status == authoritystore.ReceiptAccepted {
			existing.Status = authoritystore.ReceiptDuplicate
		}
		return existing, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return authoritystore.Receipt{}, databaseFailure("read authority receipt", err)
	}
	if input.IdempotencyKey != authoritystore.ExpectedIdempotencyKey(input.Prepared.ExactBody) {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorInputInvalid, "Idempotency-Key does not bind the exact canonical body", nil)
	}
	if input.RequestFingerprint != authoritystore.RequestFingerprint("POST", authoritystore.RequestPath(input.Prepared.Operation, input.Prepared.PlanID), input.Prepared) {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorInputInvalid, "request fingerprint does not bind the canonical authority request", nil)
	}

	current, err := readHead(ctx, tx, input.Prepared.WorkspaceID, input.Prepared.PlanID)
	if err != nil {
		return authoritystore.Receipt{}, err
	}
	if input.Prepared.Operation == authoritystore.OperationAccept {
		if current.exists {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "plan route already exists", nil)
		}
		if err := authoritystore.ValidateInitial(input.Prepared); err != nil {
			return authoritystore.Receipt{}, err
		}
		if _, err := tx.Exec(ctx, routeInsertSQL, input.Prepared.WorkspaceID, input.Prepared.PlanID,
			input.Prepared.Route.Backend, input.Prepared.Route.Authority, input.Prepared.Route.RoutingEpoch); err != nil {
			return authoritystore.Receipt{}, mapWriteFailure("insert authority route", err)
		}
	} else {
		if !current.exists {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorNotFound, "persisted authority route was not found", nil)
		}
		if current.route != input.Prepared.Route {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "request route differs from the persisted record route", nil)
		}
		if input.Prepared.ExpectedRevision != current.revision {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "expected revision compare-and-swap failed", nil)
		}
		var auditPending bool
		if err := tx.QueryRow(ctx, pendingAuditExistsSQL, input.Prepared.WorkspaceID, input.Prepared.PlanID, current.revision).Scan(&auditPending); err != nil {
			return authoritystore.Receipt{}, databaseFailure("read previous authority audit delivery", err)
		}
		if auditPending {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "previous authority revision still requires its audit acknowledgement", nil)
		}
		if err := authoritystore.ValidateTransition(input.Prepared, current.recordBytes); err != nil {
			return authoritystore.Receipt{}, err
		}
	}

	if _, err := tx.Exec(ctx, versionInsertSQL, input.Prepared.WorkspaceID, input.Prepared.PlanID,
		input.Prepared.TargetRevision, string(input.Prepared.TargetState), recordHash,
		input.Prepared.RecordBytes, input.IdempotencyKey); err != nil {
		return authoritystore.Receipt{}, mapWriteFailure("insert authority record version", err)
	}
	if input.Prepared.Operation == authoritystore.OperationAccept {
		if _, err := tx.Exec(ctx, headInsertSQL, input.Prepared.WorkspaceID, input.Prepared.PlanID,
			input.Prepared.TargetRevision, string(input.Prepared.TargetState), recordHash, buildHash); err != nil {
			return authoritystore.Receipt{}, mapWriteFailure("insert authority head", err)
		}
	} else {
		tag, err := tx.Exec(ctx, headUpdateSQL, input.Prepared.WorkspaceID, input.Prepared.PlanID,
			input.Prepared.ExpectedRevision, input.Prepared.TargetRevision, string(input.Prepared.TargetState), recordHash, buildHash)
		if err != nil {
			return authoritystore.Receipt{}, mapWriteFailure("advance authority head", err)
		}
		if tag.RowsAffected() != 1 {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "authority head compare-and-swap lost", nil)
		}
	}

	receiptID, err := randomToken("gauthreceipt")
	if err != nil {
		return authoritystore.Receipt{}, databaseFailure("generate authority receipt id", err)
	}
	eventID, err := randomToken("gauthevent")
	if err != nil {
		return authoritystore.Receipt{}, databaseFailure("generate authority event id", err)
	}
	var committedAt, recordedAt time.Time
	if err := tx.QueryRow(ctx, receiptAcceptedInsertSQL,
		receiptID, string(input.Prepared.Operation), input.IdempotencyKey, fingerprint[:],
		input.Prepared.WorkspaceID, input.Prepared.PlanID, input.Prepared.ExpectedRevision,
		input.Prepared.TargetRevision, string(input.Prepared.TargetState), input.Prepared.Route.Backend,
		input.Prepared.Route.Authority, input.Prepared.Route.RoutingEpoch, recordHash,
		input.Prepared.CorrelationID, input.Prepared.CallerID, nullableString(input.Prepared.ExecutionID),
		buildHash, input.Prepared.RecordBytes,
	).Scan(&committedAt, &recordedAt); err != nil {
		return authoritystore.Receipt{}, mapWriteFailure("insert authority receipt", err)
	}
	if _, err := tx.Exec(ctx, eventInsertSQL, eventID, receiptID, string(input.Prepared.Operation),
		input.Prepared.WorkspaceID, input.Prepared.PlanID, input.Prepared.TargetRevision,
		string(input.Prepared.TargetState), recordHash); err != nil {
		return authoritystore.Receipt{}, mapWriteFailure("insert authority event", err)
	}
	if _, err := tx.Exec(ctx, auditDeliveryInsertSQL, receiptID, input.Prepared.WorkspaceID,
		input.Prepared.PlanID, input.Prepared.TargetRevision); err != nil {
		return authoritystore.Receipt{}, mapWriteFailure("insert pending authority audit delivery", err)
	}
	acceptedRevision := input.Prepared.TargetRevision
	receipt := authoritystore.Receipt{
		Schema: authoritystore.ReceiptSchema, Operation: input.Prepared.Operation, Status: authoritystore.ReceiptAccepted,
		WorkspaceID: input.Prepared.WorkspaceID, PlanID: input.Prepared.PlanID,
		ExpectedRevision: input.Prepared.ExpectedRevision, AcceptedRevision: &acceptedRevision,
		State: input.Prepared.TargetState, Route: input.Prepared.Route, IdempotencyKey: input.IdempotencyKey,
		RequestFingerprint: input.RequestFingerprint, RecordHash: input.Prepared.RecordHash,
		CorrelationID: input.Prepared.CorrelationID, CallerID: input.Prepared.CallerID,
		ExecutionID: input.Prepared.ExecutionID, ServiceBuildSHA: input.ServiceBuildSHA,
		RecordBytes: append([]byte(nil), input.Prepared.RecordBytes...), CommittedAt: &committedAt,
		ReceiptID: receiptID, RecordedAt: recordedAt,
	}
	commit := repository.commitTransaction
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commit(ctx, tx); err != nil {
		return repository.resolveCommitOutcome(input, fingerprint, recordHash, buildHash, err)
	}
	return receipt, nil
}

func validateInput(input authoritystore.MutateInput) error {
	if err := authoritystore.ValidateIdempotencyKey(input.IdempotencyKey); err != nil {
		return err
	}
	if input.ServiceBuildSHA != input.Prepared.ExpectedServiceBuild || len(input.ServiceBuildSHA) != 64 {
		return authoritystore.Failure(authoritystore.ErrorInputInvalid, "expected service build does not match the active service build", nil)
	}
	if _, err := authoritystore.ParseFingerprint(input.RequestFingerprint); err != nil {
		return err
	}
	if input.Prepared.Route.Backend != authoritystore.Backend || input.Prepared.Route.Authority != authoritystore.Authority {
		return authoritystore.Failure(authoritystore.ErrorInputInvalid, "request is not routed to the Go authority", nil)
	}
	return nil
}

func (repository *Repository) Read(ctx context.Context, workspaceID, planID string) (authoritystore.ReadResult, error) {
	if err := authoritystore.ValidateReadIdentity(workspaceID, planID); err != nil {
		return authoritystore.ReadResult{}, err
	}
	result := authoritystore.ReadResult{Schema: authoritystore.ReadSchema, WorkspaceID: workspaceID, PlanID: planID}
	if err := repository.pool.QueryRow(ctx, readSQL, workspaceID, planID).Scan(
		&result.Route.Backend, &result.Route.Authority, &result.Route.RoutingEpoch,
		&result.RecordHash, &result.RecordBytes, &result.ServiceBuildSHA,
	); errors.Is(err, pgx.ErrNoRows) {
		return authoritystore.ReadResult{}, authoritystore.Failure(authoritystore.ErrorNotFound, "authority record not found", err)
	} else if err != nil {
		return authoritystore.ReadResult{}, databaseFailure("read authority record", err)
	}
	if _, err := governance.ValidateCanonicalRecordBytes(result.RecordBytes); err != nil {
		return authoritystore.ReadResult{}, authoritystore.Failure(authoritystore.ErrorContentInvalid, "stored authority record is invalid", err)
	}
	return result, nil
}

func (repository *Repository) ReadReceipt(ctx context.Context, workspaceID, key string) (authoritystore.Receipt, error) {
	if err := authoritystore.ValidateReceiptIdentity(workspaceID, key); err != nil {
		return authoritystore.Receipt{}, err
	}
	receipt, _, err := readReceipt(repository.pool.QueryRow(ctx, receiptByWorkspaceKeySQL, key, workspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorNotFound, "authority receipt not found", err)
	}
	if err != nil {
		return authoritystore.Receipt{}, databaseFailure("read authority receipt", err)
	}
	return receipt, nil
}

func (repository *Repository) ReadPendingAudit(ctx context.Context, workspaceID, planID string, revision int64) (authoritystore.PendingAudit, error) {
	if err := authoritystore.ValidatePendingAuditIdentity(workspaceID, planID, revision); err != nil {
		return authoritystore.PendingAudit{}, err
	}
	result := authoritystore.PendingAudit{Schema: authoritystore.PendingAuditSchema, Status: "pending"}
	if err := repository.pool.QueryRow(ctx, pendingAuditReadSQL, workspaceID, planID, revision).Scan(
		&result.Operation, &result.WorkspaceID, &result.PlanID, &result.Revision,
		&result.Route.Backend, &result.Route.Authority, &result.Route.RoutingEpoch,
		&result.RecordHash, &result.ServiceBuildSHA,
	); errors.Is(err, pgx.ErrNoRows) {
		return authoritystore.PendingAudit{}, authoritystore.Failure(authoritystore.ErrorNotFound, "pending authority audit delivery not found", err)
	} else if err != nil {
		return authoritystore.PendingAudit{}, databaseFailure("read pending authority audit delivery", err)
	}
	return result, nil
}

func (repository *Repository) Statistics(ctx context.Context) (authoritystore.Statistics, error) {
	var result authoritystore.Statistics
	if err := repository.pool.QueryRow(ctx, statisticsSQL).Scan(&result.Plans, &result.Receipts, &result.ReconciliationPending, &result.AuditPending); err != nil {
		return authoritystore.Statistics{}, databaseFailure("read authority statistics", err)
	}
	return result, nil
}

func (repository *Repository) RecordAudit(ctx context.Context, input authoritystore.AuditInput) (authoritystore.AuditReceipt, error) {
	if err := authoritystore.ValidateAuditIdempotencyKey(input.IdempotencyKey); err != nil {
		return authoritystore.AuditReceipt{}, err
	}
	if input.IdempotencyKey != authoritystore.ExpectedAuditIdempotencyKey(input.Prepared.ExactBody) ||
		input.ServiceBuildSHA != input.Prepared.ExpectedServiceBuild {
		return authoritystore.AuditReceipt{}, authoritystore.Failure(authoritystore.ErrorInputInvalid, "audit request binding is invalid", nil)
	}
	fingerprint, err := authoritystore.ParseFingerprint(input.RequestFingerprint)
	if err != nil {
		return authoritystore.AuditReceipt{}, err
	}
	eventHash, err := hex.DecodeString(input.Prepared.EventHash)
	if err != nil {
		return authoritystore.AuditReceipt{}, authoritystore.Failure(authoritystore.ErrorInputInvalid, "audit event hash is invalid", err)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return authoritystore.AuditReceipt{}, databaseFailure("begin authority audit record", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScope(ctx, tx, input.IdempotencyKey, input.Prepared.WorkspaceID, input.Prepared.PlanID); err != nil {
		return authoritystore.AuditReceipt{}, err
	}
	var status string
	var routingEpoch int64
	var operation, state string
	var recordBytes []byte
	var recordedEventID, recordedKey pgtype.Text
	var recordedHash, recordedFingerprint []byte
	var recordedAt pgtype.Timestamptz
	if err := tx.QueryRow(ctx, auditDeliveryForUpdateSQL, input.Prepared.WorkspaceID, input.Prepared.PlanID, input.Prepared.Revision).Scan(
		&status, &routingEpoch, &operation, &state, &recordBytes, &recordedEventID,
		&recordedHash, &recordedKey, &recordedFingerprint, &recordedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return authoritystore.AuditReceipt{}, authoritystore.Failure(authoritystore.ErrorNotFound, "pending authority audit delivery was not found", err)
	} else if err != nil {
		return authoritystore.AuditReceipt{}, databaseFailure("lock authority audit delivery", err)
	}
	if routingEpoch != input.Prepared.RoutingEpoch {
		return authoritystore.AuditReceipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "audit routing epoch differs from persisted route", nil)
	}
	if status == "recorded" {
		if !recordedEventID.Valid || recordedEventID.String != input.Prepared.Event.EventID || !recordedKey.Valid || recordedKey.String != input.IdempotencyKey ||
			subtle.ConstantTimeCompare(recordedHash, eventHash) != 1 || subtle.ConstantTimeCompare(recordedFingerprint, fingerprint[:]) != 1 || !recordedAt.Valid {
			return authoritystore.AuditReceipt{}, authoritystore.Failure(authoritystore.ErrorIdempotencyConflict, "authority audit delivery is already bound to another event", nil)
		}
		return authoritystore.AuditReceipt{Schema: authoritystore.AuditReceiptSchema, Status: "duplicate",
			WorkspaceID: input.Prepared.WorkspaceID, PlanID: input.Prepared.PlanID, Revision: input.Prepared.Revision,
			EventID: input.Prepared.Event.EventID, EventHash: input.Prepared.EventHash, IdempotencyKey: input.IdempotencyKey,
			RequestFingerprint: input.RequestFingerprint, RecordedAt: recordedAt.Time}, nil
	}
	if input.RequestFingerprint != authoritystore.AuditRequestFingerprint("POST", authoritystore.AuditRequestPath(input.Prepared.PlanID, input.Prepared.Revision), input.Prepared) {
		return authoritystore.AuditReceipt{}, authoritystore.Failure(authoritystore.ErrorInputInvalid, "audit request fingerprint does not bind the canonical request", nil)
	}
	if err := validateAuditBinding(input.Prepared, authoritystore.Operation(operation), governance.State(state), recordBytes); err != nil {
		return authoritystore.AuditReceipt{}, err
	}
	var committedAt time.Time
	if err := tx.QueryRow(ctx, auditDeliveryRecordSQL, input.Prepared.WorkspaceID, input.Prepared.PlanID,
		input.Prepared.Revision, input.Prepared.Event.EventID, eventHash, input.Prepared.ExactBody,
		input.IdempotencyKey, fingerprint[:]).Scan(&committedAt); err != nil {
		return authoritystore.AuditReceipt{}, mapWriteFailure("record authority audit delivery", err)
	}
	commit := repository.commitAuditTransaction
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commit(ctx, tx); err != nil {
		return repository.resolveAuditCommitOutcome(input, eventHash, fingerprint, err)
	}
	return authoritystore.AuditReceipt{Schema: authoritystore.AuditReceiptSchema, Status: "recorded",
		WorkspaceID: input.Prepared.WorkspaceID, PlanID: input.Prepared.PlanID, Revision: input.Prepared.Revision,
		EventID: input.Prepared.Event.EventID, EventHash: input.Prepared.EventHash, IdempotencyKey: input.IdempotencyKey,
		RequestFingerprint: input.RequestFingerprint, RecordedAt: committedAt}, nil
}

func (repository *Repository) resolveAuditCommitOutcome(input authoritystore.AuditInput, eventHash []byte, fingerprint [sha256.Size]byte, commitErr error) (authoritystore.AuditReceipt, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
	defer cancel()
	var status string
	var eventID, key pgtype.Text
	var storedHash, storedFingerprint []byte
	var recordedAt pgtype.Timestamptz
	err := repository.pool.QueryRow(ctx, auditDeliveryReadSQL, input.Prepared.WorkspaceID, input.Prepared.PlanID, input.Prepared.Revision).Scan(
		&status, &eventID, &storedHash, &key, &storedFingerprint, &recordedAt,
	)
	if err == nil && status == "recorded" && eventID.Valid && eventID.String == input.Prepared.Event.EventID &&
		key.Valid && key.String == input.IdempotencyKey && subtle.ConstantTimeCompare(storedHash, eventHash) == 1 &&
		subtle.ConstantTimeCompare(storedFingerprint, fingerprint[:]) == 1 && recordedAt.Valid {
		return authoritystore.AuditReceipt{Schema: authoritystore.AuditReceiptSchema, Status: "recorded",
			WorkspaceID: input.Prepared.WorkspaceID, PlanID: input.Prepared.PlanID, Revision: input.Prepared.Revision,
			EventID: input.Prepared.Event.EventID, EventHash: input.Prepared.EventHash,
			IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint, RecordedAt: recordedAt.Time}, nil
	}
	return authoritystore.AuditReceipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "authority audit commit outcome is unknown", errors.Join(commitErr, err))
}

func validateAuditBinding(prepared authoritystore.PreparedAudit, operation authoritystore.Operation, state governance.State, recordBytes []byte) error {
	record, err := governance.ValidateCanonicalRecordBytes(recordBytes)
	if err != nil {
		return authoritystore.Failure(authoritystore.ErrorContentInvalid, "stored authority record is invalid", err)
	}
	projection, err := governance.Project(record)
	if err != nil || projection.Revision != int(prepared.Revision) || projection.State != state ||
		projection.ActorID != prepared.Event.ActorID || projection.Kind != prepared.Event.Kind ||
		projection.CorrelationID != prepared.Event.CorrelationID || prepared.Event.State != state {
		return authoritystore.Failure(authoritystore.ErrorContentInvalid, "audit event does not bind the accepted authority record", err)
	}
	recordDigest := sha256.Sum256(recordBytes)
	evaluation := shadowstore.EvaluateAudit(shadowstore.PreparedObservation{
		RecordHash: hex.EncodeToString(recordDigest[:]), Audit: &prepared.Event, AuditBytes: prepared.ExactBody,
	}, recordBytes)
	if evaluation.Parity != shadowstore.ParityMatched {
		return authoritystore.Failure(authoritystore.ErrorContentInvalid, "audit event parity validation failed: "+evaluation.MismatchCode, nil)
	}
	wantType := ""
	switch operation {
	case authoritystore.OperationAccept:
		wantType = "plan.previewed"
	case authoritystore.OperationClaimExecution:
		wantType = "plan.confirmed"
	case authoritystore.OperationCompleteExecution:
		switch state {
		case governance.StateSucceeded:
			wantType = "plan.execution_completed"
		case governance.StateBlocked:
			wantType = "plan.execution_blocked"
		case governance.StateFailed:
			wantType = "plan.execution_failed"
		}
	case authoritystore.OperationCancel:
		wantType = "plan.cancelled"
	case authoritystore.OperationExpire:
		wantType = "plan.expired"
	case authoritystore.OperationRequireReconciliation:
		wantType = "plan.reconciliation_required"
	}
	if prepared.Event.Type != wantType {
		return authoritystore.Failure(authoritystore.ErrorContentInvalid, "audit event type does not bind the authority operation", nil)
	}
	return nil
}

func readHead(ctx context.Context, tx pgx.Tx, workspaceID, planID string) (head, error) {
	var result head
	err := tx.QueryRow(ctx, headForUpdateSQL, workspaceID, planID).Scan(
		&result.route.Backend, &result.route.Authority, &result.route.RoutingEpoch,
		&result.revision, &result.state, &result.recordHash, &result.recordBytes,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return head{}, databaseFailure("lock authority plan head", err)
	}
	result.exists = true
	return result, nil
}

func (repository *Repository) resolveCommitOutcome(input authoritystore.MutateInput, fingerprint [sha256.Size]byte, recordHash, buildHash []byte, commitErr error) (authoritystore.Receipt, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
	defer cancel()
	existing, raw, err := repository.readReceiptByKey(ctx, input.IdempotencyKey)
	if err == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint[:]) == 1 {
			return existing, nil
		}
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorIdempotencyConflict, "commit recovery found another fingerprint", commitErr)
	}
	if !authoritystore.IsCode(err, authoritystore.ErrorNotFound) {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "commit outcome could not be read", errors.Join(commitErr, err))
	}
	receiptID, idErr := randomToken("gauthreceipt")
	eventID, eventErr := randomToken("gauthevent")
	token, tokenErr := randomToken("gauthreconcile")
	if idErr != nil || eventErr != nil || tokenErr != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "generate reconciliation identity", errors.Join(commitErr, idErr, eventErr, tokenErr))
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "begin reconciliation receipt", errors.Join(commitErr, err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScope(ctx, tx, input.IdempotencyKey, input.Prepared.WorkspaceID, input.Prepared.PlanID); err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "lock reconciliation receipt", errors.Join(commitErr, err))
	}
	if _, err := tx.Exec(ctx, receiptReconciliationInsertSQL,
		receiptID, string(input.Prepared.Operation), input.IdempotencyKey, fingerprint[:],
		input.Prepared.WorkspaceID, input.Prepared.PlanID, input.Prepared.ExpectedRevision,
		input.Prepared.TargetRevision, string(input.Prepared.TargetState), input.Prepared.Route.Backend,
		input.Prepared.Route.Authority, input.Prepared.Route.RoutingEpoch, recordHash,
		input.Prepared.CorrelationID, input.Prepared.CallerID, nullableString(input.Prepared.ExecutionID),
		buildHash, token,
	); err != nil && !isUniqueViolation(err) {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "insert reconciliation receipt", errors.Join(commitErr, err))
	}
	persisted, raw, err := readReceipt(tx.QueryRow(ctx, receiptByKeySQL, input.IdempotencyKey))
	if err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "read reconciliation receipt", errors.Join(commitErr, err))
	}
	if subtle.ConstantTimeCompare(raw, fingerprint[:]) != 1 {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorIdempotencyConflict, "reconciliation receipt fingerprint conflict", commitErr)
	}
	if persisted.ReceiptID == receiptID {
		if _, err := tx.Exec(ctx, eventInsertSQL, eventID, receiptID, string(input.Prepared.Operation),
			input.Prepared.WorkspaceID, input.Prepared.PlanID, input.Prepared.TargetRevision,
			string(input.Prepared.TargetState), recordHash); err != nil {
			return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "insert reconciliation event", errors.Join(commitErr, err))
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "commit reconciliation receipt", errors.Join(commitErr, err))
	}
	return persisted, nil
}

func (repository *Repository) readReceiptByKey(ctx context.Context, key string) (authoritystore.Receipt, []byte, error) {
	receipt, raw, err := readReceipt(repository.pool.QueryRow(ctx, receiptByKeySQL, key))
	if errors.Is(err, pgx.ErrNoRows) {
		return authoritystore.Receipt{}, nil, authoritystore.Failure(authoritystore.ErrorNotFound, "authority receipt not found", err)
	}
	if err != nil {
		return authoritystore.Receipt{}, nil, databaseFailure("read authority receipt", err)
	}
	return receipt, raw, nil
}

func readReceipt(row pgx.Row) (authoritystore.Receipt, []byte, error) {
	var result authoritystore.Receipt
	var operation, status string
	var fingerprint, recordHash, buildHash []byte
	var acceptedRevision, targetRevision pgtype.Int8
	var acceptedState, targetState, executionID, reconciliation pgtype.Text
	var recordBytes []byte
	var committed pgtype.Timestamptz
	if err := row.Scan(&result.ReceiptID, &operation, &status, &result.IdempotencyKey, &fingerprint,
		&result.WorkspaceID, &result.PlanID, &result.ExpectedRevision, &acceptedRevision, &acceptedState,
		&targetRevision, &targetState, &result.Route.Backend, &result.Route.Authority, &result.Route.RoutingEpoch,
		&recordHash, &result.CorrelationID, &result.CallerID, &executionID, &buildHash,
		&recordBytes, &committed, &reconciliation, &result.RecordedAt); err != nil {
		return authoritystore.Receipt{}, nil, err
	}
	if len(fingerprint) != sha256.Size || len(recordHash) != sha256.Size || len(buildHash) != sha256.Size {
		return authoritystore.Receipt{}, nil, fmt.Errorf("stored authority receipt digest length is invalid")
	}
	result.Schema = authoritystore.ReceiptSchema
	result.Operation, result.Status = authoritystore.Operation(operation), authoritystore.ReceiptStatus(status)
	result.RequestFingerprint = "sha256:" + hex.EncodeToString(fingerprint)
	result.RecordHash = hex.EncodeToString(recordHash)
	result.ServiceBuildSHA = hex.EncodeToString(buildHash)
	result.RecordBytes = append([]byte(nil), recordBytes...)
	if acceptedRevision.Valid {
		value := acceptedRevision.Int64
		result.AcceptedRevision = &value
	}
	if acceptedState.Valid {
		result.State = governance.State(acceptedState.String)
	}
	if targetRevision.Valid {
		value := targetRevision.Int64
		result.TargetRevision = &value
	}
	if targetState.Valid {
		result.TargetState = governance.State(targetState.String)
	}
	if executionID.Valid {
		result.ExecutionID = executionID.String
	}
	if committed.Valid {
		value := committed.Time
		result.CommittedAt = &value
	}
	if reconciliation.Valid {
		result.ReconciliationToken = reconciliation.String
	}
	return result, append([]byte(nil), fingerprint...), nil
}

func lockScope(ctx context.Context, tx pgx.Tx, key, workspaceID, planID string) error {
	locks := []struct {
		value string
		salt  int64
		name  string
	}{
		{key, idempotencyLockSalt, "lock authority idempotency key"},
		{planLockKey(workspaceID, planID), planLockSalt, "lock authority plan"},
	}
	for _, lock := range locks {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, lock.value, lock.salt); err != nil {
			return databaseFailure(lock.name, err)
		}
	}
	return nil
}

func planLockKey(workspaceID, planID string) string {
	return strconv.Itoa(len(workspaceID)) + ":" + workspaceID + strconv.Itoa(len(planID)) + ":" + planID
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

func databaseFailure(operation string, err error) error {
	return authoritystore.Failure(authoritystore.ErrorDatabase, operation, err)
}

func mapWriteFailure(operation string, err error) error {
	if isUniqueViolation(err) {
		return authoritystore.Failure(authoritystore.ErrorConflict, operation, err)
	}
	return databaseFailure(operation, err)
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
