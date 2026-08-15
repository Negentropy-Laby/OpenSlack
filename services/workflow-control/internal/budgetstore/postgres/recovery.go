package postgres

import (
	"context"
	"crypto/subtle"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
)

type databaseReconciliationEvidence struct {
	accountHash     string
	reservationHash string
}

func (repository *Repository) resolveCommitOutcome(input budgetstore.MutationInput, request budgetcontract.Record, fingerprint []byte, evidence databaseReconciliationEvidence, commitErr error) (budgetstore.MutationResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
	defer cancel()
	existing, raw, err := readMutationResult(ctx, repository.pool, input.Prepared.IdempotencyKey)
	if err == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) == 1 {
			return existing, nil
		}
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorIdempotencyConflict, "commit recovery found another budget request fingerprint", commitErr)
	}
	if budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
		return budgetstore.MutationResult{}, err
	}
	if !budgetstore.IsCode(err, budgetstore.ErrorNotFound) {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "budget commit outcome could not be read", errors.Join(commitErr, err))
	}
	return repository.persistDatabaseReconciliation(ctx, input, request, fingerprint, evidence, commitErr)
}

func (repository *Repository) persistDatabaseReconciliation(ctx context.Context, input budgetstore.MutationInput, request budgetcontract.Record, fingerprint []byte, evidence databaseReconciliationEvidence, commitErr error) (budgetstore.MutationResult, error) {
	receiptID, idErr := randomToken("wf-budget-receipt")
	token, tokenErr := randomToken(budgetstore.ReconciliationPrefix)
	if idErr != nil || tokenErr != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "generate workflow budget database reconciliation identity", errors.Join(commitErr, idErr, tokenErr))
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "begin workflow budget database reconciliation", errors.Join(commitErr, err))
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScope(ctx, tx, input.Prepared.IdempotencyKey, recordString(request, "workspaceId"), recordString(request, "runId")); err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "lock workflow budget database reconciliation", errors.Join(commitErr, err))
	}
	if existing, raw, readErr := readMutationResult(ctx, tx, input.Prepared.IdempotencyKey); readErr == nil {
		if subtle.ConstantTimeCompare(raw, fingerprint) == 1 {
			return existing, nil
		}
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorIdempotencyConflict, "database reconciliation found another budget request fingerprint", commitErr)
	} else if !budgetstore.IsCode(readErr, budgetstore.ErrorNotFound) {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "read workflow budget database reconciliation receipt", errors.Join(commitErr, readErr))
	}
	var observedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT date_trunc('milliseconds', clock_timestamp())`).Scan(&observedAt); err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "read workflow budget database reconciliation timestamp", errors.Join(commitErr, err))
	}
	observedText := canonicalTimestamp(observedAt)
	reconciliation := authorityEnvelope()
	for key, value := range (budgetcontract.Record{
		"schema": budgetcontract.SchemaReconciliation, "evidenceType": "database_commit", "reasonCode": "database_commit_outcome_unknown",
		"workspaceId": request["workspaceId"], "runId": request["runId"], "accountId": request["accountId"],
		"reservationId": request["reservationId"], "callId": request["callId"], "sourceRequestHash": input.Prepared.RequestHash,
		"usageReceiptHash": nil, "accountHash": evidence.accountHash, "reservationHash": evidence.reservationHash,
		"reconciliationToken": token, "accountCountersChanged": false, "reservationReleaseAuthorized": false,
		"providerRetryAuthorized": false, "cachePublishAuthorized": false, "runReconciliationLatched": true,
		"observedAt": observedText,
	}) {
		reconciliation[key] = value
	}
	validatedReconciliation, err := budgetcontract.ValidateReconciliation(reconciliation)
	if err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "build workflow budget database reconciliation", errors.Join(commitErr, err))
	}
	receipt := authorityEnvelope()
	for key, value := range (budgetcontract.Record{
		"schema": budgetcontract.SchemaReceipt, "operation": input.Prepared.Operation, "status": "database_reconciliation_required",
		"workspaceId": request["workspaceId"], "runId": request["runId"], "accountId": request["accountId"], "reservationId": request["reservationId"], "callId": request["callId"],
		"expectedAccountRevision": request["expectedAccountRevision"], "acceptedAccountRevision": nil,
		"expectedRunRevision": request["expectedRunRevision"], "acceptedRunRevision": nil,
		"idempotencyKey": input.Prepared.IdempotencyKey, "requestFingerprint": input.Prepared.RequestFingerprint,
		"requestHash": input.Prepared.RequestHash, "recordHash": nil, "ledgerEntryHash": nil,
		"correlationId": request["correlationId"], "serviceBuildHash": input.ServiceBuildHash,
		"committedAt": nil, "reconciliationToken": token,
	}) {
		receipt[key] = value
	}
	validatedReceipt, err := budgetcontract.ValidateReceiptForRequest(receipt, input.Prepared)
	if err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "build workflow budget database reconciliation receipt", errors.Join(commitErr, err))
	}
	receiptOuter, receiptBytes, _, err := exactDurableRecord(budgetstore.RecordKindReceipt, validatedReceipt, input.ServiceBuildHash)
	if err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "encode workflow budget database reconciliation receipt", errors.Join(commitErr, err))
	}
	reconciliationOuter, reconciliationBytes, _, err := exactDurableRecord(budgetstore.RecordKindReconciliation, validatedReconciliation, input.ServiceBuildHash)
	if err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "encode workflow budget database reconciliation", errors.Join(commitErr, err))
	}
	responseBytes, err := budgetstore.EncodeMutationResponse(input.Prepared.Operation, nil, receiptOuter, &reconciliationOuter)
	if err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "encode workflow budget database reconciliation response", errors.Join(commitErr, err))
	}
	var recordedAt time.Time
	if err := insertReceipt(ctx, tx, receiptID, input.Prepared, validatedReceipt, receiptBytes, responseBytes, input.ServiceBuildHash).Scan(&recordedAt); err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "insert workflow budget database reconciliation receipt", errors.Join(commitErr, err))
	}
	if err := insertReconciliation(ctx, tx, receiptID, input.Prepared, validatedReconciliation, reconciliationBytes); err != nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "insert workflow budget database reconciliation evidence", errors.Join(commitErr, err))
	}
	result := budgetstore.MutationResult{
		Operation: input.Prepared.Operation, Status: "database_reconciliation_required",
		Reconciliation: validatedReconciliation, Receipt: validatedReceipt,
		ExactReceiptBytes: receiptBytes, ExactReconciliationBytes: reconciliationBytes, ExactResponseBytes: responseBytes,
		DurableReconciliation: &reconciliationOuter, DurableReceipt: receiptOuter,
		Response:  budgetstore.MutationResponse{Schema: budgetstore.MutationResponseSchema, Operation: input.Prepared.Operation, Receipt: receiptOuter, Reconciliation: &reconciliationOuter},
		ReceiptID: receiptID, RecordedAt: recordedAt,
	}
	commit := repository.commitReconciliation
	if commit == nil {
		commit = func(ctx context.Context, tx pgx.Tx) error { return tx.Commit(ctx) }
	}
	if reconciliationErr := commit(ctx, tx); reconciliationErr != nil {
		verificationContext, cancel := context.WithTimeout(context.Background(), reconciliationTimeout)
		defer cancel()
		verified, raw, readErr := readMutationResult(verificationContext, repository.pool, input.Prepared.IdempotencyKey)
		if readErr == nil && subtle.ConstantTimeCompare(raw, fingerprint) == 1 && verified.Status == "database_reconciliation_required" {
			return verified, nil
		}
		if budgetstore.IsCode(readErr, budgetstore.ErrorIntegrity) {
			return budgetstore.MutationResult{}, readErr
		}
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorCommitUnknown, "workflow budget database reconciliation commit outcome is unknown", errors.Join(commitErr, reconciliationErr, readErr))
	}
	return result, nil
}
