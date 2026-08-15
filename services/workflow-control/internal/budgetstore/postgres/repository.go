package postgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runlock"
)

const (
	idempotencyLockSalt   int64 = 628239560154231
	reconciliationTimeout       = 5 * time.Second
)

type Repository struct {
	pool                 *pgxpool.Pool
	commitTransaction    func(context.Context, pgx.Tx) error
	commitReconciliation func(context.Context, pgx.Tx) error
}

func New(pool *pgxpool.Pool) *Repository { return &Repository{pool: pool} }

// NewWithCommitter injects the mutation commit boundary. The callback must
// end the transaction before returning. Nil means the commit succeeded; an
// error after Commit models response loss, and an error after Rollback models
// an outcome that requires database reconciliation.
func NewWithCommitter(pool *pgxpool.Pool, commit func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commitTransaction: commit}
}

// NewWithCommitters applies the same closed callback contract to the database
// reconciliation commit boundary for qualification of the second ambiguity.
func NewWithCommitters(pool *pgxpool.Pool, mutation, reconciliation func(context.Context, pgx.Tx) error) *Repository {
	return &Repository{pool: pool, commitTransaction: mutation, commitReconciliation: reconciliation}
}

func (repository *Repository) Reserve(ctx context.Context, input budgetstore.MutationInput) (budgetstore.MutationResult, error) {
	return repository.mutate(ctx, "reserve", input)
}

func (repository *Repository) Settle(ctx context.Context, input budgetstore.MutationInput) (budgetstore.MutationResult, error) {
	return repository.mutate(ctx, "settle", input)
}

func (repository *Repository) mutate(ctx context.Context, operation string, input budgetstore.MutationInput) (budgetstore.MutationResult, error) {
	prepared, request, err := validateMutationInput(operation, input)
	if err != nil {
		return budgetstore.MutationResult{}, err
	}
	fingerprint := mustDecodeHash(prepared.RequestFingerprint)
	workspaceID := recordString(request, "workspaceId")
	runID := recordString(request, "runId")

	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return budgetstore.MutationResult{}, databaseFailure("begin workflow budget mutation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScope(ctx, tx, prepared.IdempotencyKey, workspaceID, runID); err != nil {
		return budgetstore.MutationResult{}, err
	}
	existing, rawFingerprint, err := readMutationResult(ctx, tx, prepared.IdempotencyKey)
	switch {
	case err == nil:
		if subtle.ConstantTimeCompare(rawFingerprint, fingerprint) != 1 {
			return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorIdempotencyConflict, "idempotency key is bound to another budget request fingerprint", nil)
		}
		existing.Replay = true
		return existing, nil
	case !budgetstore.IsCode(err, budgetstore.ErrorNotFound):
		return budgetstore.MutationResult{}, err
	}
	if err := validateActiveMutationBinding(request, input); err != nil {
		return budgetstore.MutationResult{}, err
	}
	var databaseReconciliationOpen bool
	if err := tx.QueryRow(ctx, openDatabaseReconciliationSQL, workspaceID, runID).Scan(&databaseReconciliationOpen); err != nil {
		return budgetstore.MutationResult{}, databaseFailure("read workflow budget database reconciliation gate", err)
	}
	if databaseReconciliationOpen {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorReconciliation, "workflow run has an open database commit reconciliation", nil)
	}

	run, err := readRunHead(ctx, tx, workspaceID, runID)
	if err != nil {
		return budgetstore.MutationResult{}, err
	}
	if err := validateRunBinding(run, request, input.ServiceBuildHash); err != nil {
		return budgetstore.MutationResult{}, err
	}

	account, err := readAccountRow(ctx, tx.QueryRow(ctx, accountForUpdateSQL, workspaceID, runID), workspaceID, runID)
	accountExists := err == nil
	if !accountExists && !budgetstore.IsCode(err, budgetstore.ErrorNotFound) {
		return budgetstore.MutationResult{}, err
	}
	if !accountExists {
		if operation != "reserve" || recordInt64(request, "expectedAccountRevision") != 0 {
			return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorNotFound, "workflow budget account was not found", nil)
		}
		account, err = initialAccountFromSeed(run, request, input.Seed)
		if err != nil {
			return budgetstore.MutationResult{}, err
		}
	} else if err := validateAccountRunBinding(account.Value, run, input.Seed); err != nil {
		return budgetstore.MutationResult{}, err
	}

	var reservation budgetstore.Reservation
	if operation == "settle" {
		reservation, err = readReservationRow(ctx, tx.QueryRow(ctx, reservationForUpdateSQL, workspaceID, runID, recordString(request, "reservationId")), workspaceID, runID)
		if err != nil {
			return budgetstore.MutationResult{}, err
		}
		if reservation.Status != "open" {
			return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorConflict, "workflow budget reservation is not open", nil)
		}
	}

	var committedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT date_trunc('milliseconds', clock_timestamp())`).Scan(&committedAt); err != nil {
		return budgetstore.MutationResult{}, databaseFailure("read workflow budget commit timestamp", err)
	}
	committedText := canonicalTimestamp(committedAt)

	var record, ledger, reconciliation, createdReservation budgetcontract.Record
	if operation == "reserve" {
		evaluation, evaluateErr := budgetcontract.EvaluateReserve(account.Value, request, committedText)
		if evaluateErr != nil {
			return budgetstore.MutationResult{}, mapContractFailure("evaluate workflow budget reserve", evaluateErr)
		}
		record, ledger, createdReservation = evaluation.Decision, evaluation.LedgerEntry, evaluation.Reservation
	} else {
		evaluation, evaluateErr := budgetcontract.EvaluateSettlement(account.Value, reservation.Value, request, committedText)
		if evaluateErr != nil {
			return budgetstore.MutationResult{}, mapContractFailure("evaluate workflow budget settlement", evaluateErr)
		}
		record, ledger, reconciliation = evaluation.Settlement, evaluation.LedgerEntry, evaluation.Reconciliation
	}
	afterAccount := record["afterAccount"].(budgetcontract.Record)
	projectedRun, runBytes, runHash, err := projectRunHead(run.record, afterAccount, reconciliation != nil)
	if err != nil {
		return budgetstore.MutationResult{}, err
	}
	recordOuter, recordBytes, _, err := exactDurableRecord(operationRecordKind(operation), record, input.ServiceBuildHash)
	if err != nil {
		return budgetstore.MutationResult{}, err
	}
	ledgerOuter, ledgerBytes, ledgerHash, err := exactDurableRecord(budgetstore.RecordKindLedgerEntry, ledger, input.ServiceBuildHash)
	if err != nil {
		return budgetstore.MutationResult{}, err
	}
	var reconciliationBytes []byte
	var reconciliationOuter *budgetstore.DurableRecord
	if reconciliation != nil {
		outer, exact, _, durableErr := exactDurableRecord(budgetstore.RecordKindReconciliation, reconciliation, input.ServiceBuildHash)
		err, reconciliationBytes, reconciliationOuter = durableErr, exact, &outer
		if err != nil {
			return budgetstore.MutationResult{}, err
		}
	}

	receiptID, err := randomToken("wf-budget-receipt")
	if err != nil {
		return budgetstore.MutationResult{}, databaseFailure("generate workflow budget receipt identity", err)
	}
	receipt, err := buildKnownReceipt(operation, prepared, request, record, ledger, reconciliation, input.ServiceBuildHash, committedText)
	if err != nil {
		return budgetstore.MutationResult{}, err
	}
	receiptOuter, receiptBytes, _, err := exactDurableRecord(budgetstore.RecordKindReceipt, receipt, input.ServiceBuildHash)
	if err != nil {
		return budgetstore.MutationResult{}, err
	}
	responseBytes, err := budgetstore.EncodeMutationResponse(operation, &recordOuter, receiptOuter, reconciliationOuter)
	if err != nil {
		return budgetstore.MutationResult{}, err
	}

	if createdReservation != nil {
		if err := insertReservation(ctx, tx, createdReservation); err != nil {
			return budgetstore.MutationResult{}, err
		}
	}
	if operation == "settle" {
		// Provider-outcome reconciliation keeps the reservation open. The run
		// head is latched reconciliation_required below, so no later mutation can
		// advance until a separately governed resolution path proves the outcome.
		// Only a known settlement terminalizes the reservation.
		if reconciliation == nil {
			tag, updateErr := tx.Exec(ctx, reservationTerminalSQL, workspaceID, runID, recordString(request, "reservationId"), "open", "settled", recordString(ledger, "entryId"), committedAt)
			if updateErr != nil {
				return budgetstore.MutationResult{}, mapWriteFailure("close workflow budget reservation", updateErr)
			}
			if tag.RowsAffected() != 1 {
				return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorConflict, "workflow budget reservation transition lost", nil)
			}
		}
	}
	if err := insertLedger(ctx, tx, ledger, ledgerBytes, ledgerHash, request); err != nil {
		return budgetstore.MutationResult{}, err
	}
	if err := persistAccount(ctx, tx, account, accountExists, afterAccount); err != nil {
		return budgetstore.MutationResult{}, err
	}
	tag, err := tx.Exec(ctx, runCASUpdateSQL, workspaceID, runID, run.record.Revision, string(run.record.State), mustDecodeHash(run.recordHash), string(projectedRun.State), projectedRun.Revision, mustDecodeHash(runHash), runBytes, committedAt)
	if err != nil {
		return budgetstore.MutationResult{}, mapWriteFailure("advance workflow run for budget mutation", err)
	}
	if tag.RowsAffected() != 1 {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorConflict, "workflow run budget compare-and-swap lost", nil)
	}

	var recordedAt time.Time
	if err := insertReceipt(ctx, tx, receiptID, prepared, receipt, receiptBytes, responseBytes, input.ServiceBuildHash).Scan(&recordedAt); err != nil {
		return budgetstore.MutationResult{}, mapWriteFailure("insert workflow budget receipt", err)
	}
	if reconciliation != nil {
		if err := insertReconciliation(ctx, tx, receiptID, prepared, reconciliation, reconciliationBytes); err != nil {
			return budgetstore.MutationResult{}, err
		}
	}
	result := budgetstore.MutationResult{
		Operation: operation, Status: recordString(record, "status"), Record: record,
		LedgerEntry: ledger, Reconciliation: reconciliation, Receipt: receipt,
		ExactRecordBytes: recordBytes, ExactLedgerBytes: ledgerBytes,
		ExactReceiptBytes: receiptBytes, ExactReconciliationBytes: reconciliationBytes, ExactResponseBytes: responseBytes,
		DurableRecord: &recordOuter, DurableLedgerEntry: &ledgerOuter, DurableReconciliation: reconciliationOuter,
		DurableReceipt: receiptOuter, Response: budgetstore.MutationResponse{Schema: budgetstore.MutationResponseSchema, Operation: operation, Record: &recordOuter, Receipt: receiptOuter, Reconciliation: reconciliationOuter},
		ReceiptID: receiptID, RecordedAt: recordedAt,
	}
	commit := repository.commitTransaction
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if err := commit(ctx, tx); err != nil {
		reservationEvidenceHash := ""
		if operation == "settle" {
			reservationEvidenceHash = reservation.RecordHash
		} else if createdReservation != nil {
			reservationEvidenceHash, _ = budgetcontract.HashValue("reservation", createdReservation)
		} else {
			reservationEvidenceHash, _ = budgetcontract.HashValue("reservation-intent", request)
		}
		return repository.resolveCommitOutcome(input, request, fingerprint, databaseReconciliationEvidence{
			accountHash: account.RecordHash, reservationHash: reservationEvidenceHash,
		}, err)
	}
	return result, nil
}

func validateMutationInput(operation string, input budgetstore.MutationInput) (budgetcontract.PreparedRequest, budgetcontract.Record, error) {
	if err := budgetstore.ValidateQualificationSeed(input.Seed); err != nil {
		return budgetcontract.PreparedRequest{}, nil, err
	}
	prepared, request, err := budgetcontract.ValidatePreparedRequestRecord(input.Prepared)
	if err != nil {
		return budgetcontract.PreparedRequest{}, nil, budgetstore.Failure(budgetstore.ErrorInputInvalid, "prepared workflow budget request is invalid", err)
	}
	if prepared.Operation != operation || prepared.Method != "POST" || !isHash(input.ServiceBuildHash) {
		return budgetcontract.PreparedRequest{}, nil, budgetstore.Failure(budgetstore.ErrorInputInvalid, "workflow budget mutation binding is invalid", nil)
	}
	return prepared, request, nil
}

func validateActiveMutationBinding(request budgetcontract.Record, input budgetstore.MutationInput) error {
	route := request["route"].(budgetcontract.Record)
	if route["backend"] != budgetstore.Backend || route["authority"] != budgetstore.Authority || route["authorityBuildHash"] != input.ServiceBuildHash {
		return budgetstore.Failure(budgetstore.ErrorConflict, "request route or authority build does not match the active Go budget qualification authority", nil)
	}
	if request["policyHash"] != input.Seed.PolicyHash {
		return budgetstore.Failure(budgetstore.ErrorConflict, "request policy hash does not match the qualification budget seed", nil)
	}
	return nil
}

func operationRecordKind(operation string) string {
	if operation == "reserve" {
		return budgetstore.RecordKindReserveDecision
	}
	return budgetstore.RecordKindSettlement
}

func operationRecordDomain(operation string) string {
	if operation == "reserve" {
		return "reserve-decision"
	}
	return "settlement"
}

func exactDurableRecord(kind string, value budgetcontract.Record, authorityBuildHash string) (budgetstore.DurableRecord, []byte, string, error) {
	outer, err := budgetstore.NewDurableRecord(kind, value, authorityBuildHash)
	if err != nil {
		return budgetstore.DurableRecord{}, nil, "", err
	}
	encoded, err := budgetstore.EncodeDurableRecord(outer)
	if err != nil {
		return budgetstore.DurableRecord{}, nil, "", err
	}
	return outer, encoded, outer.OperationalProjectionHash, nil
}

func buildKnownReceipt(operation string, prepared budgetcontract.PreparedRequest, request, record, ledger, reconciliation budgetcontract.Record, serviceBuildHash, committedAt string) (budgetcontract.Record, error) {
	status := "accepted"
	var reconciliationToken any
	if reconciliation != nil {
		status = "provider_reconciliation_required"
		reconciliationToken = reconciliation["reconciliationToken"]
	}
	recordHash, _ := budgetcontract.HashValue(operationRecordDomain(operation), record)
	ledgerHash, _ := budgetcontract.HashValue("ledger-entry", ledger)
	value := authorityEnvelope()
	for key, entry := range (budgetcontract.Record{
		"schema": budgetcontract.SchemaReceipt, "operation": operation, "status": status,
		"workspaceId": request["workspaceId"], "runId": request["runId"], "accountId": request["accountId"],
		"reservationId": request["reservationId"], "callId": request["callId"],
		"expectedAccountRevision": request["expectedAccountRevision"], "acceptedAccountRevision": record["afterAccount"].(budgetcontract.Record)["accountRevision"],
		"expectedRunRevision": request["expectedRunRevision"], "acceptedRunRevision": record["afterAccount"].(budgetcontract.Record)["runRevision"],
		"idempotencyKey": prepared.IdempotencyKey, "requestFingerprint": prepared.RequestFingerprint,
		"requestHash": prepared.RequestHash, "recordHash": recordHash, "ledgerEntryHash": ledgerHash,
		"correlationId": request["correlationId"], "serviceBuildHash": serviceBuildHash,
		"committedAt": committedAt, "reconciliationToken": reconciliationToken,
	}) {
		value[key] = entry
	}
	receipt, err := budgetcontract.ValidateReceiptForResult(value, prepared, record, ledger, reconciliation)
	if err != nil {
		return nil, budgetstore.Failure(budgetstore.ErrorContentInvalid, "build workflow budget receipt", err)
	}
	return receipt, nil
}

func authorityEnvelope() budgetcontract.Record {
	return budgetcontract.Record{
		"contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
		"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
	}
}

func recordString(value budgetcontract.Record, key string) string { return value[key].(string) }
func recordInt64(value budgetcontract.Record, key string) int64   { return value[key].(int64) }

func mustDecodeHash(value string) []byte {
	decoded, _ := hex.DecodeString(strings.TrimPrefix(value, "sha256:"))
	return decoded
}

func isHash(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == hex.EncodeToString(decoded)
}

func randomToken(prefix string) (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return prefix + "-" + base64.RawURLEncoding.EncodeToString(raw), nil
}

func canonicalTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func lockScope(ctx context.Context, tx pgx.Tx, idempotencyKey, workspaceID, runID string) error {
	for _, lock := range []struct {
		value string
		salt  int64
		name  string
	}{
		{idempotencyKey, idempotencyLockSalt, "lock workflow budget idempotency key"},
		{runlock.Key(workspaceID, runID), runlock.AdvisorySalt, "lock workflow budget run"},
	} {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,$2))`, lock.value, lock.salt); err != nil {
			return databaseFailure(lock.name, err)
		}
	}
	return nil
}

func databaseFailure(operation string, err error) error {
	return budgetstore.Failure(budgetstore.ErrorDatabase, operation, err)
}

func mapWriteFailure(operation string, err error) error {
	if code := postgresCode(err); code == "23505" || code == "23503" || code == "23514" || code == "P0001" {
		return budgetstore.Failure(budgetstore.ErrorConflict, operation, err)
	}
	return databaseFailure(operation, err)
}

func mapContractFailure(operation string, err error) error {
	var contractErr *budgetcontract.ContractError
	if errors.As(err, &contractErr) {
		switch contractErr.Code {
		case budgetcontract.ErrorStaleRevision, budgetcontract.ErrorIdentityMismatch,
			budgetcontract.ErrorPolicyDrift, budgetcontract.ErrorRouteDrift:
			return budgetstore.Failure(budgetstore.ErrorConflict, operation, err)
		case budgetcontract.ErrorReconciliationRequired:
			return budgetstore.Failure(budgetstore.ErrorReconciliation, operation, err)
		}
	}
	return budgetstore.Failure(budgetstore.ErrorContentInvalid, operation, err)
}

func postgresCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}
