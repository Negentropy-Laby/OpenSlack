package effectshadowstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type goldenVector struct {
	Value          json.RawMessage `json:"value"`
	CanonicalBytes string          `json:"canonicalBytes"`
	SHA256         string          `json:"sha256"`
}

type effectShadowGolden struct {
	SourceEnvelopes map[string]goldenVector `json:"sourceEnvelopes"`
	Responses       map[string]goldenVector `json:"responses"`
}

func loadEffectShadowGolden(t *testing.T) effectShadowGolden {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "packages", "workflows", "contracts", "workflow-effect-shadow", "v1", "golden-vectors.json")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read TS golden: %v", err)
	}
	var value effectShadowGolden
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatalf("decode TS golden: %v", err)
	}
	return value
}

func TestWorkflowEffectShadowGoldenVectors(t *testing.T) {
	golden := loadEffectShadowGolden(t)
	for _, name := range []string{"approvalCreated", "approvalDecided", "auditRecorded"} {
		t.Run(name, func(t *testing.T) {
			vector := golden.SourceEnvelopes[name]
			digest := sha256.Sum256([]byte(vector.CanonicalBytes))
			if got := hex.EncodeToString(digest[:]); got != vector.SHA256 {
				t.Fatalf("canonical vector SHA = %s, want %s", got, vector.SHA256)
			}
			prepared, err := PrepareObservation(append([]byte(vector.CanonicalBytes), '\n'))
			if err != nil {
				t.Fatalf("PrepareObservation: %v", err)
			}
			if prepared.Envelope.SourceSequence != prepared.Envelope.Observation.ApprovalRevision+1 {
				t.Fatal("source sequence is not approval revision + 1")
			}
			if prepared.Envelope.Operation != prepared.Envelope.Observation.Operation {
				t.Fatal("operation binding drifted")
			}
			key := IdempotencyPrefix + prepared.EnvelopeHash
			if !IdempotencyKeyMatchesEnvelope(key, prepared.EnvelopeHash) || IdempotencyKeyMatchesEnvelope(IdempotencyPrefix+strings.Repeat("0", 64), prepared.EnvelopeHash) {
				t.Fatal("idempotency key does not bind the exact envelope hash")
			}
		})
	}
}

func TestWorkflowEffectShadowOutboxCursorPreservesDatabasePrecision(t *testing.T) {
	recordedAt := time.Date(2026, 8, 14, 1, 2, 3, 123456000, time.UTC)
	cursor, err := EncodeOutboxCursor(recordedAt, "WECS-OUTBOX-cursor")
	if err != nil {
		t.Fatal(err)
	}
	decodedAt, eventID, err := DecodeOutboxCursor(cursor)
	if err != nil || !decodedAt.Equal(recordedAt) || eventID != "WECS-OUTBOX-cursor" {
		t.Fatalf("decoded cursor = %s/%q err=%v", decodedAt.Format(time.RFC3339Nano), eventID, err)
	}
	if _, _, err := DecodeOutboxCursor(cursor + "="); !IsCode(err, ErrorInputInvalid) {
		t.Fatalf("non-canonical cursor = %v", err)
	}
}

func TestWorkflowEffectShadowRejectsFramingAndAuthorityDrift(t *testing.T) {
	vector := loadEffectShadowGolden(t).SourceEnvelopes["approvalCreated"]
	for name, body := range map[string][]byte{
		"missing LF":     []byte(vector.CanonicalBytes),
		"CRLF":           append([]byte(vector.CanonicalBytes), '\r', '\n'),
		"double LF":      append([]byte(vector.CanonicalBytes), '\n', '\n'),
		"trailing value": append([]byte(vector.CanonicalBytes), '\n', '{', '}'),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := PrepareObservation(body); !IsCode(err, ErrorContentInvalid) {
				t.Fatalf("error = %v, want content invalid", err)
			}
		})
	}

	var envelope map[string]any
	if err := json.Unmarshal(vector.Value, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope["nonAuthorizingObservation"] = false
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareObservation(append(body, '\n')); !IsCode(err, ErrorInputInvalid) && !IsCode(err, ErrorContentInvalid) {
		t.Fatalf("error = %v, want fail closed", err)
	}
}

func TestWorkflowEffectShadowCompareLatchesMismatch(t *testing.T) {
	golden := loadEffectShadowGolden(t)
	created, err := PrepareObservation(append([]byte(golden.SourceEnvelopes["approvalCreated"].CanonicalBytes), '\n'))
	if err != nil {
		t.Fatal(err)
	}
	decided, err := PrepareObservation(append([]byte(golden.SourceEnvelopes["approvalDecided"].CanonicalBytes), '\n'))
	if err != nil {
		t.Fatal(err)
	}
	previous := &Head{
		WorkspaceID:    created.Envelope.Observation.WorkspaceID,
		RunID:          created.Envelope.Observation.RunID,
		OccurrenceID:   created.Envelope.Observation.OccurrenceID,
		ApprovalID:     created.Envelope.Observation.ApprovalID,
		SourceSequence: 1,
		Operation:      OperationApprovalCreated,
		Observation:    &created.Envelope.Observation,
	}
	if parity, code := Compare(decided.Envelope, previous); parity != "matched" || code != "" {
		t.Fatalf("valid decision = %s/%s", parity, code)
	}
	previous.MismatchLatched = true
	if parity, code := Compare(decided.Envelope, previous); parity != "mismatched" || code != "PRIOR_MISMATCH_LATCHED" {
		t.Fatalf("latched decision = %s/%s", parity, code)
	}
}
