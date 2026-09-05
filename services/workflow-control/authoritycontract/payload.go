package authoritycontract

func validateAddedPayload(kind Kind, value any) (map[string]any, error) {
	path := "$/payload"
	switch kind {
	case KindCheckpointCommit:
		fields := []string{"checkpointId", "phaseId", "phaseIndex", "commitPoint", "artifactRef", "artifactHash", "resultHash", "cacheKeyHash", "workflowSourceHash", "manifestHash", "inputHash"}
		record, err := closedRecord(value, fields, path)
		if err != nil {
			return nil, err
		}
		if _, err := requireIdentifier(record["checkpointId"], path+"/checkpointId"); err != nil {
			return nil, err
		}
		if _, err := requireIdentifier(record["phaseId"], path+"/phaseId"); err != nil {
			return nil, err
		}
		if _, err := requireInteger(record["phaseIndex"], path+"/phaseIndex", 0); err != nil {
			return nil, err
		}
		if record["commitPoint"] != "after_phase_work" {
			return nil, failure(ErrorInvalid, path+"/commitPoint", "checkpoint is not after phase work")
		}
		if _, err := requireReference(record["artifactRef"], path+"/artifactRef"); err != nil {
			return nil, err
		}
		for _, field := range []string{"artifactHash", "workflowSourceHash", "manifestHash", "inputHash"} {
			if _, err := requireHash(record[field], path+"/"+field); err != nil {
				return nil, err
			}
		}
		for _, field := range []string{"resultHash", "cacheKeyHash"} {
			if _, err := nullableString(record[field], path+"/"+field, requireHash); err != nil {
				return nil, err
			}
		}
		return record, nil

	case KindBudgetReserveRequest:
		fields := []string{"reservationId", "callId", "policyHash", "requestedTokens", "requestedCostNanoUsd", "requestedCalls"}
		record, err := closedRecord(value, fields, path)
		if err != nil {
			return nil, err
		}
		if err := validateBudgetIdentifiersAndHash(record, path, "reservationId", "callId", "policyHash"); err != nil {
			return nil, err
		}
		if err := validateDecimalFields(record, path, "requestedTokens", "requestedCostNanoUsd", "requestedCalls"); err != nil {
			return nil, err
		}
		return record, nil

	case KindBudgetUsageReport:
		fields := []string{"reservationId", "callId", "providerReceiptHash", "actualTokens", "actualCostNanoUsd", "actualCalls", "settlementStatus"}
		record, err := closedRecord(value, fields, path)
		if err != nil {
			return nil, err
		}
		if err := validateBudgetIdentifiersAndHash(record, path, "reservationId", "callId", "providerReceiptHash"); err != nil {
			return nil, err
		}
		if err := validateDecimalFields(record, path, "actualTokens", "actualCostNanoUsd", "actualCalls"); err != nil {
			return nil, err
		}
		if _, err := requireEnum(record["settlementStatus"], path+"/settlementStatus", []string{"settled", "reconciliation_required"}); err != nil {
			return nil, err
		}
		return record, nil

	case KindBudgetAuthorization:
		fields := []string{"reservationId", "status", "authorizedTokens", "authorizedCostNanoUsd", "authorizedCalls", "authorityReceiptHash", "committedRunRevision"}
		record, err := closedRecord(value, fields, path)
		if err != nil {
			return nil, err
		}
		if _, err := requireIdentifier(record["reservationId"], path+"/reservationId"); err != nil {
			return nil, err
		}
		status, err := requireEnum(record["status"], path+"/status", []string{"reserved", "rejected", "reconciliation_required"})
		if err != nil {
			return nil, err
		}
		if err := validateDecimalFields(record, path, "authorizedTokens", "authorizedCostNanoUsd", "authorizedCalls"); err != nil {
			return nil, err
		}
		if status != "reserved" && (record["authorizedTokens"] != "0" || record["authorizedCostNanoUsd"] != "0" || record["authorizedCalls"] != "0") {
			return nil, failure(ErrorInvalid, path, "A non-reserved budget decision cannot authorize spend.")
		}
		if _, err := requireHash(record["authorityReceiptHash"], path+"/authorityReceiptHash"); err != nil {
			return nil, err
		}
		if _, err := requireInteger(record["committedRunRevision"], path+"/committedRunRevision", 1); err != nil {
			return nil, err
		}
		return record, nil

	case KindEffectAuthorization:
		fields := []string{"effectId", "effectHash", "approvalId", "approvalStatus", "decisionRevision", "grantHash", "authorityReceiptHash", "expiresAt"}
		record, err := closedRecord(value, fields, path)
		if err != nil {
			return nil, err
		}
		for _, field := range []string{"effectId", "approvalId"} {
			if _, err := requireIdentifier(record[field], path+"/"+field); err != nil {
				return nil, err
			}
		}
		for _, field := range []string{"effectHash", "authorityReceiptHash"} {
			if _, err := requireHash(record[field], path+"/"+field); err != nil {
				return nil, err
			}
		}
		status, err := requireEnum(record["approvalStatus"], path+"/approvalStatus", []string{"approved", "rejected", "expired"})
		if err != nil {
			return nil, err
		}
		if _, err := requireInteger(record["decisionRevision"], path+"/decisionRevision", 1); err != nil {
			return nil, err
		}
		grantHash, err := nullableString(record["grantHash"], path+"/grantHash", requireHash)
		if err != nil {
			return nil, err
		}
		if (status == "approved") != (grantHash != nil) {
			return nil, failure(ErrorApprovalPlaneMismatch, path+"/grantHash", "only an exact approved effect-v2 decision can yield a grant hash")
		}
		if _, err := requireTimestamp(record["expiresAt"], path+"/expiresAt"); err != nil {
			return nil, err
		}
		return record, nil

	case KindResumeOffer:
		fields := []string{"checkpointId", "checkpointHash", "nextPhaseId", "nextPhaseIndex", "newResumeGeneration", "newAttemptId", "authorityReceiptHash", "expiresAt"}
		record, err := closedRecord(value, fields, path)
		if err != nil {
			return nil, err
		}
		if record["checkpointId"] != nil {
			if _, err := requireIdentifier(record["checkpointId"], path+"/checkpointId"); err != nil {
				return nil, err
			}
		}
		if record["checkpointHash"] != nil {
			if _, err := requireHash(record["checkpointHash"], path+"/checkpointHash"); err != nil {
				return nil, err
			}
		}
		nextPhaseIndex, err := requireInteger(record["nextPhaseIndex"], path+"/nextPhaseIndex", 0)
		if err != nil {
			return nil, err
		}
		if (record["checkpointId"] == nil) != (record["checkpointHash"] == nil) ||
			(record["checkpointId"] == nil && (record["nextPhaseId"] != "phase-0" || nextPhaseIndex != 0)) {
			return nil, failure(ErrorInvalid, path, "Only phase-0 reentry permits an empty checkpoint pair.")
		}
		for _, field := range []string{"nextPhaseId", "newAttemptId"} {
			if _, err := requireIdentifier(record[field], path+"/"+field); err != nil {
				return nil, err
			}
		}
		if _, err := requireHash(record["authorityReceiptHash"], path+"/authorityReceiptHash"); err != nil {
			return nil, err
		}
		if _, err := requireInteger(record["newResumeGeneration"], path+"/newResumeGeneration", 1); err != nil {
			return nil, err
		}
		if _, err := requireTimestamp(record["expiresAt"], path+"/expiresAt"); err != nil {
			return nil, err
		}
		return record, nil
	default:
		return nil, failure(ErrorInvalid, "$/kind", "unknown added message kind")
	}
}

func validateBudgetIdentifiersAndHash(record map[string]any, path, first, second, hashField string) error {
	if _, err := requireIdentifier(record[first], path+"/"+first); err != nil {
		return err
	}
	if _, err := requireIdentifier(record[second], path+"/"+second); err != nil {
		return err
	}
	_, err := requireHash(record[hashField], path+"/"+hashField)
	return err
}

func validateDecimalFields(record map[string]any, path string, fields ...string) error {
	for _, field := range fields {
		if _, err := quantity(record[field], path+"/"+field); err != nil {
			return err
		}
	}
	return nil
}
