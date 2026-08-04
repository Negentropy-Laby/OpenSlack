package authoritycontract

import (
	"errors"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

var messageFields = []string{
	"schema", "protocolVersion", "kind", "workspaceId", "jobId", "workflowRunId", "attemptId",
	"leaseId", "fencingToken", "sequence", "authorityBackend", "authority", "routingEpoch",
	"authorityBuildHash", "runRevision", "resumeGeneration", "eventId", "correlationId", "sentAt", "payload",
}

func DecodeMessageJSON(input []byte) (Message, error) {
	if len(input) > MaxMessageBytes {
		return Message{}, failure(ErrorLimitExceeded, "$", "message exceeds its byte limit")
	}
	value, err := parseStrictJSON(input, MaxJSONDepth, MaxJSONNodes, MaxStringBytes)
	if err != nil {
		return Message{}, normalizeStrictJSONError(err)
	}
	return ValidateMessage(value)
}

func ValidateMessage(value any) (Message, error) {
	root, err := closedRecord(value, messageFields, "$")
	if err != nil {
		return Message{}, err
	}
	if root["schema"] != MessageSchema {
		return Message{}, failure(ErrorInvalid, "$/schema", "message schema is invalid")
	}
	if root["protocolVersion"] != ProtocolVersion {
		return Message{}, failure(ErrorUnsupportedVersion, "$/protocolVersion", "Protocol v2 is required.")
	}
	kind, err := requireEnum(root["kind"], "$/kind", messageKinds)
	if err != nil {
		return Message{}, err
	}
	workspaceID, err := requireIdentifier(root["workspaceId"], "$/workspaceId")
	if err != nil {
		return Message{}, err
	}
	handshake := kind == KindHello || kind == KindHelloAck
	jobID, err := messageNullableIdentifier(root["jobId"], "$/jobId", handshake)
	if err != nil {
		return Message{}, err
	}
	workflowRunID, err := messageNullableIdentifier(root["workflowRunId"], "$/workflowRunId", handshake)
	if err != nil {
		return Message{}, err
	}
	attemptID, err := messageNullableIdentifier(root["attemptId"], "$/attemptId", handshake)
	if err != nil {
		return Message{}, err
	}
	leaseID, err := messageNullableIdentifier(root["leaseId"], "$/leaseId", handshake)
	if err != nil {
		return Message{}, err
	}
	fencingToken, err := messageNullableInteger(root["fencingToken"], "$/fencingToken", 1, handshake)
	if err != nil {
		return Message{}, err
	}
	sequence, err := messageNullableInteger(root["sequence"], "$/sequence", 1, handshake)
	if err != nil {
		return Message{}, err
	}
	authorityBackend, err := messageNullableEnum(root["authorityBackend"], "$/authorityBackend", []string{"ts-local", "go"}, handshake)
	if err != nil {
		return Message{}, err
	}
	authority, err := messageNullableEnum(root["authority"], "$/authority", []string{"typescript", "workflow-control"}, handshake)
	if err != nil {
		return Message{}, err
	}
	if !handshake && ((*authorityBackend == "ts-local" && *authority != "typescript") || (*authorityBackend == "go" && *authority != "workflow-control")) {
		return Message{}, failure(ErrorIdentityMismatch, "$/authority", "authority route is inconsistent")
	}
	routingEpoch, err := messageNullableInteger(root["routingEpoch"], "$/routingEpoch", 1, handshake)
	if err != nil {
		return Message{}, err
	}
	authorityBuildHash, err := messageNullableHash(root["authorityBuildHash"], "$/authorityBuildHash", handshake)
	if err != nil {
		return Message{}, err
	}
	runRevision, err := messageNullableInteger(root["runRevision"], "$/runRevision", 1, handshake)
	if err != nil {
		return Message{}, err
	}
	resumeGeneration, err := messageNullableInteger(root["resumeGeneration"], "$/resumeGeneration", 0, handshake)
	if err != nil {
		return Message{}, err
	}
	eventID, err := requireIdentifier(root["eventId"], "$/eventId")
	if err != nil {
		return Message{}, err
	}
	correlationID, err := requireIdentifier(root["correlationId"], "$/correlationId")
	if err != nil {
		return Message{}, err
	}
	sentAt, err := requireTimestamp(root["sentAt"], "$/sentAt")
	if err != nil {
		return Message{}, err
	}
	payload, err := validateMessagePayload(kind, root)
	if err != nil {
		return Message{}, err
	}
	if kind == KindEventReceipt && payload["committedAt"] != sentAt {
		return Message{}, failure(ErrorIdentityMismatch, "$/payload/committedAt", "receipt committedAt must equal envelope sentAt")
	}
	if kind == KindEffectAuthorization || kind == KindResumeOffer {
		expiresAt := payload["expiresAt"].(string)
		if expiresAt <= sentAt {
			return Message{}, failure(ErrorInvalid, "$/payload/expiresAt", "authorization or resume offer must expire after sentAt")
		}
	}
	if kind == KindResumeOffer && payload["newResumeGeneration"].(int64) != *resumeGeneration+1 {
		return Message{}, failure(ErrorStaleResumeGeneration, "$/payload/newResumeGeneration", "resume offer must advance the exact bound generation once")
	}
	if kind == KindBudgetAuthorization && payload["committedRunRevision"].(int64) != *runRevision {
		return Message{}, failure(ErrorStaleRevision, "$/payload/committedRunRevision", "budget authorization must bind the envelope run revision")
	}
	result := Message{
		Schema: MessageSchema, ProtocolVersion: ProtocolVersion, Kind: kind, WorkspaceID: workspaceID,
		JobID: jobID, WorkflowRunID: workflowRunID, AttemptID: attemptID, LeaseID: leaseID,
		FencingToken: fencingToken, Sequence: sequence, AuthorityBackend: authorityBackend,
		Authority: authority, RoutingEpoch: routingEpoch, AuthorityBuildHash: authorityBuildHash,
		RunRevision: runRevision, ResumeGeneration: resumeGeneration, EventID: eventID,
		CorrelationID: correlationID, SentAt: sentAt, Payload: payload,
	}
	if err := requireCanonicalSize(result, MaxMessageBytes, "$"); err != nil {
		return Message{}, err
	}
	return result, nil
}

func messageNullableIdentifier(value any, path string, handshake bool) (*string, error) {
	if handshake {
		if value != nil {
			return nil, failure(ErrorIdentityMismatch, path, "identity must be null during handshake")
		}
		return nil, nil
	}
	result, err := requireIdentifier(value, path)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func messageNullableInteger(value any, path string, minimum int64, handshake bool) (*int64, error) {
	if handshake {
		if value != nil {
			return nil, failure(ErrorIdentityMismatch, path, "value must be null during handshake")
		}
		return nil, nil
	}
	result, err := requireInteger(value, path, minimum)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func messageNullableEnum(value any, path string, allowed []string, handshake bool) (*string, error) {
	if handshake {
		if value != nil {
			return nil, failure(ErrorIdentityMismatch, path, "value must be null during handshake")
		}
		return nil, nil
	}
	result, err := requireEnum(value, path, allowed)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func messageNullableHash(value any, path string, handshake bool) (*string, error) {
	if handshake {
		if value != nil {
			return nil, failure(ErrorIdentityMismatch, path, "value must be null during handshake")
		}
		return nil, nil
	}
	result, err := requireHash(value, path)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func validateMessagePayload(kind Kind, root map[string]any) (map[string]any, error) {
	switch kind {
	case KindHello:
		return validateHelloPayload(root["payload"])
	case KindHelloAck:
		return validateHelloAckPayload(root["payload"])
	case KindEventReceipt:
		return validateEventReceiptPayload(root["payload"])
	case KindCheckpointCommit, KindBudgetReserveRequest, KindBudgetUsageReport,
		KindBudgetAuthorization, KindEffectAuthorization, KindResumeOffer:
		return validateAddedPayload(kind, root["payload"])
	default:
		payload, ok := root["payload"].(map[string]any)
		if !ok || payload == nil {
			return nil, failure(ErrorInvalid, "$/payload", "payload must be an object")
		}
		message := runnerprotocol.Envelope{
			ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: runnerprotocol.Kind(kind),
			WorkspaceID: root["workspaceId"].(string), JobID: stringPointer(root["jobId"]),
			WorkflowRunID: stringPointer(root["workflowRunId"]), AttemptID: stringPointer(root["attemptId"]),
			LeaseID: stringPointer(root["leaseId"]), FencingToken: intPointer(root["fencingToken"]),
			Sequence: intPointer(root["sequence"]), EventID: root["eventId"].(string),
			CorrelationID: root["correlationId"].(string), SentAt: root["sentAt"].(string), Payload: payload,
		}
		if err := runnerprotocol.ValidateEnvelope(message); err != nil {
			return nil, translateRunnerError(err)
		}
		return payload, nil
	}
}

func stringPointer(value any) *string {
	if value == nil {
		return nil
	}
	result := value.(string)
	return &result
}

func intPointer(value any) *int64 {
	if value == nil {
		return nil
	}
	result := value.(int64)
	return &result
}

func translateRunnerError(err error) error {
	var runnerError *runnerprotocol.ContractError
	if !errors.As(err, &runnerError) {
		return failure(ErrorInvalid, "$/payload", err.Error())
	}
	code := ErrorInvalid
	switch runnerError.Code {
	case runnerprotocol.ErrorUnknownField:
		code = ErrorUnknownField
	case runnerprotocol.ErrorLimitExceeded:
		code = ErrorLimitExceeded
	case runnerprotocol.ErrorUnsupportedVersion:
		code = ErrorUnsupportedVersion
	case runnerprotocol.ErrorIdentityMismatch:
		code = ErrorIdentityMismatch
	}
	return failure(code, runnerError.Path, runnerError.Message)
}

func validateHelloPayload(value any) (map[string]any, error) {
	path := "$/payload"
	record, err := closedRecord(value, []string{"runtimeName", "runtimeVersion", "runnerBuildHash", "supportedProtocolVersions", "capabilities", "maxConcurrentJobs"}, path)
	if err != nil {
		return nil, err
	}
	versions, ok := record["supportedProtocolVersions"].([]any)
	if !ok || len(versions) != 2 || versions[0] != V1ProtocolVersion || versions[1] != ProtocolVersion {
		return nil, failure(ErrorUnsupportedVersion, path+"/supportedProtocolVersions", "a v2 runner must advertise the exact ordered v1,v2 versions")
	}
	capabilities, ok := record["capabilities"].([]any)
	if !ok || len(capabilities) > 64 {
		return nil, failure(ErrorInvalid, path+"/capabilities", "capabilities are invalid")
	}
	seen := make(map[string]struct{}, len(capabilities))
	allowedCapabilities := map[string]struct{}{"cancel_ack": {}, "effect_receipts": {}, "lease_heartbeat": {}}
	for _, capability := range capabilities {
		text, ok := capability.(string)
		if !ok {
			return nil, failure(ErrorInvalid, path+"/capabilities", "capabilities are invalid")
		}
		if _, duplicate := seen[text]; duplicate {
			return nil, failure(ErrorInvalid, path+"/capabilities", "capabilities are invalid")
		}
		if _, allowed := allowedCapabilities[text]; !allowed {
			return nil, failure(ErrorInvalid, path+"/capabilities", "capabilities are invalid")
		}
		seen[text] = struct{}{}
	}
	if record["runtimeName"] != "node" {
		return nil, failure(ErrorInvalid, path+"/runtimeName", "runtime must be node")
	}
	if _, err := requireString(record["runtimeVersion"], path+"/runtimeVersion", 64, semverPattern); err != nil {
		return nil, err
	}
	if _, err := requireHash(record["runnerBuildHash"], path+"/runnerBuildHash"); err != nil {
		return nil, err
	}
	concurrency, err := requireInteger(record["maxConcurrentJobs"], path+"/maxConcurrentJobs", 1)
	if err != nil {
		return nil, err
	}
	if concurrency > 1_024 {
		return nil, failure(ErrorLimitExceeded, path+"/maxConcurrentJobs", "concurrency exceeds its limit")
	}
	return record, nil
}

func validateHelloAckPayload(value any) (map[string]any, error) {
	path := "$/payload"
	record, err := closedRecord(value, []string{"controlBuildHash", "selectedProtocolVersion", "heartbeatIntervalMs", "leaseOfferTimeoutMs"}, path)
	if err != nil {
		return nil, err
	}
	if record["selectedProtocolVersion"] != ProtocolVersion {
		return nil, failure(ErrorUnsupportedVersion, path+"/selectedProtocolVersion", "a v2-required run must select v2 without downgrade")
	}
	if _, err := requireHash(record["controlBuildHash"], path+"/controlBuildHash"); err != nil {
		return nil, err
	}
	heartbeat, err := requireInteger(record["heartbeatIntervalMs"], path+"/heartbeatIntervalMs", 250)
	if err != nil {
		return nil, err
	}
	timeout, err := requireInteger(record["leaseOfferTimeoutMs"], path+"/leaseOfferTimeoutMs", 1)
	if err != nil {
		return nil, err
	}
	if heartbeat > 300_000 || timeout > 86_400_000 {
		return nil, failure(ErrorLimitExceeded, path, "handshake timing exceeds its limit")
	}
	return record, nil
}

func validateEventReceiptPayload(value any) (map[string]any, error) {
	path := "$/payload"
	fields := []string{"receivedEventId", "receivedKind", "receivedSequence", "receivedDigest", "receivedIdempotencyKey", "receivedFingerprint", "status", "controlBuildHash", "committedAt", "errorCode"}
	record, err := closedRecord(value, fields, path)
	if err != nil {
		return nil, err
	}
	if _, err := requireIdentifier(record["receivedEventId"], path+"/receivedEventId"); err != nil {
		return nil, err
	}
	receiptable := []Kind{KindLeaseAccept, KindLeaseReject, KindHeartbeat, KindEffectIntent, KindEffectOutcome, KindCancelAck, KindTerminal, KindCheckpointCommit, KindBudgetReserveRequest, KindBudgetUsageReport}
	if _, err := requireEnum(record["receivedKind"], path+"/receivedKind", receiptable); err != nil {
		return nil, err
	}
	if _, err := requireInteger(record["receivedSequence"], path+"/receivedSequence", 1); err != nil {
		return nil, err
	}
	if _, err := requireHash(record["receivedDigest"], path+"/receivedDigest"); err != nil {
		return nil, err
	}
	if _, err := requireString(record["receivedIdempotencyKey"], path+"/receivedIdempotencyKey", 128, idempotencyPattern); err != nil {
		return nil, err
	}
	if _, err := requireString(record["receivedFingerprint"], path+"/receivedFingerprint", 71, fingerprintPattern); err != nil {
		return nil, err
	}
	status, err := requireEnum(record["status"], path+"/status", []ReceiptStatus{ReceiptAccepted, ReceiptDuplicate, ReceiptReconciliationRequired})
	if err != nil {
		return nil, err
	}
	if _, err := requireHash(record["controlBuildHash"], path+"/controlBuildHash"); err != nil {
		return nil, err
	}
	if _, err := requireTimestamp(record["committedAt"], path+"/committedAt"); err != nil {
		return nil, err
	}
	errorCodes := []string{string(ErrorReconciliationRequired), string(ErrorStaleRevision), string(ErrorStaleResumeGeneration), string(ErrorStaleFence)}
	if status == ReceiptReconciliationRequired {
		if _, err := requireEnum(record["errorCode"], path+"/errorCode", errorCodes); err != nil {
			return nil, err
		}
	} else if record["errorCode"] != nil {
		return nil, failure(ErrorInvalid, path+"/errorCode", "receipt errorCode does not match status")
	}
	return record, nil
}
