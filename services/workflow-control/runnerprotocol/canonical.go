package runnerprotocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

const (
	PreparedMessageSchema = "openslack.workflow_runner_prepared_message.v1"
	FingerprintSchema     = "openslack.workflow_runner_request_fingerprint.v1"
	ReceiptIdentitySchema = "openslack.workflow_runner_receipt_identity.v1"
	idempotencyPrefix     = "openslack.workflow-runner.v1."
)

type PreparedMessage struct {
	Schema             string `json:"schema"`
	Body               []byte `json:"body"`
	MessageDigest      string `json:"messageDigest"`
	IdempotencyKey     string `json:"idempotencyKey"`
	RequestFingerprint string `json:"requestFingerprint"`
}

func ValidateEnvelopeJSON(input []byte) (Envelope, error) {
	if len(input) == 0 || len(input) > MaxEnvelopeBytes {
		return Envelope{}, failure(ErrorLimitExceeded, "$", "message exceeds its byte limit")
	}
	parsed, err := parseStrictJSON(input, MaxJSONDepth, MaxJSONNodes)
	if err != nil {
		return Envelope{}, err
	}
	root, ok := parsed.(map[string]any)
	if !ok {
		return Envelope{}, failure(ErrorInvalidMessage, "$", "message must be an object")
	}
	fieldOrder := []string{
		"protocolVersion", "kind", "workspaceId", "jobId", "workflowRunId", "attemptId", "leaseId",
		"fencingToken", "sequence", "eventId", "correlationId", "sentAt", "payload",
	}
	allowed := make(map[string]struct{}, len(fieldOrder))
	for _, key := range fieldOrder {
		allowed[key] = struct{}{}
	}
	for _, key := range sortedObjectKeys(root) {
		if _, exists := allowed[key]; !exists {
			return Envelope{}, failure(ErrorUnknownField, "$/"+key, "unknown message field")
		}
	}
	for _, key := range fieldOrder {
		if _, exists := root[key]; !exists {
			return Envelope{}, failure(ErrorInvalidMessage, "$/"+key, "required message field is missing")
		}
	}

	value := Envelope{}
	if value.ProtocolVersion, ok = root["protocolVersion"].(string); !ok {
		return Envelope{}, failure(ErrorInvalidMessage, "$/protocolVersion", "protocolVersion must be a string")
	}
	kind, ok := root["kind"].(string)
	if !ok {
		return Envelope{}, failure(ErrorInvalidMessage, "$/kind", "kind must be a string")
	}
	value.Kind = Kind(kind)
	if value.WorkspaceID, ok = root["workspaceId"].(string); !ok {
		return Envelope{}, failure(ErrorInvalidMessage, "$/workspaceId", "workspaceId must be a string")
	}
	if value.EventID, ok = root["eventId"].(string); !ok {
		return Envelope{}, failure(ErrorInvalidMessage, "$/eventId", "eventId must be a string")
	}
	if value.CorrelationID, ok = root["correlationId"].(string); !ok {
		return Envelope{}, failure(ErrorInvalidMessage, "$/correlationId", "correlationId must be a string")
	}
	if value.SentAt, ok = root["sentAt"].(string); !ok {
		return Envelope{}, failure(ErrorInvalidMessage, "$/sentAt", "sentAt must be a string")
	}
	for _, binding := range []struct {
		field       string
		destination **string
	}{
		{"jobId", &value.JobID}, {"workflowRunId", &value.WorkflowRunID},
		{"attemptId", &value.AttemptID}, {"leaseId", &value.LeaseID},
	} {
		decoded, decodeErr := nullableString(root[binding.field], "$/"+binding.field)
		if decodeErr != nil {
			return Envelope{}, decodeErr
		}
		*binding.destination = decoded
	}
	if value.FencingToken, err = nullableInteger(root["fencingToken"], "$/fencingToken"); err != nil {
		return Envelope{}, err
	}
	if value.Sequence, err = nullableInteger(root["sequence"], "$/sequence"); err != nil {
		return Envelope{}, err
	}
	if value.Payload, ok = root["payload"].(map[string]any); !ok || value.Payload == nil {
		return Envelope{}, failure(ErrorInvalidMessage, "$/payload", "payload must be a non-null object")
	}
	if err := ValidateEnvelope(value); err != nil {
		return Envelope{}, err
	}
	return value, nil
}

func ValidateCanonicalEnvelopeBytes(input []byte) (Envelope, error) {
	if len(input) == 0 || len(input) > MaxEnvelopeBytes || input[len(input)-1] != '\n' ||
		(len(input) > 1 && input[len(input)-2] == '\n') || bytes.Contains(input, []byte{'\r'}) {
		return Envelope{}, failure(ErrorInvalidMessage, "$", "message bytes must end with exactly one LF within the byte limit")
	}
	value, err := ValidateEnvelopeJSON(input)
	if err != nil {
		var contractErr *ContractError
		if errors.As(err, &contractErr) &&
			(contractErr.Code == ErrorLimitExceeded || contractErr.Path == "$" || strings.Contains(contractErr.Message, "duplicate JSON object key")) {
			return Envelope{}, failure(ErrorInvalidMessage, "$", contractErr.Message)
		}
		return Envelope{}, err
	}
	canonical, err := CanonicalEnvelopeBytes(value)
	if err != nil {
		return Envelope{}, err
	}
	if !bytes.Equal(input, canonical) {
		return Envelope{}, failure(ErrorInvalidMessage, "$", "message bytes are not canonical")
	}
	return value, nil
}

func CanonicalEnvelopeBytes(value Envelope) ([]byte, error) {
	if err := ValidateEnvelope(value); err != nil {
		return nil, err
	}
	encoded, err := canonicaljson.Encode(value)
	if err != nil {
		return nil, failure(ErrorInvalidMessage, "$", err.Error())
	}
	return append(encoded, '\n'), nil
}

func HashEnvelope(value Envelope) (string, error) {
	prepared, err := PrepareEnvelope(value)
	if err != nil {
		return "", err
	}
	return prepared.MessageDigest, nil
}

func IdempotencyKey(value Envelope) (string, error) {
	prepared, err := PrepareEnvelope(value)
	if err != nil {
		return "", err
	}
	return prepared.IdempotencyKey, nil
}

func RequestFingerprint(value Envelope) (string, error) {
	prepared, err := PrepareEnvelope(value)
	if err != nil {
		return "", err
	}
	return prepared.RequestFingerprint, nil
}

func PrepareEnvelope(value Envelope) (PreparedMessage, error) {
	canonical, err := CanonicalEnvelopeBytes(value)
	if err != nil {
		return PreparedMessage{}, err
	}
	direction, err := DirectionForKind(value.Kind)
	if err != nil {
		return PreparedMessage{}, err
	}
	messageDigest := sha256Hex(canonical)
	preimage, err := canonicaljson.Encode(map[string]any{
		"schema":          FingerprintSchema,
		"direction":       direction,
		"protocolVersion": value.ProtocolVersion,
		"kind":            value.Kind,
		"workspaceId":     value.WorkspaceID,
		"jobId":           value.JobID,
		"workflowRunId":   value.WorkflowRunID,
		"attemptId":       value.AttemptID,
		"leaseId":         value.LeaseID,
		"fencingToken":    value.FencingToken,
		"sequence":        value.Sequence,
		"eventId":         value.EventID,
		"correlationId":   value.CorrelationID,
		"messageDigest":   messageDigest,
	})
	if err != nil {
		return PreparedMessage{}, failure(ErrorInvalidMessage, "$", err.Error())
	}
	return PreparedMessage{
		Schema:             PreparedMessageSchema,
		Body:               append([]byte(nil), canonical...),
		MessageDigest:      messageDigest,
		IdempotencyKey:     idempotencyPrefix + messageDigest,
		RequestFingerprint: "sha256:" + sha256Hex(preimage),
	}, nil
}

func nullableString(value any, path string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, failure(ErrorInvalidMessage, path, "value must be a string or null")
	}
	return &text, nil
}

func nullableInteger(value any, path string) (*int64, error) {
	if value == nil {
		return nil, nil
	}
	integer, ok := value.(int64)
	if !ok {
		return nil, failure(ErrorInvalidMessage, path, "value must be an integer or null")
	}
	return &integer, nil
}

func sha256Hex(input []byte) string {
	digest := sha256.Sum256(input)
	return hex.EncodeToString(digest[:])
}
