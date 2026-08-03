package canonicaljson

import (
	"math"
	"strings"
	"testing"
)

func TestEncodeSharesTypedAndObjectCanonicalization(t *testing.T) {
	type sample struct {
		Array        []string `json:"array"`
		Large        float64  `json:"large"`
		NegativeZero float64  `json:"negativeZero"`
		Small        float64  `json:"small"`
	}
	typed := sample{
		Array:        []string{"line\nfeed", "quote\"slash\\"},
		Large:        1e21,
		NegativeZero: math.Copysign(0, -1),
		Small:        1e-7,
	}
	object := Object{
		"array":        Array{"line\nfeed", "quote\"slash\\"},
		"large":        1e21,
		"negativeZero": math.Copysign(0, -1),
		"small":        1e-7,
	}

	typedBytes, err := Encode(typed)
	if err != nil {
		t.Fatalf("encode typed value: %v", err)
	}
	objectBytes, err := Encode(object)
	if err != nil {
		t.Fatalf("encode object value: %v", err)
	}
	if string(typedBytes) != string(objectBytes) {
		t.Fatalf("typed and object encodings differ:\ntyped:  %s\nobject: %s", typedBytes, objectBytes)
	}
	want := `{"array":["line\nfeed","quote\"slash\\"],"large":1e+21,"negativeZero":0,"small":1e-7}`
	if string(typedBytes) != want {
		t.Fatalf("unexpected canonical bytes:\n got: %s\nwant: %s", typedBytes, want)
	}
}

func TestEncodeUsesUTF16KeyOrder(t *testing.T) {
	encoded, err := Encode(Object{"\ue000": 2, "\U00010000": 1})
	if err != nil {
		t.Fatalf("encode object: %v", err)
	}
	if got, want := string(encoded), "{\"𐀀\":1,\"\":2}"; got != want {
		t.Fatalf("unexpected UTF-16 key order: got %s want %s", got, want)
	}
}

func TestEncodeRejectsCyclesAndNonFiniteNumbers(t *testing.T) {
	cycle := Object{}
	cycle["self"] = cycle
	if _, err := Encode(cycle); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("expected cycle error, got %v", err)
	}
	if _, err := Encode(math.Inf(1)); err == nil || !strings.Contains(err.Error(), "non-finite") {
		t.Fatalf("expected non-finite number error, got %v", err)
	}
}
