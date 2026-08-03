package runnerprotocol

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

const testHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestHandshakeCanonicalRoundTripAndFingerprint(t *testing.T) {
	message := Envelope{
		ProtocolVersion: ProtocolVersion,
		Kind:            KindHello,
		WorkspaceID:     "workspace-test",
		EventID:         "event-hello",
		CorrelationID:   "correlation-test",
		SentAt:          "2026-08-03T00:00:00.000Z",
		Payload: map[string]any{
			"runnerBuildHash":           testHash,
			"runtimeName":               "node",
			"runtimeVersion":            "22.14.0",
			"supportedProtocolVersions": []any{ProtocolVersion},
			"capabilities":              []any{"cancel_ack", "effect_receipts", "lease_heartbeat"},
			"maxConcurrentJobs":         int64(1),
		},
	}
	canonical, err := CanonicalEnvelopeBytes(message)
	if err != nil {
		t.Fatal(err)
	}
	if canonical[len(canonical)-1] != '\n' || bytes.HasSuffix(canonical, []byte("\n\n")) {
		t.Fatalf("canonical body must have one trailing LF: %q", canonical)
	}
	decoded, err := ValidateCanonicalEnvelopeBytes(canonical)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Kind != KindHello || decoded.JobID != nil || decoded.Sequence != nil {
		t.Fatalf("unexpected decoded handshake: %#v", decoded)
	}
	prepared, err := PrepareEnvelope(message)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.Schema != PreparedMessageSchema || !strings.HasPrefix(prepared.IdempotencyKey, idempotencyPrefix) || !strings.HasPrefix(prepared.RequestFingerprint, "sha256:") {
		t.Fatalf("unexpected prepared message: %#v", prepared)
	}
}

func TestLeaseOfferAndReceiptBinding(t *testing.T) {
	received := leasedEnvelope(KindLeaseAccept, 2, "2026-08-03T00:00:01.000Z", map[string]any{
		"acceptedAt":     "2026-08-03T00:00:01.000Z",
		"leaseExpiresAt": "2026-08-03T00:01:00.000Z",
	})
	prepared, err := PrepareEnvelope(received)
	if err != nil {
		t.Fatal(err)
	}
	receipt := leasedEnvelope(KindEventReceipt, 3, "2026-08-03T00:00:02.000Z", map[string]any{
		"receivedEventId":        received.EventID,
		"receivedKind":           string(received.Kind),
		"receivedSequence":       *received.Sequence,
		"receivedDigest":         prepared.MessageDigest,
		"receivedIdempotencyKey": prepared.IdempotencyKey,
		"receivedFingerprint":    prepared.RequestFingerprint,
		"status":                 "accepted",
		"committedAt":            "2026-08-03T00:00:02.000Z",
		"controlBuildHash":       testHash,
		"errorCode":              nil,
	})
	receiptIdentity, err := canonicaljson.Encode(map[string]any{
		"schema": ReceiptIdentitySchema, "workspaceId": received.WorkspaceID,
		"eventId": received.EventID, "messageDigest": prepared.MessageDigest,
		"status": "accepted", "controlBuildHash": testHash,
		"committedAt": "2026-08-03T00:00:02.000Z", "errorCode": nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	receipt.EventID = "receipt." + sha256Hex(receiptIdentity)
	if err := ValidateEventReceipt(receipt, received, testHash); err != nil {
		t.Fatal(err)
	}
	receipt.Payload["receivedDigest"] = strings.Repeat("b", 64)
	if err := ValidateEventReceipt(receipt, received, testHash); contractCode(t, err) != ErrorHashMismatch {
		t.Fatalf("receipt mismatch error = %v", err)
	}
}

func TestClosedAndSensitiveBoundary(t *testing.T) {
	message := leasedEnvelope(KindLeaseOffer, 1, "2026-08-03T00:00:00.000Z", map[string]any{
		"executionDescriptorRef":  "descriptor-1",
		"executionDescriptorHash": testHash,
		"jobSpecHash":             testHash,
		"workflowId":              "workflow.test",
		"workflowVersion":         "1.0.0",
		"workflowSourceHash":      testHash,
		"manifestHash":            testHash,
		"inputHash":               testHash,
		"offeredAt":               "2026-08-03T00:00:00.000Z",
		"expiresAt":               "2026-08-03T00:01:00.000Z",
	})
	canonical, err := CanonicalEnvelopeBytes(message)
	if err != nil {
		t.Fatal(err)
	}
	unknown := bytes.Replace(canonical, []byte(`"payload":{`), []byte(`"unknown":true,"payload":{`), 1)
	if _, err := ValidateEnvelopeJSON(unknown); contractCode(t, err) != ErrorUnknownField {
		t.Fatalf("unknown field error = %v", err)
	}
	duplicate := bytes.Replace(canonical, []byte(`"kind":`), []byte(`"kind":"lease_offer","kind":`), 1)
	if _, err := ValidateEnvelopeJSON(duplicate); contractCode(t, err) != ErrorInvalidMessage {
		t.Fatalf("duplicate field error = %v", err)
	}
	message.Payload["command"] = "node arbitrary.js"
	if err := ValidateEnvelope(message); contractCode(t, err) != ErrorUnknownField {
		t.Fatalf("sensitive field error = %v", err)
	}
	loneSurrogate := bytes.Replace(canonical, []byte(`"workflow.test"`), []byte(`"\ud800"`), 1)
	if _, err := ValidateEnvelopeJSON(loneSurrogate); contractCode(t, err) != ErrorInvalidMessage {
		t.Fatalf("surrogate error = %v", err)
	}
}

func TestHandshakeAndLeaseIdentityAreDisjoint(t *testing.T) {
	hello := Envelope{
		ProtocolVersion: ProtocolVersion,
		Kind:            KindHello,
		WorkspaceID:     "workspace-test",
		JobID:           stringPointer("job-test"),
		EventID:         "event-test",
		CorrelationID:   "correlation-test",
		SentAt:          "2026-08-03T00:00:00.000Z",
		Payload: map[string]any{
			"runnerBuildHash":           testHash,
			"runtimeName":               "node",
			"runtimeVersion":            "22.14.0",
			"supportedProtocolVersions": []any{ProtocolVersion},
			"capabilities":              []any{},
			"maxConcurrentJobs":         int64(1),
		},
	}
	if err := ValidateEnvelope(hello); contractCode(t, err) != ErrorIdentityMismatch {
		t.Fatalf("handshake identity error = %v", err)
	}
	leased := leasedEnvelope(KindHeartbeat, 1, "2026-08-03T00:00:00.000Z", map[string]any{
		"observedAt":          "2026-08-03T00:00:00.000Z",
		"leaseExpiresAt":      "2026-08-03T00:01:00.000Z",
		"state":               "running",
		"lastReceiptSequence": int64(0),
	})
	leased.LeaseID = nil
	if err := ValidateEnvelope(leased); contractCode(t, err) != ErrorInvalidMessage {
		t.Fatalf("leased identity error = %v", err)
	}
}

func leasedEnvelope(kind Kind, sequence int64, sentAt string, payload map[string]any) Envelope {
	return Envelope{
		ProtocolVersion: ProtocolVersion,
		Kind:            kind,
		WorkspaceID:     "workspace-test",
		JobID:           stringPointer("job-test"),
		WorkflowRunID:   stringPointer("run-test"),
		AttemptID:       stringPointer("attempt-test"),
		LeaseID:         stringPointer("lease-test"),
		FencingToken:    integerPointer(1),
		Sequence:        integerPointer(sequence),
		EventID:         "event-" + string(kind),
		CorrelationID:   "correlation-test",
		SentAt:          sentAt,
		Payload:         payload,
	}
}

func stringPointer(value string) *string { return &value }
func integerPointer(value int64) *int64  { return &value }

func contractCode(t *testing.T, err error) ErrorCode {
	t.Helper()
	var contractErr *ContractError
	if !errors.As(err, &contractErr) {
		t.Fatalf("got %T %v, want ContractError", err, err)
	}
	return contractErr.Code
}
