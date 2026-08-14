package budgetcontract

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

func operationPath(operation string) (string, error) {
	switch operation {
	case "reserve":
		return ReserveRoute, nil
	case "settle":
		return SettleRoute, nil
	default:
		return "", failure(ErrorInvalid, "$/operation", "$/operation is outside the closed vocabulary.")
	}
}

func PrepareRequest(operation string, requestValue any, callerIDValue string) (PreparedRequest, error) {
	var request Record
	var err error
	switch operation {
	case "reserve":
		request, err = ValidateReserveRequest(requestValue)
	case "settle":
		request, err = ValidateSettlementRequest(requestValue)
	default:
		return PreparedRequest{}, failure(ErrorInvalid, "$/operation", "$/operation is outside the closed vocabulary.")
	}
	if err != nil {
		return PreparedRequest{}, err
	}
	callerID, err := identifier(callerIDValue, "$/callerId")
	if err != nil {
		return PreparedRequest{}, err
	}
	canonical, err := CanonicalJSON(request)
	if err != nil {
		return PreparedRequest{}, err
	}
	body := canonical + "\n"
	digest := sha256.Sum256([]byte(body))
	requestHash := hex.EncodeToString(digest[:])
	path, _ := operationPath(operation)
	fingerprintHash, _ := hashValue("request-fingerprint", Record{"callerId": callerID, "method": "POST", "operation": operation, "path": path, "requestHash": requestHash, "workspaceId": request["workspaceId"]})
	return ValidatePreparedRequest(PreparedRequest{Schema: SchemaPreparedRequest, Operation: operation, Method: "POST", Path: path, CallerID: callerID, Body: body, RequestHash: requestHash, IdempotencyKey: IdempotencyPrefix + requestHash, RequestFingerprint: "sha256:" + fingerprintHash})
}

func ValidatePreparedRequest(value any) (PreparedRequest, error) {
	var raw Record
	switch value := value.(type) {
	case PreparedRequest:
		raw = Record{
			"schema": value.Schema, "operation": value.Operation, "method": value.Method,
			"path": value.Path, "callerId": value.CallerID, "body": value.Body,
			"requestHash": value.RequestHash, "idempotencyKey": value.IdempotencyKey,
			"requestFingerprint": value.RequestFingerprint,
		}
	case *PreparedRequest:
		if value == nil {
			return PreparedRequest{}, failure(ErrorInvalid, "$", "$ must be a data object.")
		}
		return ValidatePreparedRequest(*value)
	default:
		var err error
		raw, err = asRecord(value, "$")
		if err != nil {
			return PreparedRequest{}, err
		}
	}
	root, err := closed(raw, []string{"schema", "operation", "method", "path", "callerId", "body", "requestHash", "idempotencyKey", "requestFingerprint"}, "$")
	if err != nil {
		return PreparedRequest{}, err
	}
	operation, err := enumString(root["operation"], []string{"reserve", "settle"}, "$/operation")
	if err != nil {
		return PreparedRequest{}, err
	}
	path, _ := operationPath(operation)
	if _, err := literalString(root["path"], path, "$/path"); err != nil {
		return PreparedRequest{}, err
	}
	callerID, err := identifier(root["callerId"], "$/callerId")
	if err != nil {
		return PreparedRequest{}, err
	}
	body, err := stringValue(root["body"], "$/body")
	if err != nil || len([]byte(body)) > MaxRecordBytes || !strings.HasSuffix(body, "\n") || strings.HasSuffix(body, "\n\n") {
		return PreparedRequest{}, failure(ErrorInvalid, "$/body", "Prepared request body framing is invalid.")
	}
	parsed, err := ParseBytes([]byte(strings.TrimSuffix(body, "\n")))
	if err != nil {
		return PreparedRequest{}, err
	}
	var request Record
	if operation == "reserve" {
		request, err = ValidateReserveRequest(parsed)
	} else {
		request, err = ValidateSettlementRequest(parsed)
	}
	if err != nil {
		return PreparedRequest{}, err
	}
	canonical, _ := CanonicalJSON(request)
	if canonical+"\n" != body {
		return PreparedRequest{}, failure(ErrorHashMismatch, "$/body", "Prepared request body is not canonical.")
	}
	requestHash, err := hash(root["requestHash"], "$/requestHash")
	if err != nil {
		return PreparedRequest{}, err
	}
	digest := sha256.Sum256([]byte(body))
	if hex.EncodeToString(digest[:]) != requestHash {
		return PreparedRequest{}, failure(ErrorHashMismatch, "$/requestHash", "Prepared request hash drifted.")
	}
	idempotency, err := stringValue(root["idempotencyKey"], "$/idempotencyKey")
	if err != nil || idempotency != IdempotencyPrefix+requestHash {
		return PreparedRequest{}, failure(ErrorHashMismatch, "$/idempotencyKey", "Idempotency key drifted.")
	}
	fingerprint, err := prefixedHash(root["requestFingerprint"], "$/requestFingerprint")
	if err != nil {
		return PreparedRequest{}, err
	}
	fingerprintHash, _ := hashValue("request-fingerprint", Record{"callerId": callerID, "method": "POST", "operation": operation, "path": path, "requestHash": requestHash, "workspaceId": request["workspaceId"]})
	if fingerprint != "sha256:"+fingerprintHash {
		return PreparedRequest{}, failure(ErrorHashMismatch, "$/requestFingerprint", "Request fingerprint drifted.")
	}
	if _, err := literalString(root["schema"], SchemaPreparedRequest, "$/schema"); err != nil {
		return PreparedRequest{}, err
	}
	if _, err := literalString(root["method"], "POST", "$/method"); err != nil {
		return PreparedRequest{}, err
	}
	return PreparedRequest{Schema: SchemaPreparedRequest, Operation: operation, Method: "POST", Path: path, CallerID: callerID, Body: body, RequestHash: requestHash, IdempotencyKey: idempotency, RequestFingerprint: fingerprint}, nil
}

func ValidateReceiptForRequest(receiptValue, preparedValue any) (Record, error) {
	receipt, err := ValidateReceipt(receiptValue)
	if err != nil {
		return nil, err
	}
	prepared, err := ValidatePreparedRequest(preparedValue)
	if err != nil {
		return nil, err
	}
	parsed, err := ParseBytes([]byte(strings.TrimSuffix(prepared.Body, "\n")))
	if err != nil {
		return nil, err
	}
	var request Record
	if prepared.Operation == "reserve" {
		request, err = ValidateReserveRequest(parsed)
	} else {
		request, err = ValidateSettlementRequest(parsed)
	}
	if err != nil {
		return nil, err
	}
	pairs := [][2]any{{receipt["operation"], prepared.Operation}, {receipt["workspaceId"], request["workspaceId"]}, {receipt["runId"], request["runId"]}, {receipt["accountId"], request["accountId"]}, {receipt["reservationId"], request["reservationId"]}, {receipt["callId"], request["callId"]}, {receipt["expectedAccountRevision"], request["expectedAccountRevision"]}, {receipt["expectedRunRevision"], request["expectedRunRevision"]}, {receipt["correlationId"], request["correlationId"]}, {receipt["requestHash"], prepared.RequestHash}, {receipt["idempotencyKey"], prepared.IdempotencyKey}, {receipt["requestFingerprint"], prepared.RequestFingerprint}}
	for _, pair := range pairs {
		if pair[0] != pair[1] {
			return nil, failure(ErrorIdentityMismatch, "$", "Receipt does not bind the prepared request.")
		}
	}
	route := request["route"].(Record)
	if receipt["serviceBuildHash"] != route["authorityBuildHash"] {
		return nil, failure(ErrorIdentityMismatch, "$", "Receipt does not bind the prepared request.")
	}
	return receipt, nil
}

// ValidateReceiptForResult proves that a non-ambiguous receipt binds the exact
// durable decision, ledger entry, and (when required) provider reconciliation.
// Database-unknown receipts intentionally cannot pass this validator because
// their durable mutation outcome is not known.
func ValidateReceiptForResult(receiptValue, preparedValue, recordValue, ledgerValue, reconciliationValue any) (Record, error) {
	receipt, err := ValidateReceiptForRequest(receiptValue, preparedValue)
	if err != nil {
		return nil, err
	}
	ledger, err := ValidateLedgerEntry(ledgerValue)
	if err != nil {
		return nil, err
	}
	var record Record
	recordDomain := "settlement"
	if receipt["operation"] == "reserve" {
		record, err = ValidateReserveDecision(recordValue)
		recordDomain = "reserve-decision"
	} else {
		record, err = ValidateSettlement(recordValue)
	}
	if err != nil {
		return nil, err
	}
	recordHash, _ := hashValue(recordDomain, record)
	ledgerHash, _ := hashValue("ledger-entry", ledger)
	expectedLedgerKind := "settlement_reconciliation_required"
	if record["schema"] == SchemaReserveDecision {
		expectedLedgerKind = "reserve_rejected"
		if record["status"] == "reserved" {
			expectedLedgerKind = "reserve_reserved"
		}
	} else if record["status"] == "settled" {
		expectedLedgerKind = "settlement_settled"
	}
	after := record["afterAccount"].(Record)
	accountHash, _ := hashValue("account", after)
	if receipt["status"] == "database_reconciliation_required" ||
		receipt["recordHash"] != recordHash || receipt["ledgerEntryHash"] != ledgerHash ||
		receipt["acceptedAccountRevision"] != after["accountRevision"] || receipt["acceptedRunRevision"] != after["runRevision"] ||
		receipt["committedAt"] != after["updatedAt"] || ledger["kind"] != expectedLedgerKind ||
		ledger["decisionHash"] != recordHash || ledger["accountHash"] != accountHash ||
		ledger["accountRevision"] != after["accountRevision"] || ledger["runRevision"] != after["runRevision"] {
		return nil, failure(ErrorIdentityMismatch, "$", "Receipt does not bind the durable budget result.")
	}
	if record["schema"] == SchemaSettlement && record["status"] == "reconciliation_required" {
		reconciliation, reconcileErr := ValidateReconciliation(reconciliationValue)
		if reconcileErr != nil {
			return nil, reconcileErr
		}
		request := record["request"].(Record)
		if receipt["status"] != "provider_reconciliation_required" ||
			reconciliation["evidenceType"] != "provider_outcome" ||
			receipt["reconciliationToken"] != reconciliation["reconciliationToken"] ||
			reconciliation["reasonCode"] != record["reasonCode"] ||
			reconciliation["sourceRequestHash"] != record["requestHash"] ||
			reconciliation["usageReceiptHash"] != request["usageReceiptHash"] ||
			reconciliation["accountHash"] != accountHash ||
			reconciliation["reservationHash"] != record["reservationHash"] ||
			reconciliation["observedAt"] != record["committedAt"] {
			return nil, failure(ErrorIdentityMismatch, "$/reconciliationToken", "Provider reconciliation receipt binding drifted.")
		}
	} else if receipt["status"] != "accepted" || reconciliationValue != nil {
		return nil, failure(ErrorIdentityMismatch, "$/status", "Accepted result receipt status drifted.")
	}
	return receipt, nil
}
