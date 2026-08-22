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
	request, err := validateOperationRequest(operation, requestValue)
	if err != nil {
		return PreparedRequest{}, err
	}
	return prepareValidatedRequest(operation, request, callerIDValue)
}

// PrepareRequestBytes validates an exact canonical request body once and
// returns both the prepared transport binding and its validated record. This
// is the HTTP trust-boundary entry point; callers do not need to parse or
// validate the same body again before handing it to the durable store.
func PrepareRequestBytes(operation string, bodyBytes []byte, callerIDValue string) (PreparedRequest, Record, error) {
	if len(bodyBytes) == 0 || len(bodyBytes) > MaxRecordBytes || bodyBytes[len(bodyBytes)-1] != '\n' || (len(bodyBytes) > 1 && bodyBytes[len(bodyBytes)-2] == '\n') {
		return PreparedRequest{}, nil, failure(ErrorInvalid, "$/body", "Prepared request body framing is invalid.")
	}
	parsed, err := ParseBytes(bodyBytes[:len(bodyBytes)-1])
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	request, err := validateOperationRequest(operation, parsed)
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	canonical, err := CanonicalJSON(request)
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	if canonical+"\n" != string(bodyBytes) {
		return PreparedRequest{}, nil, failure(ErrorHashMismatch, "$/body", "Prepared request body is not canonical.")
	}
	prepared, err := prepareValidatedRequest(operation, request, callerIDValue)
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	return prepared, request, nil
}

func validateOperationRequest(operation string, requestValue any) (Record, error) {
	switch operation {
	case "reserve":
		return ValidateReserveRequest(requestValue)
	case "settle":
		return ValidateSettlementRequest(requestValue)
	default:
		return nil, failure(ErrorInvalid, "$/operation", "$/operation is outside the closed vocabulary.")
	}
}

func prepareValidatedRequest(operation string, request Record, callerIDValue string) (PreparedRequest, error) {
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
	return PreparedRequest{Schema: SchemaPreparedRequest, Operation: operation, Method: "POST", Path: path, CallerID: callerID, Body: body, RequestHash: requestHash, IdempotencyKey: IdempotencyPrefix + requestHash, RequestFingerprint: "sha256:" + fingerprintHash}, nil
}

func ValidatePreparedRequest(value any) (PreparedRequest, error) {
	prepared, _, err := ValidatePreparedRequestRecord(value)
	return prepared, err
}

// ValidatePreparedRequestRecord validates a prepared request and returns the
// exact request record decoded from its canonical body in the same pass.
func ValidatePreparedRequestRecord(value any) (PreparedRequest, Record, error) {
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
			return PreparedRequest{}, nil, failure(ErrorInvalid, "$", "$ must be a data object.")
		}
		return ValidatePreparedRequestRecord(*value)
	default:
		var err error
		raw, err = asRecord(value, "$")
		if err != nil {
			return PreparedRequest{}, nil, err
		}
	}
	root, err := closed(raw, []string{"schema", "operation", "method", "path", "callerId", "body", "requestHash", "idempotencyKey", "requestFingerprint"}, "$")
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	operation, err := enumString(root["operation"], []string{"reserve", "settle"}, "$/operation")
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	path, _ := operationPath(operation)
	if _, err := literalString(root["path"], path, "$/path"); err != nil {
		return PreparedRequest{}, nil, err
	}
	callerID, err := identifier(root["callerId"], "$/callerId")
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	body, err := stringValue(root["body"], "$/body")
	if err != nil || len([]byte(body)) > MaxRecordBytes || !strings.HasSuffix(body, "\n") || strings.HasSuffix(body, "\n\n") {
		return PreparedRequest{}, nil, failure(ErrorInvalid, "$/body", "Prepared request body framing is invalid.")
	}
	parsed, err := ParseBytes([]byte(strings.TrimSuffix(body, "\n")))
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	request, err := validateOperationRequest(operation, parsed)
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	canonical, _ := CanonicalJSON(request)
	if canonical+"\n" != body {
		return PreparedRequest{}, nil, failure(ErrorHashMismatch, "$/body", "Prepared request body is not canonical.")
	}
	requestHash, err := hash(root["requestHash"], "$/requestHash")
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	digest := sha256.Sum256([]byte(body))
	if hex.EncodeToString(digest[:]) != requestHash {
		return PreparedRequest{}, nil, failure(ErrorHashMismatch, "$/requestHash", "Prepared request hash drifted.")
	}
	idempotency, err := stringValue(root["idempotencyKey"], "$/idempotencyKey")
	if err != nil || idempotency != IdempotencyPrefix+requestHash {
		return PreparedRequest{}, nil, failure(ErrorHashMismatch, "$/idempotencyKey", "Idempotency key drifted.")
	}
	fingerprint, err := prefixedHash(root["requestFingerprint"], "$/requestFingerprint")
	if err != nil {
		return PreparedRequest{}, nil, err
	}
	fingerprintHash, _ := hashValue("request-fingerprint", Record{"callerId": callerID, "method": "POST", "operation": operation, "path": path, "requestHash": requestHash, "workspaceId": request["workspaceId"]})
	if fingerprint != "sha256:"+fingerprintHash {
		return PreparedRequest{}, nil, failure(ErrorHashMismatch, "$/requestFingerprint", "Request fingerprint drifted.")
	}
	if _, err := literalString(root["schema"], SchemaPreparedRequest, "$/schema"); err != nil {
		return PreparedRequest{}, nil, err
	}
	if _, err := literalString(root["method"], "POST", "$/method"); err != nil {
		return PreparedRequest{}, nil, err
	}
	return PreparedRequest{Schema: SchemaPreparedRequest, Operation: operation, Method: "POST", Path: path, CallerID: callerID, Body: body, RequestHash: requestHash, IdempotencyKey: idempotency, RequestFingerprint: fingerprint}, request, nil
}

func ValidateReceiptForRequest(receiptValue, preparedValue any) (Record, error) {
	receipt, err := ValidateReceipt(receiptValue)
	if err != nil {
		return nil, err
	}
	prepared, request, err := ValidatePreparedRequestRecord(preparedValue)
	if err != nil {
		return nil, err
	}
	return bindReceiptToPreparedRequest(receipt, prepared, request)
}

func bindReceiptToPreparedRequest(receipt Record, prepared PreparedRequest, request Record) (Record, error) {
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
type ValidatedReceiptResult struct {
	Receipt Record
	Record  Record
	Ledger  Record
}

func ValidateReceiptResult(receiptValue, preparedValue, recordValue, ledgerValue, reconciliationValue any) (ValidatedReceiptResult, error) {
	receipt, err := ValidateReceipt(receiptValue)
	if err != nil {
		return ValidatedReceiptResult{}, err
	}
	prepared, preparedRequest, err := ValidatePreparedRequestRecord(preparedValue)
	if err != nil {
		return ValidatedReceiptResult{}, err
	}
	receipt, err = bindReceiptToPreparedRequest(receipt, prepared, preparedRequest)
	if err != nil {
		return ValidatedReceiptResult{}, err
	}
	ledger, err := ValidateLedgerEntry(ledgerValue)
	if err != nil {
		return ValidatedReceiptResult{}, err
	}
	var record Record
	var canonicalRecordRequest string
	recordDomain := "settlement"
	if receipt["operation"] == "reserve" {
		record, canonicalRecordRequest, err = validateReserveDecisionWithRequest(recordValue)
		recordDomain = "reserve-decision"
	} else {
		record, err = ValidateSettlement(recordValue)
		if err == nil {
			canonicalRecordRequest, err = CanonicalJSON(record["request"])
		}
	}
	if err != nil {
		return ValidatedReceiptResult{}, err
	}
	preparedCanonical := strings.TrimSuffix(prepared.Body, "\n")
	if canonicalRecordRequest != preparedCanonical {
		return ValidatedReceiptResult{}, failure(ErrorIdentityMismatch, "$/request", "Durable budget result does not bind the prepared request.")
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
		return ValidatedReceiptResult{}, failure(ErrorIdentityMismatch, "$", "Receipt does not bind the durable budget result.")
	}
	if record["schema"] == SchemaSettlement && record["status"] == "reconciliation_required" {
		reconciliation, reconcileErr := ValidateReconciliation(reconciliationValue)
		if reconcileErr != nil {
			return ValidatedReceiptResult{}, reconcileErr
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
			return ValidatedReceiptResult{}, failure(ErrorIdentityMismatch, "$/reconciliationToken", "Provider reconciliation receipt binding drifted.")
		}
	} else if receipt["status"] != "accepted" || !nilBudgetRecord(reconciliationValue) {
		return ValidatedReceiptResult{}, failure(ErrorIdentityMismatch, "$/status", "Accepted result receipt status drifted.")
	}
	return ValidatedReceiptResult{Receipt: receipt, Record: record, Ledger: ledger}, nil
}

func ValidateReceiptForResult(receiptValue, preparedValue, recordValue, ledgerValue, reconciliationValue any) (Record, error) {
	result, err := ValidateReceiptResult(receiptValue, preparedValue, recordValue, ledgerValue, reconciliationValue)
	return result.Receipt, err
}

// nilBudgetRecord treats a typed nil Record passed through an interface as the
// absent reconciliation value represented by JSON null. Store and HTTP
// composition paths naturally carry optional records as Record(nil); requiring
// callers to erase that type before validation would make the exact contract
// depend on a Go interface representation detail.
func nilBudgetRecord(value any) bool {
	switch value := value.(type) {
	case nil:
		return true
	case Record:
		return value == nil
	case map[string]any:
		return value == nil
	default:
		return false
	}
}
