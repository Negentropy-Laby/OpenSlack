package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
)

type queryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (repository *Repository) ReadAccount(ctx context.Context, workspaceID, runID string) (budgetstore.Account, error) {
	if err := budgetstore.ValidateReadIdentity(workspaceID, runID); err != nil {
		return budgetstore.Account{}, err
	}
	return readAccountRow(ctx, repository.pool.QueryRow(ctx, accountReadSQL, workspaceID, runID), workspaceID, runID)
}

func (repository *Repository) ReadReservation(ctx context.Context, workspaceID, runID, reservationID string) (budgetstore.Reservation, error) {
	if err := budgetstore.ValidateReadIdentity(workspaceID, runID, reservationID); err != nil {
		return budgetstore.Reservation{}, err
	}
	result, err := readReservationRow(ctx, repository.pool.QueryRow(ctx, reservationReadSQL, workspaceID, runID, reservationID), workspaceID, runID)
	if err != nil {
		return budgetstore.Reservation{}, err
	}
	if result.TerminalLedgerEntryID != nil {
		var kind, accountID, callID string
		var ledgerHash, exact []byte
		var recordedAt time.Time
		if err := repository.pool.QueryRow(ctx, `SELECT kind,account_id,call_id,ledger_hash,canonical_ledger_bytes,recorded_at FROM workflow_control_budget_ledger WHERE entry_id=$1 AND workspace_id=$2 AND run_id=$3 AND reservation_id=$4`, *result.TerminalLedgerEntryID, workspaceID, runID, reservationID).Scan(&kind, &accountID, &callID, &ledgerHash, &exact, &recordedAt); errors.Is(err, pgx.ErrNoRows) {
			return budgetstore.Reservation{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget reservation terminal ledger binding is absent", err)
		} else if err != nil {
			return budgetstore.Reservation{}, databaseFailure("verify workflow budget reservation terminal ledger", err)
		}
		ledgerOuter, err := budgetstore.DecodeDurableRecord(exact)
		ledger := ledgerOuter.OperationalProjection
		wantKind := "settlement_settled"
		wantHash := ledgerOuter.OperationalProjectionHash
		if err != nil || ledgerOuter.RecordKind != budgetstore.RecordKindLedgerEntry || len(ledgerHash) != sha256.Size || subtle.ConstantTimeCompare(ledgerHash, mustDecodeHash(wantHash)) != 1 || kind != wantKind ||
			ledgerOuter.AuthorityBuildHash != recordString(result.Value["route"].(budgetcontract.Record), "authorityBuildHash") ||
			ledger["entryId"] != *result.TerminalLedgerEntryID || ledger["kind"] != kind || ledger["workspaceId"] != workspaceID || ledger["runId"] != runID ||
			ledger["accountId"] != accountID || accountID != result.Value["accountId"] || ledger["reservationId"] != reservationID || ledger["callId"] != callID || callID != result.Value["callId"] ||
			result.ClosedAt == nil || !recordedAt.Equal(*result.ClosedAt) || ledger["recordedAt"] != canonicalTimestamp(recordedAt) {
			return budgetstore.Reservation{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget reservation terminal ledger binding is invalid", nil)
		}
	}
	return result, nil
}

func (repository *Repository) ReadReceipt(ctx context.Context, workspaceID, key string) (budgetstore.Receipt, error) {
	if err := budgetstore.ValidateReadIdentity(workspaceID); err != nil {
		return budgetstore.Receipt{}, err
	}
	if err := budgetstore.ValidateReceiptKey(key); err != nil {
		return budgetstore.Receipt{}, err
	}
	result, _, err := readMutationResult(ctx, repository.pool, key, workspaceID)
	if err != nil {
		return budgetstore.Receipt{}, err
	}
	return budgetstore.Receipt{
		Value: result.Receipt, Durable: result.DurableReceipt, Response: result.Response, ExactReceiptBytes: result.ExactReceiptBytes,
		ExactResponseBytes: result.ExactResponseBytes, ReceiptID: result.ReceiptID,
		RecordedAt: result.RecordedAt,
	}, nil
}

// ReadMutationResult is the narrow immutable point-read used by schema-8
// runner delivery. It reconstructs and cross-checks the durable receipt,
// record, ledger entry, and optional reconciliation without replaying either
// budget mutation.
func (repository *Repository) ReadMutationResult(ctx context.Context, workspaceID, key string) (budgetstore.MutationResult, error) {
	if err := budgetstore.ValidateReadIdentity(workspaceID); err != nil {
		return budgetstore.MutationResult{}, err
	}
	if err := budgetstore.ValidateReceiptKey(key); err != nil {
		return budgetstore.MutationResult{}, err
	}
	result, _, err := readMutationResult(ctx, repository.pool, key, workspaceID)
	return result, err
}

func (repository *Repository) Ready(ctx context.Context) error {
	var result int
	if err := repository.pool.QueryRow(ctx, readinessSQL).Scan(&result); err != nil {
		return databaseFailure("check workflow budget authority readiness", err)
	}
	if result != 1 {
		return budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget readiness probe returned an invalid result", nil)
	}
	return nil
}

func (repository *Repository) Statistics(ctx context.Context) (budgetstore.Statistics, error) {
	var result budgetstore.Statistics
	if err := repository.pool.QueryRow(ctx, statisticsSQL).Scan(
		&result.Accounts, &result.Reservations, &result.OpenReservations,
		&result.LedgerEntries, &result.Receipts,
		&result.OpenDatabaseReconciliations, &result.ProviderReconciliations,
	); err != nil {
		return budgetstore.Statistics{}, databaseFailure("read workflow budget authority statistics", err)
	}
	return result, nil
}

func readMutationResult(ctx context.Context, source queryer, key string, optionalWorkspace ...string) (budgetstore.MutationResult, []byte, error) {
	query := receiptByKeySQL
	arguments := []any{key}
	if len(optionalWorkspace) > 0 {
		query = receiptByWorkspaceKeySQL
		arguments = append(arguments, optionalWorkspace[0])
	}
	var result budgetstore.MutationResult
	var operation, status, idempotencyKey, workspaceID, runID, accountID, reservationID, callID, correlationID string
	var fingerprint, requestHash, recordHash, ledgerHash, serviceBuildHash []byte
	var expectedAccountRevision, expectedRunRevision int64
	var acceptedAccountRevision, acceptedRunRevision pgtype.Int8
	var committedAt pgtype.Timestamptz
	var reconciliationToken pgtype.Text
	if err := source.QueryRow(ctx, query, arguments...).Scan(
		&result.ReceiptID, &operation, &status, &idempotencyKey, &fingerprint,
		&requestHash, &workspaceID, &runID, &accountID, &reservationID, &callID,
		&expectedAccountRevision, &acceptedAccountRevision, &expectedRunRevision,
		&acceptedRunRevision, &recordHash, &ledgerHash, &correlationID,
		&serviceBuildHash, &committedAt, &reconciliationToken,
		&result.ExactReceiptBytes, &result.ExactResponseBytes, &result.RecordedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorNotFound, "workflow budget receipt not found", err)
	} else if err != nil {
		return budgetstore.MutationResult{}, nil, databaseFailure("read workflow budget receipt", err)
	}
	for _, digest := range [][]byte{fingerprint, requestHash, serviceBuildHash} {
		if len(digest) != sha256.Size {
			return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget receipt digest length is invalid", nil)
		}
	}
	receiptOuter, receipt, response, err := decodeReceiptAndResponse(result.ExactReceiptBytes, result.ExactResponseBytes)
	if err != nil {
		return budgetstore.MutationResult{}, nil, err
	}
	if operation != receipt["operation"] || status != receipt["status"] || idempotencyKey != receipt["idempotencyKey"] ||
		"sha256:"+hex.EncodeToString(fingerprint) != receipt["requestFingerprint"] || hex.EncodeToString(requestHash) != receipt["requestHash"] ||
		workspaceID != receipt["workspaceId"] || runID != receipt["runId"] || accountID != receipt["accountId"] || reservationID != receipt["reservationId"] || callID != receipt["callId"] ||
		expectedAccountRevision != receipt["expectedAccountRevision"] || expectedRunRevision != receipt["expectedRunRevision"] || correlationID != receipt["correlationId"] ||
		hex.EncodeToString(serviceBuildHash) != receipt["serviceBuildHash"] || receiptOuter.AuthorityBuildHash != hex.EncodeToString(serviceBuildHash) {
		return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget receipt columns do not match exact bytes", nil)
	}
	known := status != "database_reconciliation_required"
	if known {
		if !acceptedAccountRevision.Valid || !acceptedRunRevision.Valid || !committedAt.Valid || len(recordHash) != sha256.Size || len(ledgerHash) != sha256.Size ||
			receipt["acceptedAccountRevision"] != acceptedAccountRevision.Int64 || receipt["acceptedRunRevision"] != acceptedRunRevision.Int64 ||
			receipt["recordHash"] != hex.EncodeToString(recordHash) || receipt["ledgerEntryHash"] != hex.EncodeToString(ledgerHash) || receipt["committedAt"] != canonicalTimestamp(committedAt.Time) {
			return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored accepted workflow budget receipt outcome is invalid", nil)
		}
		var ledgerEntryID, ledgerKind, ledgerWorkspace, ledgerRun, ledgerAccount, ledgerReservation, ledgerCall string
		var ledgerProviderAttempt, ledgerAccountRevision, ledgerRunRevision int64
		var ledgerPreviousAccountHash, ledgerAccountHash, ledgerDecisionHash, storedLedgerHash, exactLedger []byte
		var ledgerRecordedAt time.Time
		if err := source.QueryRow(ctx, ledgerByHashSQL, ledgerHash).Scan(
			&ledgerEntryID, &ledgerKind, &ledgerWorkspace, &ledgerRun, &ledgerAccount, &ledgerReservation, &ledgerCall,
			&ledgerProviderAttempt, &ledgerAccountRevision, &ledgerRunRevision, &ledgerPreviousAccountHash,
			&ledgerAccountHash, &ledgerDecisionHash, &storedLedgerHash, &exactLedger, &ledgerRecordedAt,
		); err != nil {
			return budgetstore.MutationResult{}, nil, mapPointReadFailure("read workflow budget receipt ledger", err)
		}
		for _, digest := range [][]byte{ledgerPreviousAccountHash, ledgerAccountHash, ledgerDecisionHash, storedLedgerHash} {
			if len(digest) != sha256.Size {
				return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget ledger digest length is invalid", nil)
			}
		}
		ledgerOuter, err := budgetstore.DecodeDurableRecord(exactLedger)
		if err != nil || ledgerOuter.RecordKind != budgetstore.RecordKindLedgerEntry || ledgerOuter.AuthorityBuildHash != receiptOuter.AuthorityBuildHash {
			return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget receipt ledger is invalid", err)
		}
		ledger, wantLedgerHash := ledgerOuter.OperationalProjection, ledgerOuter.OperationalProjectionHash
		after := response.Record.OperationalProjection["afterAccount"].(budgetcontract.Record)
		request := response.Record.OperationalProjection["request"].(budgetcontract.Record)
		wantAccountHash, _ := budgetcontract.HashValue("account", after)
		providerAttempt, _ := strconv.ParseInt(recordString(request, "providerAttempt"), 10, 64)
		if subtle.ConstantTimeCompare(ledgerHash, mustDecodeHash(wantLedgerHash)) != 1 || subtle.ConstantTimeCompare(storedLedgerHash, ledgerHash) != 1 ||
			ledger["entryId"] != ledgerEntryID || ledger["kind"] != ledgerKind || ledger["workspaceId"] != ledgerWorkspace || ledger["runId"] != ledgerRun || ledger["accountId"] != ledgerAccount ||
			ledger["reservationId"] != ledgerReservation || ledger["callId"] != ledgerCall || providerAttempt != ledgerProviderAttempt ||
			ledger["accountRevision"] != ledgerAccountRevision || ledger["runRevision"] != ledgerRunRevision || ledger["previousAccountHash"] != hex.EncodeToString(ledgerPreviousAccountHash) ||
			ledger["accountHash"] != hex.EncodeToString(ledgerAccountHash) || ledger["decisionHash"] != hex.EncodeToString(ledgerDecisionHash) || ledger["recordedAt"] != canonicalTimestamp(ledgerRecordedAt) ||
			ledger["decisionHash"] != receipt["recordHash"] || ledger["accountHash"] != wantAccountHash || response.Record.OperationalProjection["beforeAccountHash"] != ledger["previousAccountHash"] ||
			ledger["workspaceId"] != workspaceID || ledger["runId"] != runID || ledger["accountId"] != accountID || ledger["reservationId"] != reservationID || ledger["callId"] != callID ||
			ledger["accountRevision"] != receipt["acceptedAccountRevision"] || ledger["runRevision"] != receipt["acceptedRunRevision"] || ledger["recordedAt"] != receipt["committedAt"] {
			return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget ledger does not bind receipt", nil)
		}
		result.LedgerEntry, result.ExactLedgerBytes, result.DurableLedgerEntry = ledger, exactLedger, &ledgerOuter
		result.Record = response.Record.OperationalProjection
		result.DurableRecord = response.Record
		result.ExactRecordBytes, _ = budgetstore.EncodeDurableRecord(*response.Record)
	} else if acceptedAccountRevision.Valid || acceptedRunRevision.Valid || committedAt.Valid || len(recordHash) != 0 || len(ledgerHash) != 0 {
		return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored database reconciliation receipt claims an accepted mutation", nil)
	}
	if reconciliationToken.Valid {
		if receipt["reconciliationToken"] != reconciliationToken.String {
			return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget reconciliation token differs from receipt", nil)
		}
		var storedToken, reconciliationReceiptID, evidenceType, reasonCode, reconciliationKey, reconciliationWorkspace, reconciliationRun, reconciliationAccount, reconciliationReservation, reconciliationCall, reconciliationStatus string
		var reconciliationFingerprint, reconciliationRequestHash, evidenceHash, reconciliationAccountHash, reconciliationReservationHash, exactReconciliation []byte
		var reconciliationObservedAt time.Time
		if err := source.QueryRow(ctx, reconciliationByTokenSQL, reconciliationToken.String).Scan(
			&storedToken, &reconciliationReceiptID, &evidenceType, &reasonCode, &reconciliationKey,
			&reconciliationFingerprint, &reconciliationRequestHash, &evidenceHash,
			&reconciliationWorkspace, &reconciliationRun, &reconciliationAccount, &reconciliationReservation, &reconciliationCall,
			&reconciliationAccountHash, &reconciliationReservationHash, &exactReconciliation, &reconciliationStatus, &reconciliationObservedAt,
		); err != nil {
			return budgetstore.MutationResult{}, nil, mapPointReadFailure("read workflow budget receipt reconciliation", err)
		}
		reconciliationOuter, err := budgetstore.DecodeDurableRecord(exactReconciliation)
		if err != nil || reconciliationOuter.RecordKind != budgetstore.RecordKindReconciliation || reconciliationOuter.AuthorityBuildHash != receiptOuter.AuthorityBuildHash {
			return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget reconciliation is invalid", err)
		}
		responseReconciliation, _ := budgetstore.EncodeDurableRecord(*response.Reconciliation)
		if !bytes.Equal(responseReconciliation, exactReconciliation) {
			return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget response reconciliation differs from evidence", nil)
		}
		reconciliation := reconciliationOuter.OperationalProjection
		exactDigest := sha256.Sum256(exactReconciliation)
		if storedToken != reconciliation["reconciliationToken"] || reconciliationReceiptID != result.ReceiptID || evidenceType != reconciliation["evidenceType"] || reasonCode != reconciliation["reasonCode"] ||
			reconciliationKey != idempotencyKey || subtle.ConstantTimeCompare(reconciliationFingerprint, fingerprint) != 1 || subtle.ConstantTimeCompare(reconciliationRequestHash, requestHash) != 1 || subtle.ConstantTimeCompare(evidenceHash, exactDigest[:]) != 1 ||
			reconciliationWorkspace != workspaceID || reconciliationRun != runID || reconciliationAccount != accountID || reconciliationReservation != reservationID || reconciliationCall != callID ||
			reconciliation["accountHash"] != hex.EncodeToString(reconciliationAccountHash) || reconciliation["reservationHash"] != hex.EncodeToString(reconciliationReservationHash) ||
			reconciliationStatus != "open" || reconciliation["observedAt"] != canonicalTimestamp(reconciliationObservedAt) {
			return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget reconciliation columns do not match exact bytes", nil)
		}
		result.Reconciliation, result.DurableReconciliation, result.ExactReconciliationBytes = reconciliation, &reconciliationOuter, exactReconciliation
	} else if receipt["reconciliationToken"] != nil || response.Reconciliation != nil {
		return budgetstore.MutationResult{}, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget receipt reconciliation shape is invalid", nil)
	}
	result.Operation, result.Receipt, result.DurableReceipt, result.Response = operation, receipt, receiptOuter, response
	if result.Record != nil {
		result.Status = recordString(result.Record, "status")
	} else {
		result.Status = status
	}
	return result, append([]byte(nil), fingerprint...), nil
}

func decodeReceiptAndResponse(exactReceipt, exactResponse []byte) (budgetstore.DurableRecord, budgetcontract.Record, budgetstore.MutationResponse, error) {
	receiptOuter, err := budgetstore.DecodeDurableRecord(exactReceipt)
	if err != nil || receiptOuter.RecordKind != budgetstore.RecordKindReceipt {
		return budgetstore.DurableRecord{}, nil, budgetstore.MutationResponse{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget receipt bytes are invalid", err)
	}
	response, err := budgetstore.DecodeMutationResponse(exactResponse)
	if err != nil {
		return budgetstore.DurableRecord{}, nil, budgetstore.MutationResponse{}, err
	}
	receiptCanonical, encodeErr := budgetstore.EncodeDurableRecord(response.Receipt)
	if encodeErr != nil || !bytes.Equal(receiptCanonical, exactReceipt) {
		return budgetstore.DurableRecord{}, nil, budgetstore.MutationResponse{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget response receipt differs from exact receipt", encodeErr)
	}
	return receiptOuter, receiptOuter.OperationalProjection, response, nil
}

func mapPointReadFailure(operation string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return budgetstore.Failure(budgetstore.ErrorIntegrity, operation, err)
	}
	return databaseFailure(operation, err)
}

var _ queryer = (*pgxpool.Pool)(nil)
