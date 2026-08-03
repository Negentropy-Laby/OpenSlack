package runnerprotocol

import "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"

type CreateReceiptInput struct {
	Sequence         int64
	SentAt           string
	Status           ReceiptStatus
	ControlBuildHash string
	ErrorCode        *ErrorCode
}

func CreateEventReceipt(received Envelope, input CreateReceiptInput) (Envelope, error) {
	if err := ValidateEnvelope(received); err != nil {
		return Envelope{}, err
	}
	if _, ok := receiptableKinds[string(received.Kind)]; !ok {
		return Envelope{}, failure(ErrorInvalidMessage, "$/kind", "message kind cannot receive an event receipt")
	}
	if _, ok := receiptStatuses[string(input.Status)]; !ok {
		return Envelope{}, failure(ErrorInvalidMessage, "$/status", "receipt status is outside the closed vocabulary")
	}
	var errorCode any
	if input.ErrorCode != nil {
		errorCode = string(*input.ErrorCode)
	}
	if input.Status == ReceiptReconciliationRequired {
		if input.ErrorCode == nil || (*input.ErrorCode != ErrorCommitOutcomeUnknown && *input.ErrorCode != ErrorReconciliationRequired) {
			return Envelope{}, failure(ErrorInvalidMessage, "$/errorCode", "reconciliation receipt requires one closed errorCode")
		}
	} else if input.ErrorCode != nil {
		return Envelope{}, failure(ErrorInvalidMessage, "$/errorCode", "accepted and duplicate receipts require null errorCode")
	}
	if input.Sequence < 1 || input.Sequence > MaxSafeInteger {
		return Envelope{}, failure(ErrorInvalidMessage, "$/sequence", "sequence must be a positive safe integer")
	}
	if _, err := requireTimestamp(input.SentAt, "$/sentAt"); err != nil {
		return Envelope{}, err
	}
	if err := requireHash(input.ControlBuildHash, "$/controlBuildHash"); err != nil {
		return Envelope{}, err
	}
	prepared, err := PrepareEnvelope(received)
	if err != nil {
		return Envelope{}, err
	}
	receiptIdentity, err := canonicaljson.Encode(map[string]any{
		"schema":           ReceiptIdentitySchema,
		"workspaceId":      received.WorkspaceID,
		"eventId":          received.EventID,
		"messageDigest":    prepared.MessageDigest,
		"status":           input.Status,
		"controlBuildHash": input.ControlBuildHash,
		"committedAt":      input.SentAt,
		"errorCode":        errorCode,
	})
	if err != nil {
		return Envelope{}, failure(ErrorInvalidMessage, "$", err.Error())
	}
	receipt := Envelope{
		ProtocolVersion: ProtocolVersion,
		Kind:            KindEventReceipt,
		WorkspaceID:     received.WorkspaceID,
		JobID:           cloneStringPointer(received.JobID),
		WorkflowRunID:   cloneStringPointer(received.WorkflowRunID),
		AttemptID:       cloneStringPointer(received.AttemptID),
		LeaseID:         cloneStringPointer(received.LeaseID),
		FencingToken:    cloneIntegerPointer(received.FencingToken),
		Sequence:        integerPointerValue(input.Sequence),
		EventID:         "receipt." + sha256Hex(receiptIdentity),
		CorrelationID:   received.CorrelationID,
		SentAt:          input.SentAt,
		Payload: map[string]any{
			"receivedEventId":        received.EventID,
			"receivedKind":           string(received.Kind),
			"receivedSequence":       *received.Sequence,
			"receivedDigest":         prepared.MessageDigest,
			"receivedIdempotencyKey": prepared.IdempotencyKey,
			"receivedFingerprint":    prepared.RequestFingerprint,
			"status":                 string(input.Status),
			"controlBuildHash":       input.ControlBuildHash,
			"committedAt":            input.SentAt,
			"errorCode":              errorCode,
		},
	}
	if err := ValidateEnvelope(receipt); err != nil {
		return Envelope{}, err
	}
	return receipt, nil
}

// ValidateEventReceipt proves that one closed event_receipt binds the exact
// runner-to-control message. It does not prove workflow approval, effect
// success, lease renewal, or any runtime-side action.
func ValidateEventReceipt(receipt, received Envelope, expectedControlBuildHash string) error {
	if err := ValidateEnvelope(received); err != nil {
		return err
	}
	if _, ok := receiptableKinds[string(received.Kind)]; !ok {
		return failure(ErrorIdentityMismatch, "$/kind", "message kind cannot receive an event receipt")
	}
	if err := ValidateEnvelope(receipt); err != nil {
		return err
	}
	if receipt.Kind != KindEventReceipt {
		return failure(ErrorIdentityMismatch, "$/kind", "expected event_receipt")
	}
	if receipt.WorkspaceID != received.WorkspaceID ||
		!equalStringPointer(receipt.JobID, received.JobID) ||
		!equalStringPointer(receipt.WorkflowRunID, received.WorkflowRunID) ||
		!equalStringPointer(receipt.AttemptID, received.AttemptID) ||
		!equalStringPointer(receipt.LeaseID, received.LeaseID) ||
		!equalIntegerPointer(receipt.FencingToken, received.FencingToken) ||
		receipt.CorrelationID != received.CorrelationID {
		return failure(ErrorIdentityMismatch, "$", "receipt envelope identity does not match the received event")
	}
	prepared, err := PrepareEnvelope(received)
	if err != nil {
		return err
	}
	if err := requireHash(expectedControlBuildHash, "$/expectedControlBuildHash"); err != nil {
		return err
	}
	payload := receipt.Payload
	receiptIdentity, err := canonicaljson.Encode(map[string]any{
		"schema":           ReceiptIdentitySchema,
		"workspaceId":      received.WorkspaceID,
		"eventId":          received.EventID,
		"messageDigest":    prepared.MessageDigest,
		"status":           payload["status"],
		"controlBuildHash": expectedControlBuildHash,
		"committedAt":      payload["committedAt"],
		"errorCode":        payload["errorCode"],
	})
	if err != nil {
		return failure(ErrorInvalidMessage, "$", err.Error())
	}
	if payload["receivedEventId"] != received.EventID ||
		payload["receivedKind"] != string(received.Kind) ||
		payload["receivedSequence"] != *received.Sequence ||
		payload["receivedDigest"] != prepared.MessageDigest ||
		payload["receivedIdempotencyKey"] != prepared.IdempotencyKey ||
		payload["receivedFingerprint"] != prepared.RequestFingerprint ||
		payload["controlBuildHash"] != expectedControlBuildHash ||
		receipt.SentAt != payload["committedAt"] ||
		receipt.EventID != "receipt."+sha256Hex(receiptIdentity) {
		return failure(ErrorHashMismatch, "$/payload", "receipt evidence does not match the received event")
	}
	return nil
}

func equalStringPointer(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func equalIntegerPointer(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func cloneStringPointer(value *string) *string {
	if value == nil {
		return nil
	}
	result := *value
	return &result
}

func cloneIntegerPointer(value *int64) *int64 {
	if value == nil {
		return nil
	}
	result := *value
	return &result
}

func integerPointerValue(value int64) *int64 { return &value }
