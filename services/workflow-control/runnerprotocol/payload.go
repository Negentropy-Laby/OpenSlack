package runnerprotocol

import (
	"fmt"
	"regexp"
	"time"
	"unicode/utf8"
)

var (
	codePattern        = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,127}$`)
	semverPattern      = regexp.MustCompile(`^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
	idempotencyPattern = regexp.MustCompile(`^openslack\.workflow-runner\.v1\.[0-9a-f]{64}$`)
	fingerprintPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

var (
	capabilities       = stringSet("cancel_ack", "effect_receipts", "lease_heartbeat")
	leaseRejectReasons = stringSet("busy", "unsupported", "stale", "shutting_down")
	heartbeatStates    = stringSet("running", "waiting_effect", "cancelling")
	effectOutcomes     = stringSet("executed", "rejected", "failed", "reconciliation_required")
	cancelReasons      = stringSet("operator", "lease_expired", "shutdown", "superseded", "timeout")
	cancelAckStates    = stringSet("cancelling", "cancelled", "already_terminal")
	terminalStates     = stringSet("completed", "failed", "cancelled", "timed_out", "reconciliation_required")
	receiptStatuses    = stringSet("accepted", "duplicate", "reconciliation_required")
	receiptableKinds   = stringSet(
		string(KindLeaseAccept), string(KindLeaseReject), string(KindHeartbeat),
		string(KindEffectIntent), string(KindEffectOutcome),
		string(KindCancelAck), string(KindTerminal),
	)
)

func validatePayload(message Envelope) error {
	payload := message.Payload
	switch message.Kind {
	case KindHello:
		if err := requireClosedPayload(payload, "runnerBuildHash", "runtimeName", "runtimeVersion", "supportedProtocolVersions", "capabilities", "maxConcurrentJobs"); err != nil {
			return err
		}
		if err := requireHash(payload["runnerBuildHash"], "$/payload/runnerBuildHash"); err != nil {
			return err
		}
		if payload["runtimeName"] != "node" {
			return failure(ErrorInvalidMessage, "$/payload/runtimeName", "runtimeName must be node")
		}
		if _, err := requireText(payload["runtimeVersion"], "$/payload/runtimeVersion", 64, semverPattern); err != nil {
			return err
		}
		versions, err := requireStringArray(payload["supportedProtocolVersions"], "$/payload/supportedProtocolVersions", MaxProtocolVersions, stringSet(ProtocolVersion))
		if err != nil {
			return err
		}
		if len(versions) != 1 || versions[0] != ProtocolVersion {
			return failure(ErrorInvalidMessage, "$/payload/supportedProtocolVersions", "the exact protocol version must be advertised once")
		}
		validatedCapabilities, err := requireStringArray(payload["capabilities"], "$/payload/capabilities", MaxCapabilities, capabilities)
		if err != nil {
			return err
		}
		expectedOrder := []string{"cancel_ack", "effect_receipts", "lease_heartbeat"}
		ordered := make([]string, 0, len(validatedCapabilities))
		for _, capability := range expectedOrder {
			if _, exists := stringSet(validatedCapabilities...)[capability]; exists {
				ordered = append(ordered, capability)
			}
		}
		for index := range ordered {
			if ordered[index] != validatedCapabilities[index] {
				return failure(ErrorInvalidMessage, "$/payload/capabilities", "capabilities must follow the frozen order")
			}
		}
		_, err = requireInteger(payload["maxConcurrentJobs"], "$/payload/maxConcurrentJobs", 1, MaxConcurrentJobs)
		return err

	case KindHelloAck:
		if err := requireClosedPayload(payload, "controlBuildHash", "selectedProtocolVersion", "heartbeatIntervalMs", "leaseOfferTimeoutMs"); err != nil {
			return err
		}
		if err := requireHash(payload["controlBuildHash"], "$/payload/controlBuildHash"); err != nil {
			return err
		}
		if payload["selectedProtocolVersion"] != ProtocolVersion {
			return failure(ErrorInvalidMessage, "$/payload/selectedProtocolVersion", "selected protocol version is unsupported")
		}
		if _, err := requireInteger(payload["heartbeatIntervalMs"], "$/payload/heartbeatIntervalMs", MinHeartbeatIntervalMS, MaxHeartbeatIntervalMS); err != nil {
			return err
		}
		_, err := requireInteger(payload["leaseOfferTimeoutMs"], "$/payload/leaseOfferTimeoutMs", 1, MaxLeaseDurationMS)
		return err

	case KindLeaseOffer:
		if err := requireClosedPayload(payload,
			"executionDescriptorRef", "executionDescriptorHash", "jobSpecHash", "workflowId",
			"workflowVersion", "workflowSourceHash", "manifestHash", "inputHash", "offeredAt", "expiresAt"); err != nil {
			return err
		}
		if _, err := requireText(payload["executionDescriptorRef"], "$/payload/executionDescriptorRef", MaxIdentifierBytes, safeIdentifierPattern); err != nil {
			return err
		}
		for _, field := range []string{"executionDescriptorHash", "jobSpecHash", "workflowSourceHash", "manifestHash", "inputHash"} {
			if err := requireHash(payload[field], "$/payload/"+field); err != nil {
				return err
			}
		}
		if _, err := requireText(payload["workflowId"], "$/payload/workflowId", MaxIdentifierBytes, safeIdentifierPattern); err != nil {
			return err
		}
		if _, err := requireText(payload["workflowVersion"], "$/payload/workflowVersion", MaxIdentifierBytes, safeIdentifierPattern); err != nil {
			return err
		}
		return requireActionAndExpiry(message, "offeredAt", "expiresAt")

	case KindLeaseAccept:
		if err := requireClosedPayload(payload, "acceptedAt", "leaseExpiresAt"); err != nil {
			return err
		}
		return requireActionAndExpiry(message, "acceptedAt", "leaseExpiresAt")

	case KindLeaseReject:
		if err := requireClosedPayload(payload, "rejectedAt", "reason"); err != nil {
			return err
		}
		if err := requireActionTime(message, "rejectedAt"); err != nil {
			return err
		}
		return requireEnum(payload["reason"], "$/payload/reason", leaseRejectReasons)

	case KindHeartbeat:
		if err := requireClosedPayload(payload, "observedAt", "leaseExpiresAt", "state", "lastReceiptSequence"); err != nil {
			return err
		}
		if err := requireActionAndExpiry(message, "observedAt", "leaseExpiresAt"); err != nil {
			return err
		}
		if err := requireEnum(payload["state"], "$/payload/state", heartbeatStates); err != nil {
			return err
		}
		_, err := requireInteger(payload["lastReceiptSequence"], "$/payload/lastReceiptSequence", 0, MaxSafeInteger)
		return err

	case KindEffectIntent:
		if err := requireClosedPayload(payload, "effectId", "effectKind", "effectHash", "capabilityHash", "requiresHumanDecision"); err != nil {
			return err
		}
		if _, err := requireText(payload["effectId"], "$/payload/effectId", MaxIdentifierBytes, safeIdentifierPattern); err != nil {
			return err
		}
		if _, err := requireText(payload["effectKind"], "$/payload/effectKind", MaxEffectKindBytes, codePattern); err != nil {
			return err
		}
		if err := requireHash(payload["effectHash"], "$/payload/effectHash"); err != nil {
			return err
		}
		if err := requireHash(payload["capabilityHash"], "$/payload/capabilityHash"); err != nil {
			return err
		}
		if _, ok := payload["requiresHumanDecision"].(bool); !ok {
			return failure(ErrorInvalidMessage, "$/payload/requiresHumanDecision", "requiresHumanDecision must be boolean")
		}
		return nil

	case KindEffectOutcome:
		if err := requireClosedPayload(payload, "effectId", "status", "outcomeHash"); err != nil {
			return err
		}
		if _, err := requireText(payload["effectId"], "$/payload/effectId", MaxIdentifierBytes, safeIdentifierPattern); err != nil {
			return err
		}
		if err := requireEnum(payload["status"], "$/payload/status", effectOutcomes); err != nil {
			return err
		}
		return requireHash(payload["outcomeHash"], "$/payload/outcomeHash")

	case KindCancelRequest:
		if err := requireClosedPayload(payload, "cancelId", "requestedAt", "expiresAt", "reason"); err != nil {
			return err
		}
		if _, err := requireText(payload["cancelId"], "$/payload/cancelId", MaxIdentifierBytes, safeIdentifierPattern); err != nil {
			return err
		}
		if err := requireActionAndExpiry(message, "requestedAt", "expiresAt"); err != nil {
			return err
		}
		return requireEnum(payload["reason"], "$/payload/reason", cancelReasons)

	case KindCancelAck:
		if err := requireClosedPayload(payload, "cancelId", "acknowledgedAt", "status"); err != nil {
			return err
		}
		if _, err := requireText(payload["cancelId"], "$/payload/cancelId", MaxIdentifierBytes, safeIdentifierPattern); err != nil {
			return err
		}
		if err := requireActionTime(message, "acknowledgedAt"); err != nil {
			return err
		}
		return requireEnum(payload["status"], "$/payload/status", cancelAckStates)

	case KindTerminal:
		if err := requireClosedPayload(payload, "status", "finishedAt", "resultHash", "terminalReason"); err != nil {
			return err
		}
		status, err := requireEnumValue(payload["status"], "$/payload/status", terminalStates)
		if err != nil {
			return err
		}
		resultHash, resultIsNull := payload["resultHash"], payload["resultHash"] == nil
		terminalReason, reasonIsNull := payload["terminalReason"], payload["terminalReason"] == nil
		if !resultIsNull {
			if err := requireHash(resultHash, "$/payload/resultHash"); err != nil {
				return err
			}
		}
		if !reasonIsNull {
			if err := requireEnum(terminalReason, "$/payload/terminalReason", stringSet(
				"workflow_failed", "process_crash", "cancelled_by_control", "timeout", "commit_outcome_unknown",
			)); err != nil {
				return err
			}
		}
		expectedErrors := map[string]map[string]struct{}{
			"failed":                  stringSet("workflow_failed", "process_crash"),
			"cancelled":               stringSet("cancelled_by_control"),
			"timed_out":               stringSet("timeout"),
			"reconciliation_required": stringSet("commit_outcome_unknown"),
		}
		evidenceMatches := false
		if status == "completed" {
			evidenceMatches = !resultIsNull && reasonIsNull
		} else if resultIsNull && !reasonIsNull {
			_, evidenceMatches = expectedErrors[status][terminalReason.(string)]
		}
		if !evidenceMatches {
			return failure(ErrorInvalidMessage, "$/payload", "terminal evidence does not match terminal status")
		}
		return requireActionTime(message, "finishedAt")

	case KindEventReceipt:
		if err := requireClosedPayload(payload,
			"receivedEventId", "receivedKind", "receivedSequence", "receivedDigest",
			"receivedIdempotencyKey", "receivedFingerprint", "status", "committedAt",
			"controlBuildHash", "errorCode"); err != nil {
			return err
		}
		if _, err := requireText(payload["receivedEventId"], "$/payload/receivedEventId", MaxIdentifierBytes, safeIdentifierPattern); err != nil {
			return err
		}
		if err := requireEnum(payload["receivedKind"], "$/payload/receivedKind", receiptableKinds); err != nil {
			return err
		}
		if _, err := requireInteger(payload["receivedSequence"], "$/payload/receivedSequence", 1, MaxSafeInteger); err != nil {
			return err
		}
		if err := requireHash(payload["receivedDigest"], "$/payload/receivedDigest"); err != nil {
			return err
		}
		if _, err := requireText(payload["receivedIdempotencyKey"], "$/payload/receivedIdempotencyKey", 101, idempotencyPattern); err != nil {
			return err
		}
		if _, err := requireText(payload["receivedFingerprint"], "$/payload/receivedFingerprint", 71, fingerprintPattern); err != nil {
			return err
		}
		status, err := requireEnumValue(payload["status"], "$/payload/status", receiptStatuses)
		if err != nil {
			return err
		}
		if err := requireActionTime(message, "committedAt"); err != nil {
			return err
		}
		if err := requireHash(payload["controlBuildHash"], "$/payload/controlBuildHash"); err != nil {
			return err
		}
		if status == "reconciliation_required" {
			return requireEnum(payload["errorCode"], "$/payload/errorCode", stringSet(
				string(ErrorCommitOutcomeUnknown), string(ErrorReconciliationRequired),
			))
		}
		if payload["errorCode"] != nil {
			return failure(ErrorInvalidMessage, "$/payload/errorCode", "accepted and duplicate receipts require null errorCode")
		}
		return nil
	default:
		return failure(ErrorInvalidMessage, "$/kind", "message kind is outside the closed vocabulary")
	}
}

func requireClosedPayload(payload map[string]any, fields ...string) error {
	allowed := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		allowed[field] = struct{}{}
		if _, exists := payload[field]; !exists {
			return failure(ErrorInvalidMessage, "$/payload/"+field, "required payload field is missing")
		}
	}
	for _, field := range sortedObjectKeys(payload) {
		if _, exists := allowed[field]; !exists {
			return failure(ErrorUnknownField, "$/payload/"+field, "unknown payload field")
		}
	}
	return nil
}

func requireText(value any, path string, maximum int, pattern *regexp.Regexp) (string, error) {
	text, ok := value.(string)
	if !ok || text == "" || !utf8.ValidString(text) || len(text) > maximum || (pattern != nil && !pattern.MatchString(text)) {
		return "", failure(ErrorInvalidMessage, path, "string is invalid")
	}
	return text, nil
}

func requireInteger(value any, path string, minimum, maximum int64) (int64, error) {
	integer, ok := value.(int64)
	if !ok || integer < minimum || integer > maximum {
		return 0, failure(ErrorInvalidMessage, path, "value must be a bounded safe integer")
	}
	return integer, nil
}

func requireEnum(value any, path string, allowed map[string]struct{}) error {
	_, err := requireEnumValue(value, path, allowed)
	return err
}

func requireEnumValue(value any, path string, allowed map[string]struct{}) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", failure(ErrorInvalidMessage, path, "value is outside the closed vocabulary")
	}
	if _, exists := allowed[text]; !exists {
		return "", failure(ErrorInvalidMessage, path, "value is outside the closed vocabulary")
	}
	return text, nil
}

func requireStringArray(value any, path string, maximum int, allowed map[string]struct{}) ([]string, error) {
	items, ok := value.([]any)
	if !ok || len(items) > maximum {
		return nil, failure(ErrorInvalidMessage, path, "value must be a bounded array")
	}
	result := make([]string, 0, len(items))
	seen := map[string]struct{}{}
	for index, item := range items {
		text, err := requireEnumValue(item, fmt.Sprintf("%s/%d", path, index), allowed)
		if err != nil {
			return nil, err
		}
		if _, duplicate := seen[text]; duplicate {
			return nil, failure(ErrorInvalidMessage, path, "array values must be unique")
		}
		seen[text] = struct{}{}
		result = append(result, text)
	}
	return result, nil
}

func requireActionTime(message Envelope, field string) error {
	value, err := requireTimestamp(message.Payload[field], "$/payload/"+field)
	if err != nil {
		return err
	}
	if value != message.SentAt {
		return failure(ErrorInvalidMessage, "$/payload/"+field, field+" must equal envelope sentAt")
	}
	return nil
}

func requireActionAndExpiry(message Envelope, actionField, expiryField string) error {
	if err := requireActionTime(message, actionField); err != nil {
		return err
	}
	expiresAt, err := requireTimestamp(message.Payload[expiryField], "$/payload/"+expiryField)
	if err != nil {
		return err
	}
	start, _ := time.Parse("2006-01-02T15:04:05.000Z", message.SentAt)
	expires, _ := time.Parse("2006-01-02T15:04:05.000Z", expiresAt)
	if !expires.After(start) {
		return failure(ErrorInvalidMessage, "$/payload/"+expiryField, expiryField+" must be later than sentAt")
	}
	if expires.Sub(start) > time.Duration(MaxLeaseDurationMS)*time.Millisecond {
		return failure(ErrorLimitExceeded, "$/payload/"+expiryField, expiryField+" exceeds its duration limit")
	}
	return nil
}

func requireTimestamp(value any, path string) (string, error) {
	text, ok := value.(string)
	if !ok || !canonicalTimePattern.MatchString(text) {
		return "", failure(ErrorInvalidMessage, path, "timestamp must be canonical millisecond UTC")
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", text); err != nil {
		return "", failure(ErrorInvalidMessage, path, "timestamp is invalid")
	}
	return text, nil
}

func stringSet(values ...string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
}
