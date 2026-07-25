package notificationstore

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

type fingerprintGoldenFile struct {
	Schema    string                    `json:"schema"`
	Algorithm string                    `json:"algorithm"`
	Vectors   []fingerprintGoldenVector `json:"vectors"`
}

type fingerprintGoldenVector struct {
	Name           string `json:"name"`
	VendorID       string `json:"vendor_id"`
	CallerID       string `json:"caller_id"`
	IdempotencyKey string `json:"idempotency_key"`
	PayloadBase64  string `json:"payload_base64"`
	ExpectedSHA256 string `json:"expected_sha256"`
}

func TestComputeFingerprint_V1GoldenVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/fingerprint-v1.json")
	if err != nil {
		t.Fatalf("read fingerprint vectors: %v", err)
	}

	var golden fingerprintGoldenFile
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("decode fingerprint vectors: %v", err)
	}
	if golden.Schema != "rc_wsman.notification_fingerprint_vectors.v1" {
		t.Fatalf("unexpected vector schema %q", golden.Schema)
	}
	if golden.Algorithm != "sha256(vendor_id || 0x00 || caller_id || 0x00 || idempotency_key || 0x00 || payload_bytes)" {
		t.Fatalf("unexpected fingerprint algorithm %q", golden.Algorithm)
	}
	if len(golden.Vectors) == 0 {
		t.Fatal("fingerprint vectors must not be empty")
	}

	seen := make(map[string]string, len(golden.Vectors))
	for _, vector := range golden.Vectors {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			payload, err := base64.StdEncoding.DecodeString(vector.PayloadBase64)
			if err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			if payload == nil {
				payload = []byte{}
			}

			actual := FingerprintHex(ComputeFingerprint(ValidatedIntake{
				VendorID:       vector.VendorID,
				CallerID:       vector.CallerID,
				IdempotencyKey: vector.IdempotencyKey,
				Payload:        payload,
			}))
			if actual != vector.ExpectedSHA256 {
				t.Fatalf("fingerprint mismatch: got %s want %s", actual, vector.ExpectedSHA256)
			}
			if previous, exists := seen[actual]; exists {
				t.Fatalf("vector collides with %q", previous)
			}
			seen[actual] = vector.Name
		})
	}
}
