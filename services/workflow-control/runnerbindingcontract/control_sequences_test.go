package runnerbindingcontract

import (
	"encoding/json"
	"math"
	"testing"
)

func TestControlSequenceMatrix(t *testing.T) {
	for kind, want := range map[string]int64{"event_receipt": 3, "budget_authorization": 4, "effect_authorization": 4, "resume_offer": 4, "cancel_request": 4} {
		if got := controlCompanionSequence(kind); got != want {
			t.Fatalf("%s: got %d want %d", kind, got, want)
		}
	}
	if controlCompanionSequence("unknown") != 0 {
		t.Fatal("unknown kind acquired a sequence")
	}
}

func TestGoldenDynamicNumbers(t *testing.T) {
	value, err := normalizeGoldenDynamic(map[string]any{"nested": []any{json.Number("3.5"), json.Number("3e0"), json.Number("1e999"), json.Number("3")}})
	if err != nil {
		t.Fatal(err)
	}
	numbers := value.(map[string]any)["nested"].([]any)
	if numbers[0] != float64(3.5) || numbers[1] != float64(3) || !math.IsInf(numbers[2].(float64), 1) || numbers[3] != int64(3) {
		t.Fatalf("incorrect normalized values: %v", numbers)
	}
	if _, err := normalizeGoldenDynamic(json.Number("not-a-number")); err == nil {
		t.Fatal("invalid fixture syntax was hidden")
	}
}
