package notificationstore

import (
	"strings"
	"testing"
)

func validIntake() ValidatedIntake {
	return ValidatedIntake{
		CallerID:       "caller-1",
		VendorID:       "vendor-a",
		Payload:        []byte(`{"event":"signup"}`),
		IdempotencyKey: "key-001",
	}
}

func TestValidateIntake_Valid(t *testing.T) {
	if err := ValidateIntake(validIntake()); err != nil {
		t.Fatalf("valid intake rejected: %v", err)
	}
}

func TestValidateIntake_MissingFields(t *testing.T) {
	cases := map[string]ValidatedIntake{
		"no caller":  {CallerID: "", VendorID: "v", Payload: []byte("x"), IdempotencyKey: "k"},
		"no vendor":  {CallerID: "c", VendorID: "", Payload: []byte("x"), IdempotencyKey: "k"},
		"nil payload": {CallerID: "c", VendorID: "v", Payload: nil, IdempotencyKey: "k"},
		"no key":     {CallerID: "c", VendorID: "v", Payload: []byte("x"), IdempotencyKey: ""},
	}
	for name, in := range cases {
		if err := ValidateIntake(in); !IsRejection(err, RejectionInvalidIntake) {
			t.Fatalf("%s: expected invalid-intake, got %v", name, err)
		}
	}
}

func TestValidateIntake_PayloadBound(t *testing.T) {
	in := validIntake()
	in.Payload = make([]byte, PayloadMaxBytes)
	if err := ValidateIntake(in); err != nil {
		t.Fatalf("exactly max payload rejected: %v", err)
	}
	in.Payload = make([]byte, PayloadMaxBytes+1)
	if err := ValidateIntake(in); !IsRejection(err, RejectionPayloadTooLarge) {
		t.Fatalf("expected payload-too-large, got %v", err)
	}
}

func TestValidateIntake_IdempotencyKeyCharset(t *testing.T) {
	in := validIntake()
	in.IdempotencyKey = strings.Repeat("a", 255)
	if err := ValidateIntake(in); err != nil {
		t.Fatalf("255-char key rejected: %v", err)
	}
	in.IdempotencyKey = strings.Repeat("a", 256)
	if err := ValidateIntake(in); !IsRejection(err, RejectionInvalidIdempotencyKey) {
		t.Fatalf("expected invalid-idempotency-key for 256 chars, got %v", err)
	}
	in.IdempotencyKey = "bad key with spaces"
	if err := ValidateIntake(in); !IsRejection(err, RejectionInvalidIdempotencyKey) {
		t.Fatalf("expected invalid-idempotency-key for spaces, got %v", err)
	}
	in.IdempotencyKey = "valid.KEY_1-x"
	if err := ValidateIntake(in); err != nil {
		t.Fatalf("valid charset rejected: %v", err)
	}
}

func TestComputeFingerprint_Deterministic(t *testing.T) {
	a := ComputeFingerprint(validIntake())
	b := ComputeFingerprint(validIntake())
	if FingerprintHex(a) != FingerprintHex(b) {
		t.Fatalf("fingerprint not deterministic")
	}
	in := validIntake()
	in.Payload = []byte(`{"event":"other"}`)
	c := ComputeFingerprint(in)
	if FingerprintHex(a) == FingerprintHex(c) {
		t.Fatalf("different payloads must produce different fingerprints")
	}
}

func TestActorContext_Validate(t *testing.T) {
	valid := ActorContext{Kind: ActorWorker, ActorID: "w", VendorScope: []string{"v"}, Capabilities: []Capability{CapabilityClaimDelivery}}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid actor rejected: %v", err)
	}
	for name, a := range map[string]ActorContext{
		"no kind":   {Kind: "", ActorID: "w", VendorScope: []string{"v"}, Capabilities: []Capability{CapabilityClaimDelivery}},
		"no id":     {Kind: ActorWorker, ActorID: "", VendorScope: []string{"v"}, Capabilities: []Capability{CapabilityClaimDelivery}},
		"no scope":  {Kind: ActorWorker, ActorID: "w", VendorScope: nil, Capabilities: []Capability{CapabilityClaimDelivery}},
		"no caps":   {Kind: ActorWorker, ActorID: "w", VendorScope: []string{"v"}, Capabilities: nil},
	} {
		if err := a.Validate(); !IsRejection(err, RejectionInvalidActorContext) {
			t.Fatalf("%s: expected invalid-actor-context, got %v", name, err)
		}
	}
}

func TestActorContext_EffectiveScope(t *testing.T) {
	a := ActorContext{Kind: ActorOperator, ActorID: "op", VendorScope: []string{"v1", "v2"}, Capabilities: []Capability{CapabilityReplay}}

	scope, ok := a.EffectiveScope(nil)
	if !ok || len(scope) != 2 {
		t.Fatalf("empty filter must resolve to actor scope, got %v ok=%v", scope, ok)
	}
	scope, ok = a.EffectiveScope([]string{"v2"})
	if !ok || len(scope) != 1 || scope[0] != "v2" {
		t.Fatalf("in-scope filter mismatch: %v ok=%v", scope, ok)
	}
	_, ok = a.EffectiveScope([]string{"v3"})
	if ok {
		t.Fatalf("out-of-scope filter must be rejected")
	}
}

func TestActorContext_CoversVendor(t *testing.T) {
	a := ActorContext{Kind: ActorWorker, ActorID: "w", VendorScope: []string{"v1"}, Capabilities: []Capability{CapabilityClaimDelivery}}
	if !a.CoversVendor("v1") {
		t.Fatalf("expected coverage for v1")
	}
	if a.CoversVendor("v2") {
		t.Fatalf("unexpected coverage for v2")
	}
}
