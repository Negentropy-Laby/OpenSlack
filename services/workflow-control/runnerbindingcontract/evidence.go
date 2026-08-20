package runnerbindingcontract

import (
	"regexp"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

var positiveDecimalPattern = regexp.MustCompile(`^[1-9][0-9]*$`)

func validateEvidence(value any, operation Operation, path string) (Record, error) {
	if err := rejectForbiddenKeys(value, path); err != nil {
		return nil, err
	}
	switch operation {
	case OperationCheckpointCommit:
		return validateCheckpointEvidence(value, operation, path)
	case OperationEffectAuthorize:
		return validateEffectEvidence(value, operation, path)
	case OperationEffectComplete:
		return validateEffectCompletionEvidence(value, operation, path)
	case OperationBudgetReserve, OperationBudgetSettle:
		return validateBudgetEvidence(value, operation, path)
	case OperationResumeAdvance:
		return validateResumeEvidence(value, operation, path)
	default:
		return nil, failure(ErrorInvalid, path, "Authority evidence operation is invalid.")
	}
}

func validateSourceAuthority(value any, operation Operation, path string) (Record, error) {
	record, err := closedRecord(value, []string{
		"plane",
		"evidenceState",
		"expectedRevision",
		"acceptedRevision",
		"expectedResumeGeneration",
		"acceptedResumeGeneration",
		"requestHash",
		"receiptSchema",
		"receiptHash",
		"recordHash",
		"authorityBuildHash",
	}, path)
	if err != nil {
		return nil, err
	}
	expectedPlane := "resume_control"
	switch operation {
	case OperationCheckpointCommit:
		expectedPlane = "checkpoint_control"
	case OperationEffectAuthorize, OperationEffectComplete:
		expectedPlane = "effect_v2_sibling"
	case OperationBudgetReserve, OperationBudgetSettle:
		expectedPlane = "budget_account"
	case OperationResumeAdvance:
	default:
		return nil, failure(ErrorInvalid, path+"/plane", path+"/plane is invalid.")
	}
	plane, err := literalString(record["plane"], expectedPlane, path+"/plane")
	if err != nil {
		return nil, err
	}
	expectedState := "committed"
	if operation == OperationBudgetReserve || operation == OperationBudgetSettle {
		expectedState = "prepared"
	}
	evidenceState, err := literalString(record["evidenceState"], expectedState, path+"/evidenceState")
	if err != nil {
		return nil, err
	}
	expectedRevision, err := integerValue(record["expectedRevision"], path+"/expectedRevision", 0)
	if err != nil {
		return nil, err
	}
	acceptedRevision, err := nullableInteger(record["acceptedRevision"], path+"/acceptedRevision", 1)
	if err != nil {
		return nil, err
	}
	expectedGeneration, err := integerValue(record["expectedResumeGeneration"], path+"/expectedResumeGeneration", 0)
	if err != nil {
		return nil, err
	}
	acceptedGeneration, err := integerValue(record["acceptedResumeGeneration"], path+"/acceptedResumeGeneration", 0)
	if err != nil {
		return nil, err
	}
	receiptSchema, err := nullableText(record["receiptSchema"], path+"/receiptSchema", reference)
	if err != nil {
		return nil, err
	}
	receiptHash, err := nullableText(record["receiptHash"], path+"/receiptHash", hashValue)
	if err != nil {
		return nil, err
	}
	recordHash, err := nullableText(record["recordHash"], path+"/recordHash", hashValue)
	if err != nil {
		return nil, err
	}
	if evidenceState == "prepared" {
		if acceptedRevision != nil || receiptSchema != nil || receiptHash != nil || recordHash != nil ||
			acceptedGeneration != expectedGeneration {
			return nil, failure(ErrorAuthorityPlaneMismatch, path, "Prepared evidence cannot claim an authority mutation.")
		}
	} else {
		expectedGenerationDelta := int64(0)
		if operation == OperationResumeAdvance {
			expectedGenerationDelta = 1
		}
		if acceptedRevision == nil || *acceptedRevision != expectedRevision+1 ||
			acceptedGeneration != expectedGeneration+expectedGenerationDelta ||
			receiptSchema == nil || receiptHash == nil || recordHash == nil {
			code := ErrorRevisionConflict
			if operation == OperationResumeAdvance {
				code = ErrorResumeGenerationConflict
			}
			return nil, failure(code, path, "Committed source-authority head is invalid.")
		}
	}
	expectedReceiptSchema, err := SourceReceiptSchema(operation)
	if err != nil {
		return nil, err
	}
	if nullableStringValue(receiptSchema) != nullableStringValue(expectedReceiptSchema) {
		return nil, failure(
			ErrorAuthorityPlaneMismatch,
			path+"/receiptSchema",
			"Source receipt schema is not the closed schema for this authority plane.",
		)
	}
	requestHash, err := hashValue(record["requestHash"], path+"/requestHash")
	if err != nil {
		return nil, err
	}
	authorityBuildHash, err := hashValue(record["authorityBuildHash"], path+"/authorityBuildHash")
	if err != nil {
		return nil, err
	}
	return Record{
		"plane":                    plane,
		"evidenceState":            evidenceState,
		"expectedRevision":         expectedRevision,
		"acceptedRevision":         nullableIntegerValue(acceptedRevision),
		"expectedResumeGeneration": expectedGeneration,
		"acceptedResumeGeneration": acceptedGeneration,
		"requestHash":              requestHash,
		"receiptSchema":            nullableStringValue(receiptSchema),
		"receiptHash":              nullableStringValue(receiptHash),
		"recordHash":               nullableStringValue(recordHash),
		"authorityBuildHash":       authorityBuildHash,
	}, nil
}

func validateEffectEvidence(value any, operation Operation, path string) (Record, error) {
	record, err := closedRecord(value, []string{
		"schema", "sourceAuthority", "occurrenceId", "intentBindingHash", "effectId", "effectHash",
		"capabilityHash", "approvalId", "approvalStatus", "approvalRecordHash", "approvalDecisionHash",
		"decisionRevision", "humanBindingHash", "attestationHash", "executionId", "claimHash", "grantHash", "expiresAt",
	}, path)
	if err != nil {
		return nil, err
	}
	source, err := validateSourceAuthority(record["sourceAuthority"], operation, path+"/sourceAuthority")
	if err != nil {
		return nil, err
	}
	status, err := enumString(record["approvalStatus"], []string{"approved", "rejected", "expired"}, path+"/approvalStatus")
	if err != nil {
		return nil, err
	}
	approvalRecordHash, err := nullableText(record["approvalRecordHash"], path+"/approvalRecordHash", hashValue)
	if err != nil {
		return nil, err
	}
	approvalDecisionHash, err := nullableText(record["approvalDecisionHash"], path+"/approvalDecisionHash", hashValue)
	if err != nil {
		return nil, err
	}
	humanBindingHash, err := nullableText(record["humanBindingHash"], path+"/humanBindingHash", hashValue)
	if err != nil {
		return nil, err
	}
	attestationHash, err := nullableText(record["attestationHash"], path+"/attestationHash", hashValue)
	if err != nil {
		return nil, err
	}
	executionID, err := nullableText(record["executionId"], path+"/executionId", identifier)
	if err != nil {
		return nil, err
	}
	claimHash, err := nullableText(record["claimHash"], path+"/claimHash", hashValue)
	if err != nil {
		return nil, err
	}
	grantHash, err := nullableText(record["grantHash"], path+"/grantHash", hashValue)
	if err != nil {
		return nil, err
	}
	decisionRevision, err := integerValue(record["decisionRevision"], path+"/decisionRevision", 0)
	if err != nil {
		return nil, err
	}
	approved := status == "approved"
	decided := status != "expired"
	claimComplete := executionID != nil && claimHash != nil && grantHash != nil && *claimHash == *grantHash
	decisionComplete := approvalRecordHash != nil && approvalDecisionHash != nil && humanBindingHash != nil && attestationHash != nil
	if approved != claimComplete || decided != decisionComplete ||
		(approved && decisionRevision < 1) ||
		(!approved && (executionID != nil || claimHash != nil || grantHash != nil)) {
		return nil, failure(ErrorAuthorityPlaneMismatch, path, "Effect approval and one-time claim evidence are inconsistent.")
	}
	return assembleEffectEvidence(record, source, status, decisionRevision,
		approvalRecordHash, approvalDecisionHash, humanBindingHash, attestationHash, executionID, claimHash, grantHash, path)
}

func assembleEffectEvidence(
	record Record,
	source Record,
	status string,
	decisionRevision int64,
	approvalRecordHash, approvalDecisionHash, humanBindingHash, attestationHash, executionID, claimHash, grantHash *string,
	path string,
) (Record, error) {
	result := Record{
		"sourceAuthority":      source,
		"approvalStatus":       status,
		"approvalRecordHash":   nullableStringValue(approvalRecordHash),
		"approvalDecisionHash": nullableStringValue(approvalDecisionHash),
		"decisionRevision":     decisionRevision,
		"humanBindingHash":     nullableStringValue(humanBindingHash),
		"attestationHash":      nullableStringValue(attestationHash),
		"executionId":          nullableStringValue(executionID),
		"claimHash":            nullableStringValue(claimHash),
		"grantHash":            nullableStringValue(grantHash),
	}
	var err error
	if result["schema"], err = literalString(record["schema"], "openslack.workflow_runner_effect_authority_evidence.v1", path+"/schema"); err != nil {
		return nil, err
	}
	for _, field := range []string{"occurrenceId", "effectId", "approvalId"} {
		if result[field], err = identifier(record[field], path+"/"+field); err != nil {
			return nil, err
		}
	}
	for _, field := range []string{"intentBindingHash", "effectHash", "capabilityHash"} {
		if result[field], err = hashValue(record[field], path+"/"+field); err != nil {
			return nil, err
		}
	}
	if result["expiresAt"], err = timestampValue(record["expiresAt"], path+"/expiresAt"); err != nil {
		return nil, err
	}
	return result, nil
}

func validateEffectCompletionEvidence(value any, operation Operation, path string) (Record, error) {
	record, err := closedRecord(value, []string{
		"schema", "sourceAuthority", "occurrenceId", "effectId", "effectHash", "executionId", "claimHash", "status", "outcomeHash", "reconciliationToken",
	}, path)
	if err != nil {
		return nil, err
	}
	source, err := validateSourceAuthority(record["sourceAuthority"], operation, path+"/sourceAuthority")
	if err != nil {
		return nil, err
	}
	status, err := enumString(record["status"], []string{"executed", "failed", "reconciliation_required"}, path+"/status")
	if err != nil {
		return nil, err
	}
	outcomeHash, err := hashValue(record["outcomeHash"], path+"/outcomeHash")
	if err != nil {
		return nil, err
	}
	reconciliationToken, err := nullableText(record["reconciliationToken"], path+"/reconciliationToken", reference)
	if err != nil {
		return nil, err
	}
	if (status != "reconciliation_required" && reconciliationToken != nil) ||
		(status == "reconciliation_required" && reconciliationToken == nil) {
		return nil, failure(ErrorAuthorityPlaneMismatch, path, "Effect completion state is invalid.")
	}
	result := Record{
		"sourceAuthority":     source,
		"status":              status,
		"outcomeHash":         outcomeHash,
		"reconciliationToken": nullableStringValue(reconciliationToken),
	}
	if result["schema"], err = literalString(record["schema"], "openslack.workflow_runner_effect_completion_evidence.v1", path+"/schema"); err != nil {
		return nil, err
	}
	for _, field := range []string{"occurrenceId", "effectId", "executionId"} {
		if result[field], err = identifier(record[field], path+"/"+field); err != nil {
			return nil, err
		}
	}
	for _, field := range []string{"effectHash", "claimHash"} {
		if result[field], err = hashValue(record[field], path+"/"+field); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func validateBudgetEvidence(value any, operation Operation, path string) (Record, error) {
	record, err := closedRecord(value, []string{
		"schema", "sourceAuthority", "preparedRequest", "providerHash", "modelHash", "providerRunHash", "providerAttempt",
		"accountId", "policyHash", "rateNanoUsdPerToken", "providerUsageReceiptHash",
	}, path)
	if err != nil {
		return nil, err
	}
	source, err := validateSourceAuthority(record["sourceAuthority"], operation, path+"/sourceAuthority")
	if err != nil {
		return nil, err
	}
	preparedValue := record["preparedRequest"]
	// Record and budgetcontract.Record are distinct named map types. Convert the
	// neutral JSON object at this package boundary so the authoritative E1
	// validator can decode and validate the exact prepared request.
	if preparedRecord, ok := preparedValue.(Record); ok {
		preparedValue = map[string]any(preparedRecord)
	}
	prepared, request, preparedErr := budgetcontract.ValidatePreparedRequestRecord(preparedValue)
	if preparedErr != nil {
		return nil, embeddedBudgetFailure(preparedErr, path+"/preparedRequest")
	}
	expectedOperation := "reserve"
	if operation == OperationBudgetSettle {
		expectedOperation = "settle"
	}
	if prepared.Operation != expectedOperation {
		return nil, failure(ErrorAuthorityPlaneMismatch, path+"/preparedRequest/operation", "Budget prepared request operation drifted.")
	}
	providerUsageReceiptHash, err := nullableText(record["providerUsageReceiptHash"], path+"/providerUsageReceiptHash", prefixedHashValue)
	if err != nil {
		return nil, err
	}
	requestUsageHash, missingUsageErr := MissingProviderUsageHash(prepared.RequestHash)
	if missingUsageErr != nil {
		return nil, missingUsageErr
	}
	if providerUsage, ok := request["providerUsage"].(budgetcontract.Record); ok && providerUsage["receiptHash"] != nil {
		requestUsageHash = providerUsage["receiptHash"].(string)
	} else if usageReceiptHash, ok := request["usageReceiptHash"].(string); ok {
		requestUsageHash = usageReceiptHash
	}
	if source["requestHash"] != prepared.RequestHash || record["accountId"] != request["accountId"] ||
		record["policyHash"] != request["policyHash"] || record["providerAttempt"] != request["providerAttempt"] ||
		record["rateNanoUsdPerToken"] != request["rateNanoUsdPerToken"] || record["providerHash"] != request["expectedProviderHash"] ||
		record["modelHash"] != request["expectedModelHash"] || record["providerRunHash"] != request["expectedProviderRunHash"] ||
		(operation == OperationBudgetReserve && providerUsageReceiptHash != nil) ||
		(operation == OperationBudgetSettle && nullableStringValue(providerUsageReceiptHash) != requestUsageHash) {
		return nil, failure(ErrorAuthorityPlaneMismatch, path, "Budget runner identity differs from the exact E1 request.")
	}
	result := Record{"sourceAuthority": source, "preparedRequest": prepared, "providerUsageReceiptHash": nullableStringValue(providerUsageReceiptHash)}
	if result["schema"], err = literalString(record["schema"], "openslack.workflow_runner_budget_authority_evidence.v1", path+"/schema"); err != nil {
		return nil, err
	}
	for _, field := range []string{"providerHash", "modelHash", "providerRunHash"} {
		if result[field], err = prefixedHashValue(record[field], path+"/"+field); err != nil {
			return nil, err
		}
	}
	if result["providerAttempt"], err = textValue(record["providerAttempt"], path+"/providerAttempt", positiveDecimalPattern, 19); err != nil {
		return nil, err
	}
	if result["accountId"], err = identifier(record["accountId"], path+"/accountId"); err != nil {
		return nil, err
	}
	if result["policyHash"], err = hashValue(record["policyHash"], path+"/policyHash"); err != nil {
		return nil, err
	}
	if result["rateNanoUsdPerToken"], err = rateValue(record["rateNanoUsdPerToken"], path+"/rateNanoUsdPerToken"); err != nil {
		return nil, err
	}
	return result, nil
}

func prefixedHashValue(value any, path string) (string, error) {
	return textValue(value, path, fingerprintPattern, 71)
}

func nullableInteger(value any, path string, minimum int64) (*int64, error) {
	if value == nil {
		return nil, nil
	}
	result, err := integerValue(value, path, minimum)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func nullableText(
	value any,
	path string,
	validate func(any, string) (string, error),
) (*string, error) {
	if value == nil {
		return nil, nil
	}
	result, err := validate(value, path)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func nullableIntegerValue(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableStringValue(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
