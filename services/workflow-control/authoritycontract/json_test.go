package authoritycontract

import (
	"strings"
	"testing"
)

func TestStrictJSONRejectsAmbiguousAndFloatingInputs(t *testing.T) {
	tests := []struct {
		name  string
		input string
		match string
	}{
		{name: "duplicate", input: `{"value":1,"value":2}`, match: "duplicate JSON object key"},
		{name: "lone high surrogate", input: `{"value":"\ud800"}`, match: "unpaired Unicode surrogate"},
		{name: "lone low surrogate", input: `{"value":"\udc00"}`, match: "unpaired Unicode surrogate"},
		{name: "fraction", input: `{"value":0.1}`, match: "must be an int64"},
		{name: "exponent", input: `{"value":1e3}`, match: "must be an int64"},
		{name: "overflow", input: `{"value":9223372036854775808}`, match: "must be an int64"},
		{name: "trailing value", input: `{"value":1}{"value":2}`, match: "trailing JSON"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := parseStrictJSON([]byte(testCase.input), 8, 32, 64)
			if err == nil || !strings.Contains(err.Error(), testCase.match) {
				t.Fatalf("error = %v, want substring %q", err, testCase.match)
			}
		})
	}
	if _, err := parseStrictJSON([]byte{0xef, 0xbb, 0xbf, '{', '}'}, 8, 32, 64); err == nil || !strings.Contains(err.Error(), "BOM") {
		t.Fatalf("BOM error = %v", err)
	}
}

func TestStrictJSONPreservesValidSurrogatePairAndIntegers(t *testing.T) {
	value, err := parseStrictJSON([]byte(`{"emoji":"\ud83d\ude00","value":42}`), 8, 32, 64)
	if err != nil {
		t.Fatal(err)
	}
	record, ok := value.(map[string]any)
	if !ok || record["emoji"] != "😀" || record["value"] != int64(42) {
		t.Fatalf("decoded value = %#v", value)
	}
}
