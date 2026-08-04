package authoritycontract

var receiptFields = []string{
	"schema", "operation", "status", "workspaceId", "runId", "expectedRevision",
	"acceptedRevision", "resumeGeneration", "route", "idempotencyKey", "requestFingerprint",
	"requestHash", "recordHash", "correlationId", "serviceBuildHash", "committedAt", "reconciliationToken",
}

func DecodeReceiptJSON(input []byte) (Receipt, error) {
	if len(input) > MaxReceiptBytes {
		return Receipt{}, failure(ErrorLimitExceeded, "$", "receipt exceeds its byte limit")
	}
	value, err := parseStrictJSON(input, MaxJSONDepth, MaxJSONNodes, MaxStringBytes)
	if err != nil {
		return Receipt{}, normalizeStrictJSONError(err)
	}
	return ValidateReceipt(value)
}

func ValidateReceipt(value any) (Receipt, error) {
	root, err := closedRecord(value, receiptFields, "$")
	if err != nil {
		return Receipt{}, err
	}
	if root["schema"] != ReceiptSchema {
		return Receipt{}, failure(ErrorInvalid, "$/schema", "receipt schema is invalid")
	}
	operation, err := requireEnum(root["operation"], "$/operation", receiptOperations)
	if err != nil {
		return Receipt{}, err
	}
	statuses := []ReceiptStatus{ReceiptAccepted, ReceiptDuplicate, ReceiptReconciliationRequired}
	status, err := requireEnum(root["status"], "$/status", statuses)
	if err != nil {
		return Receipt{}, err
	}
	workspaceID, err := requireIdentifier(root["workspaceId"], "$/workspaceId")
	if err != nil {
		return Receipt{}, err
	}
	runID, err := requireIdentifier(root["runId"], "$/runId")
	if err != nil {
		return Receipt{}, err
	}
	expectedRevision, err := requireInteger(root["expectedRevision"], "$/expectedRevision", 0)
	if err != nil {
		return Receipt{}, err
	}
	acceptedRevision, err := nullableInteger(root["acceptedRevision"], "$/acceptedRevision", 1)
	if err != nil {
		return Receipt{}, err
	}
	resumeGeneration, err := requireInteger(root["resumeGeneration"], "$/resumeGeneration", 0)
	if err != nil {
		return Receipt{}, err
	}
	route, err := validateRoute(root["route"], "$/route")
	if err != nil {
		return Receipt{}, err
	}
	idempotencyKey, err := requireString(root["idempotencyKey"], "$/idempotencyKey", 128, idempotencyPattern)
	if err != nil {
		return Receipt{}, err
	}
	requestFingerprint, err := requireString(root["requestFingerprint"], "$/requestFingerprint", 71, fingerprintPattern)
	if err != nil {
		return Receipt{}, err
	}
	requestHash, err := requireHash(root["requestHash"], "$/requestHash")
	if err != nil {
		return Receipt{}, err
	}
	recordHash, err := nullableString(root["recordHash"], "$/recordHash", requireHash)
	if err != nil {
		return Receipt{}, err
	}
	correlationID, err := requireIdentifier(root["correlationId"], "$/correlationId")
	if err != nil {
		return Receipt{}, err
	}
	serviceBuildHash, err := requireHash(root["serviceBuildHash"], "$/serviceBuildHash")
	if err != nil {
		return Receipt{}, err
	}
	committedAt, err := nullableString(root["committedAt"], "$/committedAt", requireTimestamp)
	if err != nil {
		return Receipt{}, err
	}
	reconciliationToken, err := nullableString(root["reconciliationToken"], "$/reconciliationToken", requireReference)
	if err != nil {
		return Receipt{}, err
	}
	if status == ReceiptReconciliationRequired {
		if acceptedRevision != nil || committedAt != nil || recordHash != nil || reconciliationToken == nil {
			return Receipt{}, failure(ErrorReconciliationRequired, "$", "reconciliation receipt must not claim a committed record")
		}
	} else if acceptedRevision == nil || *acceptedRevision != expectedRevision+1 || committedAt == nil || recordHash == nil || reconciliationToken != nil {
		return Receipt{}, failure(ErrorStaleRevision, "$/acceptedRevision", "committed receipt revision is invalid")
	}
	result := Receipt{
		Schema: ReceiptSchema, Operation: operation, Status: status, WorkspaceID: workspaceID,
		RunID: runID, ExpectedRevision: expectedRevision, AcceptedRevision: acceptedRevision,
		ResumeGeneration: resumeGeneration, Route: route, IdempotencyKey: idempotencyKey,
		RequestFingerprint: requestFingerprint, RequestHash: requestHash, RecordHash: recordHash,
		CorrelationID: correlationID, ServiceBuildHash: serviceBuildHash, CommittedAt: committedAt,
		ReconciliationToken: reconciliationToken,
	}
	if err := requireCanonicalSize(result, MaxReceiptBytes, "$"); err != nil {
		return Receipt{}, err
	}
	return result, nil
}
