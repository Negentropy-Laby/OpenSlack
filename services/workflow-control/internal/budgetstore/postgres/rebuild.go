package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"math/big"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
)

type ledgerRebuildEntry struct {
	value           budgetcontract.Record
	durable         budgetstore.DurableRecord
	exactBytes      []byte
	recordHash      string
	providerAttempt int64
	receiptKey      string
	recordedAt      time.Time
}

// RebuildAccount is a qualification-only restart proof. It reconstructs the
// account solely from the immutable revision-zero anchor and ordered ledger,
// then requires the reconstructed exact DurableRecord to equal the materialized
// account head. It does not create another Workflow authority or repair data.
func (repository *Repository) RebuildAccount(ctx context.Context, workspaceID, runID string) (budgetstore.Account, error) {
	if err := budgetstore.ValidateReadIdentity(workspaceID, runID); err != nil {
		return budgetstore.Account{}, err
	}
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return budgetstore.Account{}, databaseFailure("begin workflow budget ledger rebuild", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	head, genesis, err := readAccountStateRow(tx.QueryRow(ctx, accountReadSQL, workspaceID, runID), workspaceID, runID)
	if err != nil {
		return budgetstore.Account{}, err
	}
	entries, err := readLedgerRebuildEntries(ctx, tx, workspaceID, runID)
	if err != nil {
		return budgetstore.Account{}, err
	}
	if err := validateLedgerReceiptBindings(ctx, tx, workspaceID, entries); err != nil {
		return budgetstore.Account{}, err
	}
	rebuilt, err := rebuildAccountFromLedger(genesis, head, entries)
	if err != nil {
		return budgetstore.Account{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return budgetstore.Account{}, databaseFailure("finish workflow budget ledger rebuild snapshot", err)
	}
	return rebuilt, nil
}

func readLedgerRebuildEntries(ctx context.Context, tx pgx.Tx, workspaceID, runID string) ([]ledgerRebuildEntry, error) {
	rows, err := tx.Query(ctx, ledgerRebuildSQL, workspaceID, runID)
	if err != nil {
		return nil, databaseFailure("read workflow budget ledger rebuild chain", err)
	}
	defer rows.Close()
	entries := []ledgerRebuildEntry{}
	for rows.Next() {
		entry, err := scanLedgerRebuildEntry(rows, workspaceID, runID)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseFailure("iterate workflow budget ledger rebuild chain", err)
	}
	return entries, nil
}

func scanLedgerRebuildEntry(row rowScanner, workspaceID, runID string) (ledgerRebuildEntry, error) {
	var entryID, kind, storedWorkspace, storedRun, accountID, reservationID, callID string
	var providerAttempt, accountRevision, runRevision int64
	var receiptCount int64
	var receiptKey string
	var previousAccountHash, accountHash, decisionHash, ledgerHash, exact []byte
	var recordedAt time.Time
	if err := row.Scan(
		&entryID, &kind, &storedWorkspace, &storedRun, &accountID, &reservationID, &callID,
		&providerAttempt, &accountRevision, &runRevision, &previousAccountHash,
		&accountHash, &decisionHash, &ledgerHash, &exact, &recordedAt, &receiptCount, &receiptKey,
	); err != nil {
		return ledgerRebuildEntry{}, databaseFailure("scan workflow budget ledger rebuild entry", err)
	}
	for _, digest := range [][]byte{previousAccountHash, accountHash, decisionHash, ledgerHash} {
		if len(digest) != sha256.Size {
			return ledgerRebuildEntry{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget rebuild ledger digest length is invalid", nil)
		}
	}
	outer, err := budgetstore.DecodeDurableRecord(exact)
	if err != nil || outer.RecordKind != budgetstore.RecordKindLedgerEntry {
		return ledgerRebuildEntry{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget rebuild ledger bytes are invalid", err)
	}
	value := outer.OperationalProjection
	if receiptCount != 1 || receiptKey == "" || providerAttempt < 1 || providerAttempt > budgetcontract.MaxSafeInteger ||
		storedWorkspace != workspaceID || storedRun != runID ||
		value["entryId"] != entryID || value["kind"] != kind || value["workspaceId"] != storedWorkspace || value["runId"] != storedRun ||
		value["accountId"] != accountID || value["reservationId"] != reservationID || value["callId"] != callID ||
		value["accountRevision"] != accountRevision || value["runRevision"] != runRevision ||
		value["previousAccountHash"] != hex.EncodeToString(previousAccountHash) || value["accountHash"] != hex.EncodeToString(accountHash) ||
		value["decisionHash"] != hex.EncodeToString(decisionHash) || value["recordedAt"] != canonicalTimestamp(recordedAt) ||
		subtle.ConstantTimeCompare(ledgerHash, mustDecodeHash(outer.OperationalProjectionHash)) != 1 {
		return ledgerRebuildEntry{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget rebuild ledger columns do not match exact bytes", nil)
	}
	return ledgerRebuildEntry{
		value: value, durable: outer, exactBytes: append([]byte(nil), exact...),
		recordHash: outer.OperationalProjectionHash, providerAttempt: providerAttempt,
		receiptKey: receiptKey, recordedAt: recordedAt,
	}, nil
}

func validateLedgerReceiptBindings(ctx context.Context, tx pgx.Tx, workspaceID string, entries []ledgerRebuildEntry) error {
	for _, entry := range entries {
		result, _, err := readMutationResult(ctx, tx, entry.receiptKey, workspaceID)
		if err != nil {
			return budgetstore.Failure(budgetstore.ErrorIntegrity, "validate workflow budget rebuild ledger receipt binding", err)
		}
		if result.DurableLedgerEntry == nil || result.Record == nil ||
			result.DurableLedgerEntry.OperationalProjectionHash != entry.recordHash ||
			!bytes.Equal(result.ExactLedgerBytes, entry.exactBytes) ||
			recordString(result.LedgerEntry, "entryId") != recordString(entry.value, "entryId") ||
			recordString(result.Record["request"].(budgetcontract.Record), "providerAttempt") != strconv.FormatInt(entry.providerAttempt, 10) {
			return budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget rebuild ledger is not uniquely bound to its exact receipt response", nil)
		}
	}
	return nil
}

func rebuildAccountFromLedger(genesis, head budgetstore.Account, entries []ledgerRebuildEntry) (budgetstore.Account, error) {
	if recordInt64(genesis.Value, "accountRevision") != 0 || len(entries) == 0 || int64(len(entries)) != recordInt64(head.Value, "accountRevision") {
		return budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget rebuild ledger length does not cover the account head", nil)
	}
	current := genesis
	for _, entry := range entries {
		ledger := entry.value
		expectedAccountRevision := recordInt64(current.Value, "accountRevision") + 1
		expectedRunRevision := recordInt64(current.Value, "runRevision") + 1
		if entry.durable.AuthorityBuildHash != genesis.Durable.AuthorityBuildHash ||
			ledger["workspaceId"] != current.Value["workspaceId"] || ledger["runId"] != current.Value["runId"] || ledger["accountId"] != current.Value["accountId"] ||
			recordInt64(ledger, "accountRevision") != expectedAccountRevision || recordInt64(ledger, "runRevision") != expectedRunRevision ||
			recordString(ledger, "previousAccountHash") != current.RecordHash || entry.recordedAt.Before(current.UpdatedAt) {
			return budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget rebuild ledger order or hash chain is invalid", nil)
		}

		reserved, settled, err := foldLedgerQuantities(current.Value, ledger)
		if err != nil {
			return budgetstore.Account{}, err
		}
		next := cloneRecord(current.Value)
		next["accountRevision"], next["runRevision"] = expectedAccountRevision, expectedRunRevision
		next["reserved"], next["settled"], next["updatedAt"] = reserved, settled, recordString(ledger, "recordedAt")
		validated, err := budgetcontract.ValidateAccount(next)
		if err != nil {
			return budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget rebuild produced an invalid account", err)
		}
		outer, exact, hash, err := exactDurableRecord(budgetstore.RecordKindAccount, validated, genesis.Durable.AuthorityBuildHash)
		if err != nil {
			return budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "encode workflow budget rebuilt account", err)
		}
		if hash != recordString(ledger, "accountHash") {
			return budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget rebuild account hash differs from ledger", nil)
		}
		current = budgetstore.Account{Value: validated, Durable: outer, ExactBytes: exact, RecordHash: hash, UpdatedAt: entry.recordedAt}
	}
	if current.RecordHash != head.RecordHash || current.Durable.AuthorityBuildHash != head.Durable.AuthorityBuildHash || !bytes.Equal(current.ExactBytes, head.ExactBytes) {
		return budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget rebuilt account differs from materialized head", nil)
	}
	return current, nil
}

func foldLedgerQuantities(account, ledger budgetcontract.Record) (budgetcontract.Record, budgetcontract.Record, error) {
	reserved := account["reserved"].(budgetcontract.Record)
	settled := account["settled"].(budgetcontract.Record)
	switch recordString(ledger, "kind") {
	case "reserve_reserved":
		var err error
		reserved, err = addQuantities(reserved, ledger["encumbered"].(budgetcontract.Record))
		if err != nil {
			return nil, nil, err
		}
	case "reserve_rejected", "settlement_reconciliation_required":
		// These decisions advance the hash/revision evidence but do not change
		// counters. The frozen E1 validator already requires zero deltas.
	case "settlement_settled":
		var err error
		reserved, err = subtractQuantities(reserved, ledger["released"].(budgetcontract.Record))
		if err != nil {
			return nil, nil, err
		}
		settled, err = addQuantities(settled, ledger["settled"].(budgetcontract.Record))
		if err != nil {
			return nil, nil, err
		}
	default:
		return nil, nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget rebuild ledger kind is invalid", nil)
	}
	return reserved, settled, nil
}

func addQuantities(left, right budgetcontract.Record) (budgetcontract.Record, error) {
	return combineQuantities(left, right, false)
}

func subtractQuantities(left, right budgetcontract.Record) (budgetcontract.Record, error) {
	return combineQuantities(left, right, true)
}

func combineQuantities(left, right budgetcontract.Record, subtract bool) (budgetcontract.Record, error) {
	result := budgetcontract.Record{}
	limit := new(big.Int).SetInt64(int64(^uint64(0) >> 1))
	for _, key := range []string{"tokens", "nanoUsd", "calls"} {
		leftValue, leftOK := new(big.Int).SetString(recordString(left, key), 10)
		rightValue, rightOK := new(big.Int).SetString(recordString(right, key), 10)
		if !leftOK || !rightOK {
			return nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget rebuild quantity is invalid", nil)
		}
		value := new(big.Int).Add(leftValue, rightValue)
		if subtract {
			value.Sub(leftValue, rightValue)
		}
		if value.Sign() < 0 || value.Cmp(limit) > 0 {
			return nil, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow budget rebuild quantity overflows its closed int64 range", nil)
		}
		result[key] = value.String()
	}
	return result, nil
}

func cloneRecord(value budgetcontract.Record) budgetcontract.Record {
	result := make(budgetcontract.Record, len(value))
	for key, item := range value {
		result[key] = item
	}
	return result
}
