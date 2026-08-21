package runnerbindingcontract

import (
	"errors"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

var receiptCommonFields = []string{
	"schema", "contractVersion", "profile", "direction", "phase", "companionSequence", "bindingId", "operation",
	"status", "controlBuildHash", "committedAt", "reconciliationToken",
}

func ValidateReceipt(value any) (Record, error) {
	return validateReceiptWithSession(value, newBindingValidationSession(nil))
}

func validateReceiptWithSession(value any, session *bindingValidationSession) (Record, error) {
	record, ok := asRecord(value)
	if !ok {
		return nil, failure(ErrorInvalid, "$", "Receipt must be an inert object.")
	}
	phase, _ := record["phase"].(string)
	switch phase {
	case "stage_event", "commit_authority":
		fields := append(append([]string(nil), receiptCommonFields...), "requestHash", "targetEventId", "targetBodyHash")
		if phase == "commit_authority" {
			fields = append(fields, "stageHash", "stageReceiptHash")
		}
		fields = append(fields, "evidenceHash")
		closed, err := closedRecord(record, fields, "$")
		if err != nil {
			return nil, err
		}
		base, err := validateReceiptBase(closed)
		if err != nil {
			return nil, err
		}
		evidenceHash, err := nullableText(closed["evidenceHash"], "$/evidenceHash", hashValue)
		if err != nil {
			return nil, err
		}
		companionSequence, err := integerValue(closed["companionSequence"], "$/companionSequence", 1)
		if err != nil {
			return nil, err
		}
		if (phase == "stage_event" && (companionSequence != 1 || evidenceHash != nil)) ||
			(phase == "commit_authority" && (companionSequence != 2 || evidenceHash == nil)) {
			return nil, failure(ErrorSequenceConflict, "$/companionSequence", "Phase receipt is in the wrong companion sequence domain.")
		}
		result, err := assembleReceiptIdentity(closed, base, "control-to-runner", phase, companionSequence)
		if err != nil {
			return nil, err
		}
		if result["requestHash"], err = hashValue(closed["requestHash"], "$/requestHash"); err != nil {
			return nil, err
		}
		if result["targetEventId"], err = identifier(closed["targetEventId"], "$/targetEventId"); err != nil {
			return nil, err
		}
		if result["targetBodyHash"], err = hashValue(closed["targetBodyHash"], "$/targetBodyHash"); err != nil {
			return nil, err
		}
		if phase == "commit_authority" {
			if result["stageHash"], err = hashValue(closed["stageHash"], "$/stageHash"); err != nil {
				return nil, err
			}
			if result["stageReceiptHash"], err = hashValue(closed["stageReceiptHash"], "$/stageReceiptHash"); err != nil {
				return nil, err
			}
		}
		result["evidenceHash"] = nullableStringValue(evidenceHash)
		if err := session.byteBound(result, MaxReceiptBytes, "$", true); err != nil {
			return nil, err
		}
		return result, nil
	case "control_delivery":
		fields := append(append([]string(nil), receiptCommonFields...),
			"controlEventId", "controlKind", "controlSequence", "messageDigest", "runnerAttemptId", "leaseId", "fencingToken", "processedAt", "disposition")
		closed, err := closedRecord(record, fields, "$")
		if err != nil {
			return nil, err
		}
		base, err := validateReceiptBase(closed)
		if err != nil {
			return nil, err
		}
		if base["status"] != "accepted" {
			return nil, failure(ErrorReconciliationRequired, "$/status", "A control delivery acknowledgement cannot claim reconciliation as delivery.")
		}
		companionSequence, err := integerValue(closed["companionSequence"], "$/companionSequence", 3)
		if err != nil {
			return nil, err
		}
		result, err := assembleReceiptIdentity(closed, base, "runner-to-control", phase, companionSequence)
		if err != nil {
			return nil, err
		}
		if result["controlEventId"], err = identifier(closed["controlEventId"], "$/controlEventId"); err != nil {
			return nil, err
		}
		if result["controlKind"], err = enumString(closed["controlKind"], []string{
			"event_receipt", "budget_authorization", "effect_authorization", "resume_offer", "cancel_request",
		}, "$/controlKind"); err != nil {
			return nil, err
		}
		if result["controlSequence"], err = integerValue(closed["controlSequence"], "$/controlSequence", 1); err != nil {
			return nil, err
		}
		if result["messageDigest"], err = hashValue(closed["messageDigest"], "$/messageDigest"); err != nil {
			return nil, err
		}
		for _, field := range []string{"runnerAttemptId", "leaseId"} {
			if result[field], err = identifier(closed[field], "$/"+field); err != nil {
				return nil, err
			}
		}
		if result["fencingToken"], err = integerValue(closed["fencingToken"], "$/fencingToken", 1); err != nil {
			return nil, err
		}
		if result["processedAt"], err = timestampValue(closed["processedAt"], "$/processedAt"); err != nil {
			return nil, err
		}
		if result["disposition"], err = enumString(
			closed["disposition"],
			[]string{"accepted", "reconciliation_required"},
			"$/disposition",
		); err != nil {
			return nil, err
		}
		if result["processedAt"] != result["committedAt"] {
			return nil, failure(ErrorIdentityMismatch, "$/processedAt", "Control processing time must equal its durable acknowledgement time.")
		}
		if err := session.byteBound(result, MaxReceiptBytes, "$", true); err != nil {
			return nil, err
		}
		return result, nil
	default:
		return nil, failure(ErrorInvalid, "$/phase", "Receipt phase is invalid.")
	}
}

func validateReceiptBase(record Record) (Record, error) {
	status, err := enumString(record["status"], []string{"accepted", "reconciliation_required"}, "$/status")
	if err != nil {
		return nil, err
	}
	committedAt, err := nullableText(record["committedAt"], "$/committedAt", timestampValue)
	if err != nil {
		return nil, err
	}
	reconciliationToken, err := nullableText(record["reconciliationToken"], "$/reconciliationToken", reference)
	if err != nil {
		return nil, err
	}
	if (status == "accepted" && (committedAt == nil || reconciliationToken != nil)) ||
		(status == "reconciliation_required" && (committedAt != nil || reconciliationToken == nil)) {
		return nil, failure(ErrorReconciliationRequired, "$", "Receipt status evidence is inconsistent.")
	}
	bindingID, err := identifier(record["bindingId"], "$/bindingId")
	if err != nil {
		return nil, err
	}
	operation, err := operationValue(record["operation"], "$/operation")
	if err != nil {
		return nil, err
	}
	controlBuildHash, err := hashValue(record["controlBuildHash"], "$/controlBuildHash")
	if err != nil {
		return nil, err
	}
	return Record{
		"bindingId": bindingID, "operation": string(operation), "status": status,
		"controlBuildHash": controlBuildHash, "committedAt": nullableStringValue(committedAt),
		"reconciliationToken": nullableStringValue(reconciliationToken),
	}, nil
}

func assembleReceiptIdentity(record, base Record, direction, phase string, sequence int64) (Record, error) {
	result := Record{}
	for key, value := range base {
		result[key] = value
	}
	var err error
	for _, field := range []struct {
		name     string
		expected string
	}{
		{"schema", ReceiptSchema},
		{"contractVersion", ContractVersion},
		{"profile", FutureRuntimeProfile},
		{"direction", direction},
		{"phase", phase},
	} {
		if result[field.name], err = literalString(record[field.name], field.expected, "$/"+field.name); err != nil {
			return nil, err
		}
	}
	result["companionSequence"] = sequence
	return result, nil
}

func ValidateStageReceipt(value, stageValue any) (Record, error) {
	session := newBindingValidationSession(nil)
	stage, err := validateStageWithSession(stageValue, session)
	if err != nil {
		return nil, err
	}
	return validateStageReceiptForValidatedStage(value, stage, session)
}

func validateStageReceiptForValidatedStage(value any, stage Record, session *bindingValidationSession) (Record, error) {
	receipt, err := validateReceiptWithSession(value, session)
	if err != nil {
		return nil, err
	}
	stageHash, err := domainHashWithSession(session, "stage", stage)
	if err != nil {
		return nil, err
	}
	committedAt, _ := receipt["committedAt"].(string)
	if receipt["phase"] != "stage_event" || receipt["bindingId"] != stage["bindingId"] || receipt["operation"] != stage["operation"] ||
		receipt["requestHash"] != stageHash || receipt["targetEventId"] != stage["target"].(Record)["eventId"] ||
		receipt["targetBodyHash"] != stage["target"].(Record)["messageDigest"] ||
		receipt["controlBuildHash"] != stage["route"].(Record)["authorityBuildHash"] ||
		(committedAt != "" && committedAt < stage["sentAt"].(string)) {
		return nil, failure(ErrorIdentityMismatch, "$", "Stage receipt does not bind the exact durable stage.")
	}
	return receipt, nil
}

func ValidateResolutionReceipt(value, resolutionValue, stageValue, stageReceiptValue any) (Record, error) {
	session := newBindingValidationSession(nil)
	stage, err := validateStageWithSession(stageValue, session)
	if err != nil {
		return nil, err
	}
	stageReceipt, err := validateStageReceiptForValidatedStage(stageReceiptValue, stage, session)
	if err != nil {
		return nil, err
	}
	resolution, err := validateResolutionForValidatedStage(resolutionValue, stage, stageReceipt, session)
	if err != nil {
		return nil, err
	}
	return validateResolutionReceiptForValidatedContext(value, resolution, stage, stageReceipt, session)
}

func validateResolutionReceiptForValidatedContext(value any, resolution, stage, stageReceipt Record, session *bindingValidationSession) (Record, error) {
	receipt, err := validateReceiptWithSession(value, session)
	if err != nil {
		return nil, err
	}
	resolutionHash, err := domainHashWithSession(session, "resolution", resolution)
	if err != nil {
		return nil, err
	}
	stageHash, err := domainHashWithSession(session, "stage", stage)
	if err != nil {
		return nil, err
	}
	stageReceiptHash, err := domainHashWithSession(session, "receipt", stageReceipt)
	if err != nil {
		return nil, err
	}
	committedAt, _ := receipt["committedAt"].(string)
	if receipt["phase"] != "commit_authority" || receipt["bindingId"] != resolution["bindingId"] ||
		receipt["operation"] != resolution["operation"] || receipt["requestHash"] != resolutionHash ||
		receipt["targetEventId"] != stage["target"].(Record)["eventId"] ||
		receipt["targetBodyHash"] != resolution["targetBodyHash"] ||
		receipt["stageHash"] != resolution["stageHash"] || receipt["stageHash"] != stageHash ||
		receipt["stageReceiptHash"] != resolution["stageReceiptHash"] || receipt["stageReceiptHash"] != stageReceiptHash ||
		receipt["evidenceHash"] != resolution["evidenceHash"] ||
		receipt["controlBuildHash"] != resolution["evidence"].(Record)["sourceAuthority"].(Record)["authorityBuildHash"] ||
		resolution["bindingId"] != stage["bindingId"] || resolution["operation"] != stage["operation"] ||
		resolution["targetBodyHash"] != stage["target"].(Record)["messageDigest"] ||
		(committedAt != "" && committedAt < resolution["sentAt"].(string)) {
		return nil, failure(ErrorIdentityMismatch, "$", "Resolution receipt does not bind the exact committed evidence.")
	}
	return receipt, nil
}

func ValidateControlDeliveryReceiptForMessage(
	value, messageValue, stageValue, resolutionValue, resolutionReceiptValue, stageReceiptValue, priorEventDeliveryValue any,
) (Record, error) {
	return validateControlDeliveryReceiptForMessageWithObserver(
		value,
		messageValue,
		stageValue,
		resolutionValue,
		resolutionReceiptValue,
		stageReceiptValue,
		priorEventDeliveryValue,
		nil,
	)
}

func validateControlDeliveryReceiptForMessageWithObserver(
	value, messageValue, stageValue, resolutionValue, resolutionReceiptValue, stageReceiptValue, priorEventDeliveryValue any,
	onEncode func(Record),
) (Record, error) {
	session := newBindingValidationSession(onEncode)
	stage, err := validateStageWithSession(stageValue, session)
	if err != nil {
		return nil, err
	}
	stageReceipt, err := validateStageReceiptForValidatedStage(stageReceiptValue, stage, session)
	if err != nil {
		return nil, err
	}
	resolution, err := validateResolutionForValidatedStage(resolutionValue, stage, stageReceipt, session)
	if err != nil {
		return nil, err
	}
	resolutionReceipt, err := validateResolutionReceiptForValidatedContext(
		resolutionReceiptValue,
		resolution,
		stage,
		stageReceipt,
		session,
	)
	if err != nil {
		return nil, err
	}
	return validateControlDeliveryForValidatedContext(
		value,
		messageValue,
		stage,
		resolution,
		resolutionReceipt,
		stageReceipt,
		priorEventDeliveryValue,
		session,
	)
}

func validateControlDeliveryForValidatedContext(
	value, messageValue any,
	stage, resolution, resolutionReceipt, stageReceipt Record,
	priorEventDeliveryValue any,
	session *bindingValidationSession,
) (Record, error) {
	receipt, err := validateReceiptWithSession(value, session)
	if err != nil {
		return nil, err
	}
	if receipt["phase"] != "control_delivery" {
		return nil, failure(ErrorIdentityMismatch, "$/phase", "Expected a control delivery acknowledgement.")
	}
	message, prepared, err := prepareAuthorityMessageValue(messageValue)
	if err != nil {
		return nil, err
	}
	runnerHead := stage["runnerAuthority"].(Record)
	target := stage["target"].(Record)
	route := stage["route"].(Record)
	evidence := resolution["evidence"].(Record)
	expectedRevision := runnerHead["acceptedGlobalRunRevision"].(int64)
	expectedGeneration := runnerHead["acceptedResumeGeneration"].(int64)
	if message.Kind == authoritycontract.KindResumeOffer {
		expectedRevision = runnerHead["expectedGlobalRunRevision"].(int64)
		expectedGeneration = runnerHead["expectedResumeGeneration"].(int64)
	}
	expectedCompanionSequence := int64(4)
	if message.Kind == authoritycontract.KindEventReceipt {
		expectedCompanionSequence = 3
	}
	resolutionCommittedAt, resolutionCommitted := resolutionReceipt["committedAt"].(string)
	receiptCommittedAt, receiptCommitted := receipt["committedAt"].(string)
	if prepared.Direction != authoritycontract.DirectionControlToRunner ||
		resolutionReceipt["phase"] != "commit_authority" || resolutionReceipt["status"] != "accepted" ||
		!resolutionCommitted ||
		message.Sequence == nil || message.AttemptID == nil || message.LeaseID == nil || message.FencingToken == nil ||
		message.AuthorityBackend == nil || message.Authority == nil || message.RoutingEpoch == nil || message.AuthorityBuildHash == nil ||
		message.RunRevision == nil || message.ResumeGeneration == nil ||
		receipt["bindingId"] != stage["bindingId"] || receipt["operation"] != stage["operation"] ||
		receipt["controlEventId"] != message.EventID || receipt["controlKind"] != string(message.Kind) ||
		receipt["controlSequence"] != *message.Sequence || receipt["messageDigest"] != prepared.MessageDigest ||
		receipt["runnerAttemptId"] != *message.AttemptID || receipt["leaseId"] != *message.LeaseID ||
		receipt["fencingToken"] != *message.FencingToken || receipt["controlBuildHash"] != route["authorityBuildHash"] ||
		message.WorkspaceID != stage["workspaceId"] || message.JobID == nil || *message.JobID != stage["jobId"] ||
		message.WorkflowRunID == nil || *message.WorkflowRunID != stage["runId"] || *message.AttemptID != stage["runnerAttemptId"] ||
		*message.LeaseID != stage["leaseId"] || *message.FencingToken != stage["fencingToken"] ||
		message.CorrelationID != stage["correlationId"] || *message.AuthorityBackend != route["backend"] ||
		*message.Authority != route["authority"] || *message.RoutingEpoch != route["routingEpoch"] ||
		*message.AuthorityBuildHash != route["authorityBuildHash"] || *message.RunRevision != expectedRevision ||
		*message.ResumeGeneration != expectedGeneration || *message.Sequence <= target["sequence"].(int64) ||
		message.SentAt < resolutionCommittedAt || !receiptCommitted || receiptCommittedAt < message.SentAt ||
		receipt["companionSequence"] != expectedCompanionSequence {
		return nil, failure(ErrorIdentityMismatch, "$", "Control acknowledgement is cross-spliced with another exact control message.")
	}
	if err := assertEvidenceForStage(evidence, stage, resolution["sentAt"].(string)); err != nil {
		return nil, err
	}
	authorityReceiptHash, err := domainHashWithSession(session, "receipt", resolutionReceipt)
	if err != nil {
		return nil, err
	}
	if err := assertControlPayloadForBinding(message, receipt, stage, resolution, authorityReceiptHash); err != nil {
		return nil, err
	}
	if err := assertPriorEventDelivery(
		priorEventDeliveryValue,
		message,
		receipt,
		stage,
		resolution,
		resolutionReceipt,
		stageReceipt,
		session,
	); err != nil {
		return nil, err
	}
	return receipt, nil
}

func assertPriorEventDelivery(
	priorEventDeliveryValue any,
	message authoritycontract.Message,
	receipt, stage, resolution, resolutionReceipt, stageReceipt Record,
	session *bindingValidationSession,
) error {
	if message.Kind == authoritycontract.KindEventReceipt {
		if priorEventDeliveryValue != nil {
			return failure(
				ErrorSequenceConflict,
				"$/priorEventDelivery",
				"An event-receipt delivery acknowledgement cannot have a predecessor.",
			)
		}
		return nil
	}
	prior, err := closedRecord(priorEventDeliveryValue, []string{"message", "receipt"}, "$/priorEventDelivery")
	if err != nil {
		return err
	}
	priorReceipt, err := validateControlDeliveryForValidatedContext(
		prior["receipt"],
		prior["message"],
		stage,
		resolution,
		resolutionReceipt,
		stageReceipt,
		nil,
		session,
	)
	if err != nil {
		var contractErr *ContractError
		if errors.As(err, &contractErr) {
			return failure(
				contractErr.Code,
				nestedContractPath("$/priorEventDelivery", contractErr.Path),
				"Prior event-receipt delivery acknowledgement is invalid.",
			)
		}
		return err
	}
	priorMessage, _, err := prepareAuthorityMessageValue(prior["message"])
	if err != nil {
		return err
	}
	priorCommittedAt, priorCommitted := priorReceipt["committedAt"].(string)
	if priorMessage.Kind != authoritycontract.KindEventReceipt || priorReceipt["controlKind"] != string(authoritycontract.KindEventReceipt) ||
		priorReceipt["disposition"] != "accepted" || !priorCommitted || priorMessage.Sequence == nil || message.Sequence == nil ||
		*message.Sequence != *priorMessage.Sequence+1 || message.SentAt < priorCommittedAt ||
		receipt["companionSequence"].(int64) != priorReceipt["companionSequence"].(int64)+1 {
		return failure(
			ErrorSequenceConflict,
			"$/priorEventDelivery",
			"Optional control delivery is not contiguous with an accepted event-receipt ACK.",
		)
	}
	return nil
}

func assertControlPayloadForBinding(
	message authoritycontract.Message,
	receipt, stage, resolution Record,
	authorityReceiptHash string,
) error {
	payload := message.Payload
	evidence := resolution["evidence"].(Record)
	runnerHead := stage["runnerAuthority"].(Record)
	switch message.Kind {
	case authoritycontract.KindEventReceipt:
		targetMessage, _, err := prepareAuthorityMessageBytes([]byte(stage["target"].(Record)["body"].(string)))
		if err != nil {
			return err
		}
		target := stage["target"].(Record)
		reconciles := payload["status"] == "reconciliation_required"
		if payload["receivedEventId"] != targetMessage.EventID || payload["receivedKind"] != string(targetMessage.Kind) ||
			payload["receivedSequence"] != *targetMessage.Sequence || payload["receivedDigest"] != target["messageDigest"] ||
			payload["receivedIdempotencyKey"] != target["idempotencyKey"] || payload["receivedFingerprint"] != target["requestFingerprint"] ||
			payload["controlBuildHash"] != stage["route"].(Record)["authorityBuildHash"] || payload["committedAt"] != message.SentAt ||
			reconciles != (receipt["disposition"] == "reconciliation_required") {
			return failure(ErrorIdentityMismatch, "$/payload", "Event receipt does not acknowledge the exact staged target.")
		}
	case authoritycontract.KindBudgetAuthorization:
		if stage["operation"] != string(OperationBudgetReserve) || evidence["schema"] != "openslack.workflow_runner_budget_authority_evidence.v1" {
			return failure(ErrorAuthorityPlaneMismatch, "$/controlKind", "Budget authorization is not valid for this binding operation.")
		}
		prepared := evidence["preparedRequest"].(budgetcontract.PreparedRequest)
		_, request, err := budgetcontract.ValidatePreparedRequestRecord(prepared)
		if err != nil {
			return embeddedBudgetFailure(err, "$/resolution/evidence/preparedRequest/body")
		}
		requested := request["requested"].(budgetcontract.Record)
		if payload["reservationId"] != request["reservationId"] || payload["status"] != "reserved" ||
			payload["authorizedTokens"] != requested["tokens"] || payload["authorizedCostNanoUsd"] != requested["nanoUsd"] ||
			payload["authorizedCalls"] != requested["calls"] || payload["authorityReceiptHash"] != authorityReceiptHash ||
			payload["committedRunRevision"] != runnerHead["acceptedGlobalRunRevision"] {
			return failure(ErrorIdentityMismatch, "$/payload", "Budget decision differs from the exact prepared authority evidence.")
		}
	case authoritycontract.KindEffectAuthorization:
		if stage["operation"] != string(OperationEffectAuthorize) || evidence["schema"] != "openslack.workflow_runner_effect_authority_evidence.v1" {
			return failure(ErrorAuthorityPlaneMismatch, "$/controlKind", "Effect authorization is not valid for this binding operation.")
		}
		if payload["effectId"] != evidence["effectId"] || payload["effectHash"] != evidence["effectHash"] ||
			payload["approvalId"] != evidence["approvalId"] || payload["approvalStatus"] != evidence["approvalStatus"] ||
			payload["decisionRevision"] != evidence["decisionRevision"] || payload["grantHash"] != evidence["grantHash"] ||
			payload["authorityReceiptHash"] != authorityReceiptHash || payload["expiresAt"] != evidence["expiresAt"] {
			return failure(ErrorIdentityMismatch, "$/payload", "Effect decision differs from the exact effect-v2 evidence.")
		}
	case authoritycontract.KindResumeOffer:
		if stage["operation"] != string(OperationResumeAdvance) || evidence["schema"] != "openslack.workflow_runner_resume_authority_evidence.v1" {
			return failure(ErrorAuthorityPlaneMismatch, "$/controlKind", "Resume offer is not valid for this binding operation.")
		}
		if payload["checkpointId"] != evidence["priorCheckpointId"] || payload["checkpointHash"] != evidence["priorCheckpointHash"] ||
			payload["nextPhaseId"] != evidence["nextPhaseId"] || payload["nextPhaseIndex"] != evidence["nextPhaseIndex"] ||
			payload["newResumeGeneration"] != runnerHead["acceptedResumeGeneration"] || payload["newAttemptId"] != evidence["logicalResumeAttemptId"] ||
			payload["authorityReceiptHash"] != authorityReceiptHash || payload["expiresAt"] != evidence["expiresAt"] {
			return failure(ErrorIdentityMismatch, "$/payload", "Resume offer differs from the exact resume authority evidence.")
		}
	case authoritycontract.KindCancelRequest:
		return nil
	default:
		return failure(ErrorAuthorityPlaneMismatch, "$/controlKind", "Control kind is outside the authority-binding delivery set.")
	}
	return nil
}

func asRecord(value any) (Record, bool) {
	switch current := value.(type) {
	case Record:
		return current, current != nil
	case map[string]any:
		return Record(current), current != nil
	default:
		return nil, false
	}
}
