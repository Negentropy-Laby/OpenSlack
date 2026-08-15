package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

type runHead struct {
	record      authoritystore.RunRecord
	recordHash  string
	recordBytes []byte
	updatedAt   time.Time
}

type rowScanner interface{ Scan(...any) error }

func readRunHead(ctx context.Context, tx pgx.Tx, workspaceID, runID string) (runHead, error) {
	var workflowID, workflowVersion, backend, authority, stateName string
	var workflowSourceHash, manifestHash, inputHash, buildHash, recordHash []byte
	var routingEpoch, revision, resumeGeneration int64
	var phaseID pgtype.Text
	var phaseIndex pgtype.Int8
	var recordBytes []byte
	var updatedAt time.Time
	if err := tx.QueryRow(ctx, runForUpdateSQL, workspaceID, runID).Scan(
		&workflowID, &workflowVersion, &workflowSourceHash, &manifestHash, &inputHash,
		&backend, &authority, &routingEpoch, &buildHash, &stateName, &revision,
		&phaseID, &phaseIndex, &resumeGeneration, &recordHash, &recordBytes, &updatedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return runHead{}, budgetstore.Failure(budgetstore.ErrorNotFound, "workflow authority run was not found", err)
	} else if err != nil {
		return runHead{}, databaseFailure("lock workflow authority run for budget mutation", err)
	}
	if len(recordHash) != sha256.Size || len(buildHash) != sha256.Size || len(workflowSourceHash) != sha256.Size || len(manifestHash) != sha256.Size || len(inputHash) != sha256.Size {
		return runHead{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow authority run digest length is invalid", nil)
	}
	digest := sha256.Sum256(recordBytes)
	if subtle.ConstantTimeCompare(recordHash, digest[:]) != 1 {
		return runHead{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow authority run record hash is invalid", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(recordBytes))
	decoder.DisallowUnknownFields()
	var record authoritystore.RunRecord
	if err := decoder.Decode(&record); err != nil {
		return runHead{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow authority run exact record is invalid", err)
	}
	if err := requireRunEOF(decoder); err != nil {
		return runHead{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow authority run exact record has trailing content", err)
	}
	canonical, err := canonicaljson.Encode(record)
	if err != nil || !bytes.Equal(append(canonical, '\n'), recordBytes) {
		return runHead{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow authority run record is not exact canonical JSON plus LF", err)
	}
	if record.Schema != authoritystore.RunRecordSchema || record.WorkspaceID != workspaceID || record.RunID != runID || record.WorkflowID != workflowID || record.WorkflowVersion != workflowVersion ||
		record.WorkflowSourceHash != hex.EncodeToString(workflowSourceHash) || record.ManifestHash != hex.EncodeToString(manifestHash) || record.InputHash != hex.EncodeToString(inputHash) ||
		record.Route.Backend != backend || record.Route.Authority != authority || record.Route.RoutingEpoch != routingEpoch || record.Route.AuthorityBuildHash != hex.EncodeToString(buildHash) ||
		string(record.State) != stateName || record.Revision != revision || record.ResumeGeneration != resumeGeneration ||
		!sameNullableString(record.CurrentPhaseID, phaseID) || !sameNullableInt64(record.CurrentPhaseIndex, phaseIndex) || !validRunRecord(record) {
		return runHead{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "workflow authority run columns do not match exact record", nil)
	}
	return runHead{record: record, recordHash: hex.EncodeToString(recordHash), recordBytes: append([]byte(nil), recordBytes...), updatedAt: updatedAt}, nil
}

func validateRunBinding(run runHead, request budgetcontract.Record, serviceBuildHash string) error {
	record := run.record
	if record.State != authoritycontract.RunRunning {
		return budgetstore.Failure(budgetstore.ErrorConflict, "workflow budget mutation requires a running non-reconciling run", nil)
	}
	// GS9-E2 has no Runner-v2 request field that can bind an expected resume
	// generation. Qualification therefore admits only the initial generation;
	// GS9-F must deliver the versioned runner binding before resumed attempts can
	// use this authority. Accepting a non-zero generation here would let a stale
	// attempt present only the current run revision.
	if record.ResumeGeneration != 0 {
		return budgetstore.Failure(budgetstore.ErrorConflict, "workflow budget qualification requires resume generation zero", nil)
	}
	route := request["route"].(budgetcontract.Record)
	if request["workspaceId"] != record.WorkspaceID || request["runId"] != record.RunID || request["expectedRunRevision"] != record.Revision ||
		route["backend"] != record.Route.Backend || route["authority"] != record.Route.Authority || route["routingEpoch"] != record.Route.RoutingEpoch ||
		route["authorityBuildHash"] != record.Route.AuthorityBuildHash || serviceBuildHash != record.Route.AuthorityBuildHash {
		return budgetstore.Failure(budgetstore.ErrorConflict, "workflow budget request run, route, revision, or policy binding drifted", nil)
	}
	return nil
}

func initialAccountFromSeed(run runHead, request budgetcontract.Record, seed budgetstore.QualificationSeed) (budgetstore.Account, error) {
	value := authorityEnvelope()
	for key, entry := range (budgetcontract.Record{
		"schema": budgetcontract.SchemaAccount, "workspaceId": run.record.WorkspaceID,
		"runId": run.record.RunID, "accountId": request["accountId"], "policyHash": seed.PolicyHash,
		"route": request["route"], "accountRevision": int64(0), "runRevision": run.record.Revision,
		"limit":     seed.Limit.Record(),
		"reserved":  budgetcontract.Record{"tokens": "0", "nanoUsd": "0", "calls": "0"},
		"settled":   budgetcontract.Record{"tokens": "0", "nanoUsd": "0", "calls": "0"},
		"updatedAt": canonicalTimestamp(run.updatedAt),
	}) {
		value[key] = entry
	}
	validated, err := budgetcontract.ValidateAccount(value)
	if err != nil {
		return budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "derive initial budget account from qualification seed", err)
	}
	outer, bytes, hash, err := exactDurableRecord(budgetstore.RecordKindAccount, validated, run.record.Route.AuthorityBuildHash)
	if err != nil {
		return budgetstore.Account{}, err
	}
	return budgetstore.Account{Value: validated, Durable: outer, ExactBytes: bytes, RecordHash: hash, UpdatedAt: run.updatedAt}, nil
}

func validateAccountRunBinding(account budgetcontract.Record, run runHead, seed budgetstore.QualificationSeed) error {
	limit := account["limit"].(budgetcontract.Record)
	route := account["route"].(budgetcontract.Record)
	if account["workspaceId"] != run.record.WorkspaceID || account["runId"] != run.record.RunID || account["runRevision"] != run.record.Revision ||
		account["policyHash"] != seed.PolicyHash || route["backend"] != run.record.Route.Backend || route["authority"] != run.record.Route.Authority ||
		route["routingEpoch"] != run.record.Route.RoutingEpoch || route["authorityBuildHash"] != run.record.Route.AuthorityBuildHash ||
		limit["tokens"] != seed.Limit.Tokens || limit["nanoUsd"] != seed.Limit.NanoUSD || limit["calls"] != seed.Limit.Calls {
		return budgetstore.Failure(budgetstore.ErrorIntegrity, "budget account does not match the workflow run and qualification seed", nil)
	}
	return nil
}

func projectRunHead(current authoritystore.RunRecord, account budgetcontract.Record, reconciliation bool) (authoritystore.RunRecord, []byte, string, error) {
	next := current
	next.Revision = recordInt64(account, "runRevision")
	if reconciliation {
		next.State = authoritycontract.RunReconciliationRequired
		if err := authoritycontract.ValidateTransition(current.State, next.State); err != nil {
			return authoritystore.RunRecord{}, nil, "", budgetstore.Failure(budgetstore.ErrorIntegrity, "project workflow run reconciliation transition", err)
		}
	}
	if !validRunRecord(next) {
		return authoritystore.RunRecord{}, nil, "", budgetstore.Failure(budgetstore.ErrorIntegrity, "projected workflow run record is invalid", nil)
	}
	encoded, err := canonicaljson.Encode(next)
	if err != nil {
		return authoritystore.RunRecord{}, nil, "", budgetstore.Failure(budgetstore.ErrorIntegrity, "encode workflow run record", err)
	}
	encoded = append(encoded, '\n')
	digest := sha256.Sum256(encoded)
	return next, encoded, hex.EncodeToString(digest[:]), nil
}

func requireRunEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); errors.Is(err, io.EOF) {
		return nil
	} else {
		return err
	}
}

func validRunRecord(value authoritystore.RunRecord) bool {
	if value.Schema != authoritystore.RunRecordSchema || budgetstore.ValidateReadIdentity(value.WorkspaceID, value.RunID, value.WorkflowID, value.WorkflowVersion) != nil ||
		!isHash(value.WorkflowSourceHash) || !isHash(value.ManifestHash) || !isHash(value.InputHash) ||
		value.Route.Backend != budgetstore.Backend || value.Route.Authority != budgetstore.Authority || value.Route.RoutingEpoch < 1 || value.Route.RoutingEpoch > authoritycontract.MaxSafeInteger || !isHash(value.Route.AuthorityBuildHash) ||
		value.Revision < 1 || value.Revision > authoritycontract.MaxSafeInteger || value.ResumeGeneration < 0 || value.ResumeGeneration > authoritycontract.MaxSafeInteger ||
		(value.CurrentPhaseID == nil) != (value.CurrentPhaseIndex == nil) {
		return false
	}
	if value.CurrentPhaseID != nil && (budgetstore.ValidateReadIdentity(*value.CurrentPhaseID) != nil || *value.CurrentPhaseIndex < 0 || *value.CurrentPhaseIndex > authoritycontract.MaxSafeInteger) {
		return false
	}
	for _, candidate := range authoritycontract.RunStates() {
		if value.State == candidate {
			return true
		}
	}
	return false
}

func readAccountRow(_ context.Context, row rowScanner, workspaceID, runID string) (budgetstore.Account, error) {
	account, _, err := readAccountStateRow(row, workspaceID, runID)
	return account, err
}

func readAccountStateRow(row rowScanner, workspaceID, runID string) (budgetstore.Account, budgetstore.Account, error) {
	var accountID, backend, authority string
	var policyHash, buildHash, genesisHash, genesisExact, accountHash, exact []byte
	var routingEpoch, accountRevision, runRevision int64
	var limitTokens, limitNanoUSD, limitCalls, reservedTokens, reservedNanoUSD, reservedCalls, settledTokens, settledNanoUSD, settledCalls int64
	var updatedAt time.Time
	if err := row.Scan(&accountID, &policyHash, &backend, &authority, &routingEpoch, &buildHash, &accountRevision, &runRevision,
		&limitTokens, &limitNanoUSD, &limitCalls, &reservedTokens, &reservedNanoUSD, &reservedCalls,
		&settledTokens, &settledNanoUSD, &settledCalls, &genesisHash, &genesisExact, &accountHash, &exact, &updatedAt); errors.Is(err, pgx.ErrNoRows) {
		return budgetstore.Account{}, budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorNotFound, "workflow budget account not found", err)
	} else if err != nil {
		return budgetstore.Account{}, budgetstore.Account{}, databaseFailure("read workflow budget account", err)
	}
	if len(policyHash) != sha256.Size || len(buildHash) != sha256.Size || len(genesisHash) != sha256.Size || len(accountHash) != sha256.Size {
		return budgetstore.Account{}, budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget account digest length is invalid", nil)
	}
	outer, err := budgetstore.DecodeDurableRecord(exact)
	if err != nil || outer.RecordKind != budgetstore.RecordKindAccount {
		return budgetstore.Account{}, budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget account bytes are invalid", err)
	}
	value, wantHash := outer.OperationalProjection, outer.OperationalProjectionHash
	if subtle.ConstantTimeCompare(accountHash, mustDecodeHash(wantHash)) != 1 || value["workspaceId"] != workspaceID || value["runId"] != runID || value["accountId"] != accountID ||
		value["policyHash"] != hex.EncodeToString(policyHash) || value["accountRevision"] != accountRevision || value["runRevision"] != runRevision || value["updatedAt"] != canonicalTimestamp(updatedAt) ||
		outer.AuthorityBuildHash != hex.EncodeToString(buildHash) ||
		!routeColumnsMatch(value["route"].(budgetcontract.Record), backend, authority, routingEpoch, buildHash) ||
		!quantityColumnsMatch(value["limit"].(budgetcontract.Record), limitTokens, limitNanoUSD, limitCalls) ||
		!quantityColumnsMatch(value["reserved"].(budgetcontract.Record), reservedTokens, reservedNanoUSD, reservedCalls) ||
		!quantityColumnsMatch(value["settled"].(budgetcontract.Record), settledTokens, settledNanoUSD, settledCalls) {
		return budgetstore.Account{}, budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget account columns do not match exact bytes", nil)
	}
	genesisOuter, err := budgetstore.DecodeDurableRecord(genesisExact)
	if err != nil || genesisOuter.RecordKind != budgetstore.RecordKindAccount {
		return budgetstore.Account{}, budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget genesis account bytes are invalid", err)
	}
	genesis, wantGenesisHash := genesisOuter.OperationalProjection, genesisOuter.OperationalProjectionHash
	genesisUpdatedAt, parseErr := time.Parse("2006-01-02T15:04:05.000Z", recordString(genesis, "updatedAt"))
	if parseErr != nil || subtle.ConstantTimeCompare(genesisHash, mustDecodeHash(wantGenesisHash)) != 1 ||
		genesisOuter.AuthorityBuildHash != hex.EncodeToString(buildHash) ||
		genesis["workspaceId"] != workspaceID || genesis["runId"] != runID || genesis["accountId"] != accountID ||
		genesis["policyHash"] != hex.EncodeToString(policyHash) || recordInt64(genesis, "accountRevision") != 0 ||
		recordInt64(genesis, "runRevision") < 1 || runRevision-recordInt64(genesis, "runRevision") != accountRevision ||
		genesisUpdatedAt.After(updatedAt) ||
		!routeColumnsMatch(genesis["route"].(budgetcontract.Record), backend, authority, routingEpoch, buildHash) ||
		!quantityColumnsMatch(genesis["limit"].(budgetcontract.Record), limitTokens, limitNanoUSD, limitCalls) ||
		!quantityColumnsMatch(genesis["reserved"].(budgetcontract.Record), 0, 0, 0) ||
		!quantityColumnsMatch(genesis["settled"].(budgetcontract.Record), 0, 0, 0) {
		return budgetstore.Account{}, budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget genesis account binding is invalid", parseErr)
	}
	head := budgetstore.Account{Value: value, Durable: outer, ExactBytes: append([]byte(nil), exact...), RecordHash: wantHash, UpdatedAt: updatedAt}
	anchor := budgetstore.Account{Value: genesis, Durable: genesisOuter, ExactBytes: append([]byte(nil), genesisExact...), RecordHash: wantGenesisHash, UpdatedAt: genesisUpdatedAt}
	return head, anchor, nil
}

func readReservationRow(_ context.Context, row rowScanner, workspaceID, runID string) (budgetstore.Reservation, error) {
	var accountID, reservationID, callID, backend, authority, rate, status string
	var providerHash, modelHash, providerRunHash, policyHash, buildHash, decisionHash, reservationHash, exact []byte
	var providerAttempt, routingEpoch, reservedTokens, reservedNanoUSD, reservedCalls, openedAccountRevision, openedRunRevision int64
	var terminalLedger pgtype.Text
	var openedAt time.Time
	var closedAt pgtype.Timestamptz
	if err := row.Scan(&accountID, &reservationID, &callID, &providerAttempt, &providerHash, &modelHash, &providerRunHash,
		&policyHash, &backend, &authority, &routingEpoch, &buildHash, &rate, &reservedTokens, &reservedNanoUSD, &reservedCalls,
		&decisionHash, &openedAccountRevision, &openedRunRevision, &reservationHash, &exact, &status, &terminalLedger, &openedAt, &closedAt); errors.Is(err, pgx.ErrNoRows) {
		return budgetstore.Reservation{}, budgetstore.Failure(budgetstore.ErrorNotFound, "workflow budget reservation not found", err)
	} else if err != nil {
		return budgetstore.Reservation{}, databaseFailure("read workflow budget reservation", err)
	}
	for _, digest := range [][]byte{providerHash, modelHash, providerRunHash, policyHash, buildHash, decisionHash, reservationHash} {
		if len(digest) != sha256.Size {
			return budgetstore.Reservation{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget reservation digest length is invalid", nil)
		}
	}
	outer, err := budgetstore.DecodeDurableRecord(exact)
	if err != nil || outer.RecordKind != budgetstore.RecordKindReservation {
		return budgetstore.Reservation{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget reservation bytes are invalid", err)
	}
	value, wantHash := outer.OperationalProjection, outer.OperationalProjectionHash
	if subtle.ConstantTimeCompare(reservationHash, mustDecodeHash(wantHash)) != 1 || value["workspaceId"] != workspaceID || value["runId"] != runID ||
		value["accountId"] != accountID || value["reservationId"] != reservationID || value["callId"] != callID || value["providerAttempt"] != strconv.FormatInt(providerAttempt, 10) ||
		value["expectedProviderHash"] != "sha256:"+hex.EncodeToString(providerHash) || value["expectedModelHash"] != "sha256:"+hex.EncodeToString(modelHash) ||
		value["expectedProviderRunHash"] != "sha256:"+hex.EncodeToString(providerRunHash) || value["policyHash"] != hex.EncodeToString(policyHash) ||
		outer.AuthorityBuildHash != hex.EncodeToString(buildHash) || !routeColumnsMatch(value["route"].(budgetcontract.Record), backend, authority, routingEpoch, buildHash) || value["rateNanoUsdPerToken"] != rate ||
		!quantityColumnsMatch(value["reserved"].(budgetcontract.Record), reservedTokens, reservedNanoUSD, reservedCalls) || value["reserveDecisionHash"] != hex.EncodeToString(decisionHash) ||
		value["openedAccountRevision"] != openedAccountRevision || value["openedRunRevision"] != openedRunRevision || value["openedAt"] != canonicalTimestamp(openedAt) {
		return budgetstore.Reservation{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget reservation columns do not match exact bytes", nil)
	}
	if status == "open" && (terminalLedger.Valid || closedAt.Valid) || status != "open" && (!terminalLedger.Valid || !closedAt.Valid) {
		return budgetstore.Reservation{}, budgetstore.Failure(budgetstore.ErrorIntegrity, "stored workflow budget reservation terminal shape is invalid", nil)
	}
	var terminal *string
	var closed *time.Time
	if terminalLedger.Valid {
		value := terminalLedger.String
		terminal = &value
		valueTime := closedAt.Time
		closed = &valueTime
	}
	return budgetstore.Reservation{Value: value, Durable: outer, ExactBytes: append([]byte(nil), exact...), RecordHash: wantHash, Status: status, TerminalLedgerEntryID: terminal, OpenedAt: openedAt, ClosedAt: closed}, nil
}

func routeColumnsMatch(route budgetcontract.Record, backend, authority string, epoch int64, build []byte) bool {
	return route["backend"] == backend && route["authority"] == authority && route["routingEpoch"] == epoch && route["authorityBuildHash"] == hex.EncodeToString(build)
}

func quantityColumnsMatch(value budgetcontract.Record, tokens, nanoUSD, calls int64) bool {
	return value["tokens"] == strconv.FormatInt(tokens, 10) && value["nanoUsd"] == strconv.FormatInt(nanoUSD, 10) && value["calls"] == strconv.FormatInt(calls, 10)
}

func sameNullableString(value *string, stored pgtype.Text) bool {
	return value == nil && !stored.Valid || value != nil && stored.Valid && *value == stored.String
}

func sameNullableInt64(value *int64, stored pgtype.Int8) bool {
	return value == nil && !stored.Valid || value != nil && stored.Valid && *value == stored.Int64
}

func insertReservation(ctx context.Context, tx pgx.Tx, value budgetcontract.Record) error {
	_, exact, hash, err := exactDurableRecord(budgetstore.RecordKindReservation, value, recordString(value["route"].(budgetcontract.Record), "authorityBuildHash"))
	if err != nil {
		return err
	}
	route := value["route"].(budgetcontract.Record)
	reserved := value["reserved"].(budgetcontract.Record)
	providerAttempt, _ := strconv.ParseInt(recordString(value, "providerAttempt"), 10, 64)
	openedAt, _ := time.Parse("2006-01-02T15:04:05.000Z", recordString(value, "openedAt"))
	_, err = tx.Exec(ctx, reservationInsertSQL,
		value["workspaceId"], value["runId"], value["accountId"], value["reservationId"], value["callId"], providerAttempt,
		mustPrefixedHash(recordString(value, "expectedProviderHash")), mustPrefixedHash(recordString(value, "expectedModelHash")), mustPrefixedHash(recordString(value, "expectedProviderRunHash")),
		mustDecodeHash(recordString(value, "policyHash")), route["backend"], route["authority"], route["routingEpoch"], mustDecodeHash(recordString(route, "authorityBuildHash")),
		value["rateNanoUsdPerToken"], decimalInt64(reserved["tokens"]), decimalInt64(reserved["nanoUsd"]), decimalInt64(reserved["calls"]),
		mustDecodeHash(recordString(value, "reserveDecisionHash")), value["openedAccountRevision"], value["openedRunRevision"], mustDecodeHash(hash), exact, openedAt,
	)
	if err != nil {
		return mapWriteFailure("insert workflow budget reservation", err)
	}
	return nil
}

func insertLedger(ctx context.Context, tx pgx.Tx, value budgetcontract.Record, exact []byte, hash string, request budgetcontract.Record) error {
	providerAttempt, _ := strconv.ParseInt(recordString(request, "providerAttempt"), 10, 64)
	recordedAt, _ := time.Parse("2006-01-02T15:04:05.000Z", recordString(value, "recordedAt"))
	_, err := tx.Exec(ctx, ledgerInsertSQL,
		value["entryId"], value["kind"], value["workspaceId"], value["runId"], value["accountId"], value["reservationId"], value["callId"], providerAttempt,
		value["accountRevision"], value["runRevision"], mustDecodeHash(recordString(value, "previousAccountHash")), mustDecodeHash(recordString(value, "accountHash")),
		mustDecodeHash(recordString(value, "decisionHash")), mustDecodeHash(hash), exact, recordedAt,
	)
	if err != nil {
		return mapWriteFailure("insert workflow budget ledger entry", err)
	}
	return nil
}

func persistAccount(ctx context.Context, tx pgx.Tx, before budgetstore.Account, exists bool, value budgetcontract.Record) error {
	_, exact, hash, err := exactDurableRecord(budgetstore.RecordKindAccount, value, recordString(value["route"].(budgetcontract.Record), "authorityBuildHash"))
	if err != nil {
		return err
	}
	route := value["route"].(budgetcontract.Record)
	limit := value["limit"].(budgetcontract.Record)
	reserved := value["reserved"].(budgetcontract.Record)
	settled := value["settled"].(budgetcontract.Record)
	updatedAt, _ := time.Parse("2006-01-02T15:04:05.000Z", recordString(value, "updatedAt"))
	if !exists {
		_, err = tx.Exec(ctx, accountInsertSQL,
			value["workspaceId"], value["runId"], value["accountId"], mustDecodeHash(recordString(value, "policyHash")), route["backend"], route["authority"], route["routingEpoch"], mustDecodeHash(recordString(route, "authorityBuildHash")),
			value["accountRevision"], value["runRevision"], decimalInt64(limit["tokens"]), decimalInt64(limit["nanoUsd"]), decimalInt64(limit["calls"]),
			decimalInt64(reserved["tokens"]), decimalInt64(reserved["nanoUsd"]), decimalInt64(reserved["calls"]), decimalInt64(settled["tokens"]), decimalInt64(settled["nanoUsd"]), decimalInt64(settled["calls"]),
			mustDecodeHash(before.RecordHash), before.ExactBytes, mustDecodeHash(hash), exact, updatedAt,
		)
	} else {
		tag, updateErr := tx.Exec(ctx, accountCASUpdateSQL,
			value["workspaceId"], value["runId"], value["accountId"], before.Value["accountRevision"], before.Value["runRevision"], mustDecodeHash(before.RecordHash),
			value["accountRevision"], value["runRevision"], decimalInt64(reserved["tokens"]), decimalInt64(reserved["nanoUsd"]), decimalInt64(reserved["calls"]),
			decimalInt64(settled["tokens"]), decimalInt64(settled["nanoUsd"]), decimalInt64(settled["calls"]), mustDecodeHash(hash), exact, updatedAt,
		)
		if updateErr == nil && tag.RowsAffected() != 1 {
			return budgetstore.Failure(budgetstore.ErrorConflict, "workflow budget account compare-and-swap lost", nil)
		}
		err = updateErr
	}
	if err != nil {
		return mapWriteFailure("persist workflow budget account", err)
	}
	return nil
}

func insertReceipt(ctx context.Context, tx pgx.Tx, receiptID string, prepared budgetcontract.PreparedRequest, receipt budgetcontract.Record, exactReceipt, exactResponse []byte, serviceBuildHash string) pgx.Row {
	var acceptedAccount, acceptedRun any
	if receipt["acceptedAccountRevision"] != nil {
		acceptedAccount, acceptedRun = receipt["acceptedAccountRevision"], receipt["acceptedRunRevision"]
	}
	var recordHash, ledgerHash any
	if receipt["recordHash"] != nil {
		recordHash, ledgerHash = mustDecodeHash(recordString(receipt, "recordHash")), mustDecodeHash(recordString(receipt, "ledgerEntryHash"))
	}
	var committedAt any
	if receipt["committedAt"] != nil {
		committedAt, _ = time.Parse("2006-01-02T15:04:05.000Z", recordString(receipt, "committedAt"))
	}
	return tx.QueryRow(ctx, receiptInsertSQL,
		receiptID, receipt["operation"], receipt["status"], prepared.IdempotencyKey, mustPrefixedHash(prepared.RequestFingerprint), mustDecodeHash(prepared.RequestHash),
		receipt["workspaceId"], receipt["runId"], receipt["accountId"], receipt["reservationId"], receipt["callId"], receipt["expectedAccountRevision"], acceptedAccount,
		receipt["expectedRunRevision"], acceptedRun, recordHash, ledgerHash, receipt["correlationId"], mustDecodeHash(serviceBuildHash), committedAt, receipt["reconciliationToken"], exactReceipt, exactResponse,
	)
}

func insertReconciliation(ctx context.Context, tx pgx.Tx, receiptID string, prepared budgetcontract.PreparedRequest, value budgetcontract.Record, exact []byte) error {
	digest := sha256.Sum256(exact)
	observedAt, _ := time.Parse("2006-01-02T15:04:05.000Z", recordString(value, "observedAt"))
	_, err := tx.Exec(ctx, reconciliationInsertSQL,
		value["reconciliationToken"], receiptID, value["evidenceType"], value["reasonCode"], prepared.IdempotencyKey,
		mustPrefixedHash(prepared.RequestFingerprint), mustDecodeHash(prepared.RequestHash), digest[:], value["workspaceId"], value["runId"], value["accountId"], value["reservationId"], value["callId"],
		mustDecodeHash(recordString(value, "accountHash")), mustDecodeHash(recordString(value, "reservationHash")), exact, observedAt,
	)
	if err != nil {
		return mapWriteFailure("insert workflow budget provider reconciliation", err)
	}
	return nil
}

func decimalInt64(value any) int64 {
	parsed, err := strconv.ParseInt(value.(string), 10, 64)
	if err != nil {
		panic(fmt.Sprintf("validated budget decimal %q did not fit int64", value))
	}
	return parsed
}
