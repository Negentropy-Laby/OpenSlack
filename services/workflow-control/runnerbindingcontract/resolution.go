package runnerbindingcontract

var resolutionFields = []string{
	"schema", "contractVersion", "profile", "phase", "direction", "companionSequence", "bindingId", "operation",
	"stageHash", "stageReceiptHash", "targetBodyHash", "evidence", "evidenceHash", "sentAt",
}

func ValidateResolution(value any) (Record, error) {
	record, err := closedRecord(value, resolutionFields, "$")
	if err != nil {
		return nil, err
	}
	operation, err := operationValue(record["operation"], "$/operation")
	if err != nil {
		return nil, err
	}
	evidence, err := validateEvidence(record["evidence"], operation, "$/evidence")
	if err != nil {
		return nil, err
	}
	if err := byteBound(evidence, MaxEvidenceBytes, "$/evidence"); err != nil {
		return nil, err
	}
	evidenceHash, err := hashValue(record["evidenceHash"], "$/evidenceHash")
	if err != nil {
		return nil, err
	}
	calculatedEvidenceHash, err := hashValidatedEvidence(evidence)
	if err != nil {
		return nil, err
	}
	if evidenceHash != calculatedEvidenceHash {
		return nil, failure(ErrorHashMismatch, "$/evidenceHash", "Authority evidence hash drifted.")
	}
	result := Record{"operation": string(operation), "evidence": evidence, "evidenceHash": evidenceHash}
	for _, field := range []struct {
		name     string
		expected string
	}{
		{"schema", ResolutionSchema},
		{"contractVersion", ContractVersion},
		{"profile", FutureRuntimeProfile},
		{"phase", "commit_authority"},
		{"direction", "runner-to-control"},
	} {
		if result[field.name], err = literalString(record[field.name], field.expected, "$/"+field.name); err != nil {
			return nil, err
		}
	}
	if result["companionSequence"], err = literalInteger(record["companionSequence"], 2, "$/companionSequence"); err != nil {
		return nil, err
	}
	if result["bindingId"], err = identifier(record["bindingId"], "$/bindingId"); err != nil {
		return nil, err
	}
	for _, field := range []string{"stageHash", "stageReceiptHash", "targetBodyHash"} {
		if result[field], err = hashValue(record[field], "$/"+field); err != nil {
			return nil, err
		}
	}
	if result["sentAt"], err = timestampValue(record["sentAt"], "$/sentAt"); err != nil {
		return nil, err
	}
	if err := byteBound(result, MaxFrameBytes, "$"); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateResolutionForStage(value, stageValue, stageReceiptValue any) (Record, error) {
	stage, err := ValidateStage(stageValue)
	if err != nil {
		return nil, err
	}
	stageReceipt, err := ValidateStageReceipt(stageReceiptValue, stage)
	if err != nil {
		return nil, err
	}
	resolution, err := ValidateResolution(value)
	if err != nil {
		return nil, err
	}
	stageHash, err := HashStage(stage)
	if err != nil {
		return nil, err
	}
	receiptHash, err := HashReceipt(stageReceipt)
	if err != nil {
		return nil, err
	}
	committedAt, _ := stageReceipt["committedAt"].(string)
	if stageReceipt["phase"] != "stage_event" || stageReceipt["status"] != "accepted" ||
		resolution["bindingId"] != stage["bindingId"] || resolution["operation"] != stage["operation"] ||
		resolution["stageHash"] != stageHash || resolution["stageReceiptHash"] != receiptHash ||
		resolution["targetBodyHash"] != stage["target"].(Record)["messageDigest"] ||
		resolution["stageReceiptHash"] == resolution["stageHash"] || resolution["sentAt"].(string) < committedAt {
		return nil, failure(ErrorStageRequired, "$", "Authority resolution is not bound to an accepted durable stage.")
	}
	if err := assertEvidenceForStage(resolution["evidence"].(Record), stage, resolution["sentAt"].(string)); err != nil {
		return nil, err
	}
	return resolution, nil
}
