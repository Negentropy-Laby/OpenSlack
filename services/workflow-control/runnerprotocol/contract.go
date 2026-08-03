package runnerprotocol

import (
	"fmt"
	"regexp"
	"sort"
	"time"
	"unicode/utf8"
)

const (
	ProtocolVersion = "openslack.workflow_runner.v1"
	Authority       = "typescript"
	GoRole          = "validator-only"

	MaxEnvelopeBytes       = 256 * 1024
	MaxJSONDepth           = 12
	MaxJSONNodes           = 2_048
	MaxStringBytes         = 2_048
	MaxIdentifierBytes     = 256
	MaxEffectKindBytes     = 128
	MaxCapabilities        = 64
	MaxProtocolVersions    = 4
	MaxConcurrentJobs      = 1_024
	MinHeartbeatIntervalMS = 250
	MaxHeartbeatIntervalMS = 300_000
	MaxLeaseDurationMS     = 86_400_000
	MaxSafeInteger         = int64(1<<53 - 1)
)

type Kind string

const (
	KindHello         Kind = "hello"
	KindHelloAck      Kind = "hello_ack"
	KindLeaseOffer    Kind = "lease_offer"
	KindLeaseAccept   Kind = "lease_accept"
	KindLeaseReject   Kind = "lease_reject"
	KindHeartbeat     Kind = "heartbeat"
	KindEffectIntent  Kind = "effect_intent"
	KindEffectOutcome Kind = "effect_outcome"
	KindCancelRequest Kind = "cancel_request"
	KindCancelAck     Kind = "cancel_ack"
	KindTerminal      Kind = "terminal"
	KindEventReceipt  Kind = "event_receipt"
)

type Direction string

const (
	DirectionRunnerToControl Direction = "runner-to-control"
	DirectionControlToRunner Direction = "control-to-runner"
)

type ReceiptStatus string

const (
	ReceiptAccepted               ReceiptStatus = "accepted"
	ReceiptDuplicate              ReceiptStatus = "duplicate"
	ReceiptReconciliationRequired ReceiptStatus = "reconciliation_required"
)

type TerminalStatus string

const (
	TerminalCompleted              TerminalStatus = "completed"
	TerminalFailed                 TerminalStatus = "failed"
	TerminalCancelled              TerminalStatus = "cancelled"
	TerminalTimedOut               TerminalStatus = "timed_out"
	TerminalReconciliationRequired TerminalStatus = "reconciliation_required"
)

// AdvancementRules freezes the protocol hand-off requirements without
// implementing a runner, scheduler, lease, or workflow state machine.
type AdvancementRules struct {
	HelloRequires                               Kind
	LeaseOfferRequiresOneOf                     []Kind
	ReceiptRequiredFor                          []Kind
	AdvancingReceiptStatuses                    []ReceiptStatus
	StoppingReceiptStatus                       ReceiptStatus
	ReceiptIsReceiptable                        bool
	OneOutstandingWorkerEvent                   bool
	LeaseAcceptReceiptBeforeJavaScriptExecution bool
	TerminalReceiptBeforeSuccessfulRunnerExit   bool
	CancelRequestPreemptsReceiptWait            bool
	CancelAckQueuedBehindOutstandingWorkerEvent bool
	CancelValidityEvaluatedAtRunnerReceipt      bool
	AppliedCancelAckMayFollowExpiry             bool
}

// ProtocolAdvancementRules returns a defensive copy of the frozen v1
// cross-message progression matrix. Callers remain responsible for runtime
// state, persistence, scheduling, and delivery.
func ProtocolAdvancementRules() AdvancementRules {
	return AdvancementRules{
		HelloRequires:                               KindHelloAck,
		LeaseOfferRequiresOneOf:                     []Kind{KindLeaseAccept, KindLeaseReject},
		ReceiptRequiredFor:                          []Kind{KindLeaseAccept, KindLeaseReject, KindHeartbeat, KindEffectIntent, KindEffectOutcome, KindCancelAck, KindTerminal},
		AdvancingReceiptStatuses:                    []ReceiptStatus{ReceiptAccepted, ReceiptDuplicate},
		StoppingReceiptStatus:                       ReceiptReconciliationRequired,
		ReceiptIsReceiptable:                        false,
		OneOutstandingWorkerEvent:                   true,
		LeaseAcceptReceiptBeforeJavaScriptExecution: true,
		TerminalReceiptBeforeSuccessfulRunnerExit:   true,
		CancelRequestPreemptsReceiptWait:            true,
		CancelAckQueuedBehindOutstandingWorkerEvent: true,
		CancelValidityEvaluatedAtRunnerReceipt:      true,
		AppliedCancelAckMayFollowExpiry:             true,
	}
}

// CanReceiveEventReceipt reports the protocol's asymmetric receipt boundary.
func CanReceiveEventReceipt(kind Kind) bool {
	_, ok := receiptableKinds[string(kind)]
	return ok
}

// ReceiptAdvances reports whether a valid receipt permits the next runner
// event. reconciliation_required is deliberately stopping evidence.
func ReceiptAdvances(status ReceiptStatus) bool {
	return status == ReceiptAccepted || status == ReceiptDuplicate
}

// Envelope is the one closed logical message shape. The six runtime binding
// fields are nil only for hello and hello_ack. Payload remains a bounded,
// kind-specific closed object; it never carries a command, path, URL, prompt,
// raw arguments, credentials, provider payload, or approval decision.
type Envelope struct {
	ProtocolVersion string         `json:"protocolVersion"`
	Kind            Kind           `json:"kind"`
	WorkspaceID     string         `json:"workspaceId"`
	JobID           *string        `json:"jobId"`
	WorkflowRunID   *string        `json:"workflowRunId"`
	AttemptID       *string        `json:"attemptId"`
	LeaseID         *string        `json:"leaseId"`
	FencingToken    *int64         `json:"fencingToken"`
	Sequence        *int64         `json:"sequence"`
	EventID         string         `json:"eventId"`
	CorrelationID   string         `json:"correlationId"`
	SentAt          string         `json:"sentAt"`
	Payload         map[string]any `json:"payload"`
}

var (
	safeIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	canonicalTimePattern  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	hashPattern           = regexp.MustCompile(`^[0-9a-f]{64}$`)
	validKinds            = map[Kind]struct{}{
		KindHello: {}, KindHelloAck: {}, KindLeaseOffer: {}, KindLeaseAccept: {},
		KindLeaseReject: {}, KindHeartbeat: {}, KindEffectIntent: {}, KindEffectOutcome: {},
		KindCancelRequest: {}, KindCancelAck: {}, KindTerminal: {}, KindEventReceipt: {},
	}
	schedulerKinds = map[Kind]struct{}{
		KindHelloAck: {}, KindLeaseOffer: {}, KindCancelRequest: {}, KindEventReceipt: {},
	}
	forbiddenPayloadFields = map[string]struct{}{
		"args": {}, "approvalDecision": {}, "budgetDecision": {}, "command": {},
		"credential": {}, "credentials": {}, "modulePath": {}, "output": {},
		"prompt": {}, "providerPayload": {}, "result": {}, "secret": {},
		"token": {}, "transcript": {}, "url": {},
	}
)

func DirectionForKind(kind Kind) (Direction, error) {
	if _, ok := validKinds[kind]; !ok {
		return "", failure(ErrorInvalidMessage, "$/kind", "message kind is outside the closed vocabulary")
	}
	if _, ok := schedulerKinds[kind]; ok {
		return DirectionControlToRunner, nil
	}
	return DirectionRunnerToControl, nil
}

func ValidateEnvelope(value Envelope) error {
	if value.ProtocolVersion != ProtocolVersion {
		return failure(ErrorUnsupportedVersion, "$/protocolVersion", "protocol version is unsupported")
	}
	if _, ok := validKinds[value.Kind]; !ok {
		return failure(ErrorInvalidMessage, "$/kind", "message kind is outside the closed vocabulary")
	}
	for _, binding := range []struct {
		path  string
		value string
	}{
		{"$/workspaceId", value.WorkspaceID},
		{"$/eventId", value.EventID},
		{"$/correlationId", value.CorrelationID},
	} {
		if err := validateIdentifier(binding.value, binding.path); err != nil {
			return err
		}
	}
	if !canonicalTimePattern.MatchString(value.SentAt) {
		return failure(ErrorInvalidMessage, "$/sentAt", "sentAt must be a canonical millisecond UTC timestamp")
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", value.SentAt); err != nil {
		return failure(ErrorInvalidMessage, "$/sentAt", "sentAt is not a valid timestamp")
	}

	preLease := value.Kind == KindHello || value.Kind == KindHelloAck
	identities := []struct {
		path  string
		value *string
	}{
		{"$/jobId", value.JobID},
		{"$/workflowRunId", value.WorkflowRunID},
		{"$/attemptId", value.AttemptID},
		{"$/leaseId", value.LeaseID},
	}
	if preLease {
		for _, binding := range identities {
			if binding.value != nil {
				return failure(ErrorIdentityMismatch, binding.path, "pre-lease identity must be null")
			}
		}
		if value.FencingToken != nil {
			return failure(ErrorIdentityMismatch, "$/fencingToken", "pre-lease fencingToken must be null")
		}
		if value.Sequence != nil {
			return failure(ErrorIdentityMismatch, "$/sequence", "pre-lease sequence must be null")
		}
	} else {
		for _, binding := range identities {
			if binding.value == nil {
				return failure(ErrorInvalidMessage, binding.path, "leased message identity must be non-null")
			}
			if err := validateIdentifier(*binding.value, binding.path); err != nil {
				return err
			}
		}
		if value.FencingToken == nil || *value.FencingToken < 1 || *value.FencingToken > MaxSafeInteger {
			return failure(ErrorInvalidMessage, "$/fencingToken", "fencingToken must be a positive safe integer")
		}
		if value.Sequence == nil || *value.Sequence < 1 || *value.Sequence > MaxSafeInteger {
			return failure(ErrorInvalidMessage, "$/sequence", "sequence must be a positive safe integer")
		}
	}
	if value.Payload == nil {
		return failure(ErrorInvalidMessage, "$/payload", "payload must be a non-null object")
	}
	if path, ok := forbiddenFieldPath(value.Payload, "$/payload", 0); ok {
		return failure(ErrorUnknownField, path, "raw sensitive or executable field is forbidden")
	}
	return validatePayload(value)
}

func validateIdentifier(value, path string) error {
	if !utf8.ValidString(value) || len(value) > MaxIdentifierBytes || !safeIdentifierPattern.MatchString(value) {
		return failure(ErrorInvalidMessage, path, "identifier is invalid")
	}
	return nil
}

func requireHash(value any, path string) error {
	text, ok := value.(string)
	if !ok || !hashPattern.MatchString(text) {
		return failure(ErrorInvalidMessage, path, "value must be a full lowercase SHA-256 hash")
	}
	return nil
}

func forbiddenFieldPath(value any, path string, depth int) (string, bool) {
	if depth > MaxJSONDepth {
		return path, true
	}
	switch current := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(current))
		for key := range current {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			item := current[key]
			if _, forbidden := forbiddenPayloadFields[key]; forbidden {
				return path + "/" + key, true
			}
			if found, ok := forbiddenFieldPath(item, path+"/"+key, depth+1); ok {
				return found, true
			}
		}
	case []any:
		for index, item := range current {
			if found, ok := forbiddenFieldPath(item, fmt.Sprintf("%s/%d", path, index), depth+1); ok {
				return found, true
			}
		}
	}
	return "", false
}
