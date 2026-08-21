package runnerbindingcontract

import (
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

func assertEvidenceForStage(evidence, stage Record, resolutionSentAt string) error {
	target := stage["target"].(Record)
	message, _, err := prepareAuthorityMessageBytes([]byte(target["body"].(string)))
	if err != nil {
		return failure(ErrorInvalid, "$/target/body", "Target event body is invalid: WorkflowControlAuthorityContractError.")
	}
	payload := message.Payload
	source := evidence["sourceAuthority"].(Record)
	runnerHead := stage["runnerAuthority"].(Record)
	route := stage["route"].(Record)
	if source["expectedResumeGeneration"] != runnerHead["expectedResumeGeneration"] ||
		source["authorityBuildHash"] != route["authorityBuildHash"] {
		return failure(ErrorAuthorityPlaneMismatch, "$/evidence/sourceAuthority", "Source authority is not bound to the staged runner head and build.")
	}
	operation := Operation(stage["operation"].(string))
	switch operation {
	case OperationCheckpointCommit:
		if evidence["schema"] != "openslack.workflow_runner_checkpoint_authority_evidence.v1" {
			return failure(ErrorAuthorityPlaneMismatch, "$/evidence/schema", "Checkpoint operation requires checkpoint authority evidence.")
		}
		envelope := evidence["envelope"].(Record)
		if err := assertEnvelopeRunnerBinding(envelope, stage, "$/evidence/envelope"); err != nil {
			return err
		}
		observation := envelope["observation"].(Record)
		checkpoint, ok := observation["checkpoint"].(Record)
		acceptedRevision, accepted := source["acceptedRevision"].(int64)
		if !ok || !accepted || source["expectedRevision"].(int64)+1 != acceptedRevision ||
			source["acceptedResumeGeneration"] != runnerHead["expectedResumeGeneration"] ||
			checkpoint["checkpointId"] != payload["checkpointId"] || checkpoint["phaseId"] != payload["phaseId"] ||
			checkpoint["phaseIndex"] != payload["phaseIndex"] || checkpoint["commitPoint"] != payload["commitPoint"] ||
			checkpoint["artifactRef"] != payload["artifactRef"] || checkpoint["artifactHash"] != payload["artifactHash"] ||
			checkpoint["resultHash"] != payload["resultHash"] || checkpoint["cacheKeyHash"] != payload["cacheKeyHash"] ||
			checkpoint["committedRevision"] != acceptedRevision || checkpoint["resumeGeneration"] != source["acceptedResumeGeneration"] ||
			observation["workflowSourceHash"] != payload["workflowSourceHash"] || observation["manifestHash"] != payload["manifestHash"] ||
			observation["inputHash"] != payload["inputHash"] {
			return failure(ErrorIdentityMismatch, "$/evidence", "Checkpoint evidence differs from the exact staged checkpoint event.")
		}
	case OperationEffectAuthorize:
		if evidence["schema"] != "openslack.workflow_runner_effect_authority_evidence.v1" {
			return failure(ErrorAuthorityPlaneMismatch, "$/evidence/schema", "Effect intent requires effect-v2 authority evidence.")
		}
		acceptedRevision, _ := source["acceptedRevision"].(int64)
		if evidence["effectId"] != payload["effectId"] || evidence["effectHash"] != payload["effectHash"] ||
			evidence["capabilityHash"] != payload["capabilityHash"] || payload["requiresHumanDecision"] != true ||
			source["requestHash"] != evidence["intentBindingHash"] || source["acceptedResumeGeneration"] != runnerHead["expectedResumeGeneration"] ||
			evidence["decisionRevision"] != acceptedRevision ||
			((evidence["approvalStatus"] == "approved" || evidence["approvalStatus"] == "rejected") && evidence["expiresAt"].(string) <= resolutionSentAt) ||
			(evidence["approvalStatus"] == "expired" && evidence["expiresAt"].(string) > resolutionSentAt) {
			return failure(ErrorIdentityMismatch, "$/evidence", "Effect approval or claim differs from the exact staged intent.")
		}
	case OperationEffectComplete:
		if evidence["schema"] != "openslack.workflow_runner_effect_completion_evidence.v1" {
			return failure(ErrorAuthorityPlaneMismatch, "$/evidence/schema", "Effect outcome requires effect completion evidence.")
		}
		if evidence["effectId"] != payload["effectId"] || evidence["status"] != payload["status"] ||
			evidence["outcomeHash"] != payload["outcomeHash"] || source["requestHash"] != evidence["claimHash"] ||
			source["acceptedResumeGeneration"] != runnerHead["expectedResumeGeneration"] {
			return failure(ErrorIdentityMismatch, "$/evidence", "Effect completion differs from the exact staged outcome.")
		}
	case OperationBudgetReserve, OperationBudgetSettle:
		if evidence["schema"] != "openslack.workflow_runner_budget_authority_evidence.v1" {
			return failure(ErrorAuthorityPlaneMismatch, "$/evidence/schema", "Budget operation requires an exact E1 prepared request.")
		}
		prepared := evidence["preparedRequest"].(budgetcontract.PreparedRequest)
		_, request, preparedErr := budgetcontract.ValidatePreparedRequestRecord(prepared)
		if preparedErr != nil {
			return embeddedBudgetFailure(preparedErr, "$/evidence/preparedRequest/body")
		}
		if request["workspaceId"] != stage["workspaceId"] || request["runId"] != stage["runId"] ||
			request["correlationId"] != stage["correlationId"] || request["expectedRunRevision"] != runnerHead["expectedGlobalRunRevision"] ||
			request["expectedAccountRevision"] != source["expectedRevision"] || source["acceptedRevision"] != nil ||
			source["acceptedResumeGeneration"] != runnerHead["expectedResumeGeneration"] || !sameCanonical(request["route"], route) ||
			request["reservationId"] != payload["reservationId"] || request["callId"] != payload["callId"] {
			return failure(ErrorIdentityMismatch, "$/evidence", "Budget request differs from the runner lease, route, or staged event.")
		}
		if operation == OperationBudgetReserve {
			requested := request["requested"].(budgetcontract.Record)
			if request["policyHash"] != payload["policyHash"] ||
				requested["tokens"] != payload["requestedTokens"] || requested["nanoUsd"] != payload["requestedCostNanoUsd"] ||
				requested["calls"] != payload["requestedCalls"] {
				return failure(ErrorIdentityMismatch, "$/evidence/preparedRequest", "Budget reservation quantities differ from the staged event.")
			}
			break
		}
		if err := assertBudgetSettlementEvidence(evidence, request, payload, prepared.RequestHash); err != nil {
			return err
		}
	case OperationResumeAdvance:
		if evidence["schema"] != "openslack.workflow_runner_resume_authority_evidence.v1" {
			return failure(ErrorAuthorityPlaneMismatch, "$/evidence/schema", "Resume operation requires an exact TS resume authority record.")
		}
		envelope := evidence["envelope"].(Record)
		if err := assertEnvelopeRunnerBinding(envelope, stage, "$/evidence/envelope"); err != nil {
			return err
		}
		observation := envelope["observation"].(Record)
		if evidence["priorCheckpointId"] == nil || evidence["priorCheckpointHash"] == nil ||
			evidence["logicalResumeAttemptId"] == stage["runnerAttemptId"] || evidence["expiresAt"] != payload["leaseExpiresAt"] ||
			payload["acceptedAt"] != stage["sentAt"] || source["expectedResumeGeneration"] != runnerHead["expectedResumeGeneration"] ||
			source["acceptedResumeGeneration"] != runnerHead["acceptedResumeGeneration"] ||
			observation["resumeGeneration"] != runnerHead["acceptedResumeGeneration"] || observation["nextPhaseId"] != evidence["nextPhaseId"] ||
			observation["nextPhaseIndex"] != evidence["nextPhaseIndex"] {
			return failure(ErrorResumeGenerationConflict, "$/evidence", "Resume evidence does not prove the exact contiguous generation transition.")
		}
	}
	return nil
}

func assertEnvelopeRunnerBinding(envelope, stage Record, path string) error {
	observation := envelope["observation"].(Record)
	runner := observation["runner"].(Record)
	if runner["workspaceId"] != stage["workspaceId"] || observation["runId"] != stage["runId"] ||
		runner["jobId"] != stage["jobId"] || runner["attemptId"] != stage["runnerAttemptId"] ||
		runner["leaseId"] != stage["leaseId"] || runner["fencingToken"] != stage["fencingToken"] ||
		runner["correlationId"] != stage["correlationId"] {
		return failure(ErrorIdentityMismatch, path, "Checkpoint authority evidence is cross-spliced with another runner lease.")
	}
	return nil
}

func assertBudgetSettlementEvidence(evidence Record, request budgetcontract.Record, payload map[string]any, requestHash string) error {
	expectedPrefixed, err := MissingProviderUsageHash(requestHash)
	if err != nil {
		return err
	}
	transportBare := strings.TrimPrefix(expectedPrefixed, "sha256:")
	if usageHash, ok := request["usageReceiptHash"].(string); ok {
		expectedPrefixed = usageHash
		transportBare = strings.TrimPrefix(usageHash, "sha256:")
	}
	trustedReported := request["usageEvidenceStatus"] == "trusted"
	providerUsage, hasUsage := request["providerUsage"].(budgetcontract.Record)
	trustedReported = trustedReported && hasUsage && providerUsage["status"] == "reported"
	expectedTokens, expectedCost, expectedCalls := "0", "0", "0"
	expectedSettlementStatus := "reconciliation_required"
	if trustedReported {
		expectedTokens = providerUsage["totalTokens"].(string)
		rate := request["rateNanoUsdPerToken"].(string)
		expectedCost, err = budgetcontract.ChargeNanoUSD(expectedTokens, rate)
		if err != nil {
			return embeddedBudgetFailure(err, "$/evidence/preparedRequest/body")
		}
		expectedCalls = providerUsage["calls"].(string)
		expectedSettlementStatus = "settled"
	}
	if evidence["providerUsageReceiptHash"] != expectedPrefixed || payload["providerReceiptHash"] != transportBare ||
		payload["actualTokens"] != expectedTokens || payload["actualCostNanoUsd"] != expectedCost || payload["actualCalls"] != expectedCalls ||
		payload["settlementStatus"] != expectedSettlementStatus {
		return failure(ErrorIdentityMismatch, "$/evidence/preparedRequest", "Budget settlement usage evidence differs from the staged event.")
	}
	return nil
}

func sameCanonical(left, right any) bool {
	leftBytes, leftErr := canonicalJSON(left)
	rightBytes, rightErr := canonicalJSON(right)
	return leftErr == nil && rightErr == nil && string(leftBytes) == string(rightBytes)
}
