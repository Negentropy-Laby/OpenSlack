package graphjson_test

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

func TestCanonicalECMAScriptBytes(t *testing.T) {
	t.Parallel()
	value := graphjson.Object{
		"\ue000":     float64(1),
		"\U00010000": float64(2),
		"text":       "<>&\u2028\u2029",
		"numbers": graphjson.Array{
			math.Copysign(0, -1),
			1e-7,
			1e-6,
			1e20,
			1e21,
			333333333.33333329,
		},
	}
	actual, err := graphjson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	const expected = `{"numbers":[0,1e-7,0.000001,100000000000000000000,1e+21,333333333.3333333],"text":"<>&  ","𐀀":2,"":1}`
	if string(actual) != expected {
		t.Fatalf("canonical JSON mismatch:\n got: %s\nwant: %s", actual, expected)
	}
}

func TestStrictParserRejectsAmbiguousBytes(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		data []byte
		code graphjson.ErrorCode
	}{
		{"bom", []byte{0xef, 0xbb, 0xbf, '{', '}'}, graphjson.ErrorBOMForbidden},
		{"utf8", []byte{'"', 0xff, '"'}, graphjson.ErrorUTF8Invalid},
		{"duplicate", []byte(`{"a":1,"a":2}`), graphjson.ErrorDuplicateKey},
		{"trailing", []byte(`{} {}`), graphjson.ErrorSyntax},
		{"surrogate", []byte(`"\ud800"`), graphjson.ErrorSyntax},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			_, err := graphjson.Parse(testCase.data, graphjson.Limits{})
			var strictError *graphjson.Error
			if !errors.As(err, &strictError) || strictError.Code != testCase.code {
				t.Fatalf("got %v, want %s", err, testCase.code)
			}
		})
	}
}

func TestStrictParserReportsUTF16SourceOffsets(t *testing.T) {
	t.Parallel()
	_, err := graphjson.Parse([]byte(`{"𐀀":0,"𐀀":1}`), graphjson.Limits{})
	var strictError *graphjson.Error
	if !errors.As(err, &strictError) {
		t.Fatalf("got %v, want strict error", err)
	}
	if strictError.Code != graphjson.ErrorDuplicateKey || strictError.Offset != 8 {
		t.Fatalf("got %s at %d, want %s at 8", strictError.Code, strictError.Offset, graphjson.ErrorDuplicateKey)
	}
}

func TestStrictParserRoundTrip(t *testing.T) {
	t.Parallel()
	const source = `{"nested":{"escaped":"\ud800\udc00","empty":[]},"number":-0}`
	value, err := graphjson.Parse([]byte(source), graphjson.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	actual, err := graphjson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	const expected = `{"nested":{"empty":[],"escaped":"𐀀"},"number":0}`
	if string(actual) != expected {
		t.Fatalf("got %s, want %s", actual, expected)
	}
}

func TestParserAndEncoderBounds(t *testing.T) {
	t.Parallel()
	if _, err := graphjson.Parse(
		[]byte(`[[[0]]]`),
		graphjson.Limits{MaxDepth: graphjson.Limit(3)},
	); err == nil {
		t.Fatal("depth limit accepted")
	}
	value := graphjson.Array{graphjson.Array{graphjson.Array{float64(0)}}}
	if _, err := graphjson.EncodeBounded(
		value,
		graphjson.Limits{MaxDepth: graphjson.Limit(3)},
	); err == nil {
		t.Fatal("encoder depth limit accepted")
	}
}

func TestCanonicalEncoderDoesNotInheritParserLimits(t *testing.T) {
	t.Parallel()
	longString := strings.Repeat("x", 32_769)
	if _, err := graphjson.Encode(longString); err != nil {
		t.Fatalf("unbounded canonical string rejected: %v", err)
	}
	var deep graphjson.Value = float64(0)
	for range 65 {
		deep = graphjson.Array{deep}
	}
	if _, err := graphjson.Encode(deep); err != nil {
		t.Fatalf("unbounded canonical depth rejected: %v", err)
	}
	many := make(graphjson.Array, 250_001)
	for index := range many {
		many[index] = nil
	}
	if _, err := graphjson.Encode(many); err != nil {
		t.Fatalf("unbounded canonical node count rejected: %v", err)
	}
}

func TestCanonicalObjectErrorPrecedenceIsSorted(t *testing.T) {
	t.Parallel()
	value := graphjson.Object{"a": math.NaN(), "constructor": float64(1)}
	for range 100 {
		_, err := graphjson.Encode(value)
		var canonicalError *graphjson.CanonicalError
		if !errors.As(err, &canonicalError) ||
			canonicalError.Code != graphjson.CanonicalNonFinite ||
			canonicalError.Path != "$.a" {
			t.Fatalf("canonical precedence drifted: %v", err)
		}
	}
}

func TestCanonicalEncoderRejectsCycles(t *testing.T) {
	t.Parallel()
	object := graphjson.Object{}
	object["self"] = object
	array := make(graphjson.Array, 1)
	array[0] = array
	for name, value := range map[string]graphjson.Value{
		"object": object,
		"array":  array,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := graphjson.Encode(value)
			var canonicalError *graphjson.CanonicalError
			if !errors.As(err, &canonicalError) ||
				canonicalError.Code != graphjson.CanonicalUnsupported {
				t.Fatalf("cyclic value was not rejected safely: %v", err)
			}
		})
	}
}
