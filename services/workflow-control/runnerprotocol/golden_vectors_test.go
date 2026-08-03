package runnerprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
)

const goldenControlBuildHash = "7777777777777777777777777777777777777777777777777777777777777777"

type goldenPrepared struct {
	Schema             string `json:"schema"`
	Body               string `json:"body"`
	MessageDigest      string `json:"messageDigest"`
	IdempotencyKey     string `json:"idempotencyKey"`
	RequestFingerprint string `json:"requestFingerprint"`
}

type goldenError struct {
	Code string `json:"code"`
	Path string `json:"path"`
}

type goldenPositive struct {
	ID       string          `json:"id"`
	Input    json.RawMessage `json:"input"`
	Expected goldenPrepared  `json:"expected"`
}

type goldenReceipt struct {
	ID       string          `json:"id"`
	Received json.RawMessage `json:"received"`
	Receipt  json.RawMessage `json:"receipt"`
	Expected goldenPrepared  `json:"expected"`
}

type goldenNegative struct {
	ID            string          `json:"id"`
	Operation     string          `json:"operation"`
	Input         json.RawMessage `json:"input"`
	Received      json.RawMessage `json:"received"`
	ExpectedError goldenError     `json:"expectedError"`
}

type goldenFixture struct {
	Schema          string           `json:"schema"`
	ProtocolVersion string           `json:"protocolVersion"`
	Positive        []goldenPositive `json:"positive"`
	Receipts        []goldenReceipt  `json:"receipts"`
	Negative        []goldenNegative `json:"negative"`
}

func TestGoldenVectorsMatchTypeScriptAuthority(t *testing.T) {
	var fixture goldenFixture
	if err := json.Unmarshal(GoldenVectorsBytes(), &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Schema != "openslack.workflow_runner_golden_vectors.v1" || fixture.ProtocolVersion != ProtocolVersion {
		t.Fatalf("unexpected golden identity: %q %q", fixture.Schema, fixture.ProtocolVersion)
	}
	if len(fixture.Positive) != 12 || len(fixture.Receipts) != 7 || len(fixture.Negative) != 36 {
		t.Fatalf("unexpected vector inventory: positive=%d receipts=%d negative=%d", len(fixture.Positive), len(fixture.Receipts), len(fixture.Negative))
	}

	for _, vector := range fixture.Positive {
		vector := vector
		t.Run("positive/"+vector.ID, func(t *testing.T) {
			message, err := ValidateEnvelopeJSON(vector.Input)
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := PrepareEnvelope(message)
			if err != nil {
				t.Fatal(err)
			}
			assertGoldenPrepared(t, prepared, vector.Expected)
			if _, err := ValidateCanonicalEnvelopeBytes([]byte(vector.Expected.Body)); err != nil {
				t.Fatalf("expected body is not accepted as exact canonical bytes: %v", err)
			}
		})
	}

	for _, vector := range fixture.Receipts {
		vector := vector
		t.Run("receipt/"+vector.ID, func(t *testing.T) {
			received := mustGoldenEnvelope(t, vector.Received)
			receipt := mustGoldenEnvelope(t, vector.Receipt)
			if err := ValidateEventReceipt(receipt, received, goldenControlBuildHash); err != nil {
				t.Fatal(err)
			}
			prepared, err := PrepareEnvelope(receipt)
			if err != nil {
				t.Fatal(err)
			}
			assertGoldenPrepared(t, prepared, vector.Expected)

			status := ReceiptStatus(receipt.Payload["status"].(string))
			var errorCode *ErrorCode
			if encoded, ok := receipt.Payload["errorCode"].(string); ok {
				value := ErrorCode(encoded)
				errorCode = &value
			}
			created, err := CreateEventReceipt(received, CreateReceiptInput{
				Sequence: *receipt.Sequence, SentAt: receipt.SentAt, Status: status,
				ControlBuildHash: goldenControlBuildHash, ErrorCode: errorCode,
			})
			if err != nil {
				t.Fatal(err)
			}
			createdBytes, err := CanonicalEnvelopeBytes(created)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(createdBytes, []byte(vector.Expected.Body)) {
				t.Fatalf("created receipt differs from authoritative body\ngot:  %s\nwant: %s", createdBytes, vector.Expected.Body)
			}
		})
	}

	for _, vector := range fixture.Negative {
		vector := vector
		t.Run("negative/"+vector.ID, func(t *testing.T) {
			var err error
			switch vector.Operation {
			case "validate":
				_, err = ValidateEnvelopeJSON(vector.Input)
			case "parse_bytes":
				var input string
				if decodeErr := json.Unmarshal(vector.Input, &input); decodeErr != nil {
					t.Fatal(decodeErr)
				}
				_, err = ValidateCanonicalEnvelopeBytes([]byte(input))
			case "receipt":
				var receipt, received Envelope
				receipt, err = ValidateEnvelopeJSON(vector.Input)
				if err == nil {
					received, err = ValidateEnvelopeJSON(vector.Received)
				}
				if err == nil {
					err = ValidateEventReceipt(receipt, received, goldenControlBuildHash)
				}
			case "create_receipt":
				var received Envelope
				received, err = ValidateEnvelopeJSON(vector.Input)
				if err == nil {
					errCode := (*ErrorCode)(nil)
					_, err = CreateEventReceipt(received, CreateReceiptInput{
						Sequence: 999, SentAt: "2026-08-03T04:00:00.000Z",
						Status: ReceiptAccepted, ControlBuildHash: goldenControlBuildHash, ErrorCode: errCode,
					})
				}
			default:
				t.Fatalf("unknown golden operation %q", vector.Operation)
			}
			assertGoldenError(t, err, vector.ExpectedError)
		})
	}
}

func mustGoldenEnvelope(t *testing.T, input json.RawMessage) Envelope {
	t.Helper()
	message, err := ValidateEnvelopeJSON(input)
	if err != nil {
		t.Fatal(err)
	}
	return message
}

func assertGoldenPrepared(t *testing.T, actual PreparedMessage, expected goldenPrepared) {
	t.Helper()
	if actual.Schema != expected.Schema || actual.MessageDigest != expected.MessageDigest ||
		actual.IdempotencyKey != expected.IdempotencyKey || actual.RequestFingerprint != expected.RequestFingerprint ||
		!bytes.Equal(actual.Body, []byte(expected.Body)) {
		t.Fatalf("prepared message differs from authoritative vector\ngot:  schema=%q digest=%q key=%q fingerprint=%q body=%q\nwant: schema=%q digest=%q key=%q fingerprint=%q body=%q",
			actual.Schema, actual.MessageDigest, actual.IdempotencyKey, actual.RequestFingerprint, actual.Body,
			expected.Schema, expected.MessageDigest, expected.IdempotencyKey, expected.RequestFingerprint, expected.Body)
	}
}

func assertGoldenError(t *testing.T, err error, expected goldenError) {
	t.Helper()
	var contractErr *ContractError
	if !errors.As(err, &contractErr) {
		t.Fatalf("got %T %v, want ContractError %s at %s", err, err, expected.Code, expected.Path)
	}
	if string(contractErr.Code) != expected.Code || contractErr.Path != expected.Path {
		t.Fatalf("got %s at %s, want %s at %s", contractErr.Code, contractErr.Path, expected.Code, expected.Path)
	}
}
