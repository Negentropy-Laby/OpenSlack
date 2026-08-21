package strictjson

import (
	"errors"
	"testing"
)

func TestParseRejectsAmbiguousInputWithTypedFailures(t *testing.T) {
	t.Parallel()
	limits := Limits{
		MaxBytes:       1 << 20,
		MaxDepth:       4,
		MaxNodes:       16,
		MaxStringBytes: 32,
		MaxSafeInteger: 1<<53 - 1,
		NumberPolicy:   NumberCanonicalSafeInteger,
	}
	for name, input := range map[string][]byte{
		"empty":          {},
		"bom":            {0xef, 0xbb, 0xbf, '{', '}'},
		"invalid utf8":   {'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'},
		"duplicate":      []byte(`{"a":1,"a":2}`),
		"trailing":       []byte(`{} {}`),
		"high surrogate": []byte(`{"a":"\ud800"}`),
		"low surrogate":  []byte(`{"a":"\udc00"}`),
		"negative zero":  []byte(`{"a":-0}`),
		"fraction":       []byte(`{"a":1.5}`),
		"unsafe integer": []byte(`{"a":9007199254740992}`),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Parse(input, limits)
			var failure *Error
			if !errors.As(err, &failure) || failure.Kind != ErrorInvalid {
				t.Fatalf("expected typed invalid failure, got %v", err)
			}
		})
	}
}

func TestParseUsesOneRootDepthAndBoundsKeysByUTF8Bytes(t *testing.T) {
	t.Parallel()
	base := Limits{
		MaxBytes:       1 << 20,
		MaxDepth:       3,
		MaxNodes:       8,
		MaxStringBytes: 6,
		MaxSafeInteger: 1<<53 - 1,
		NumberPolicy:   NumberCanonicalSafeInteger,
	}
	if _, err := Parse([]byte(`{"a":{"b":0}}`), base); err != nil {
		t.Fatalf("depth-three value rejected: %v", err)
	}
	if _, err := Parse([]byte(`{"a":{"b":{"c":0}}}`), base); err == nil {
		t.Fatal("depth-four value was accepted")
	}
	_, err := Parse([]byte(`{"界界界":0}`), base)
	var failure *Error
	if !errors.As(err, &failure) || failure.Kind != ErrorLimit || failure.Path != "$/界界界" {
		t.Fatalf("expected UTF-8 key byte limit at the exact path, got %v", err)
	}
	if _, err := Parse([]byte(`{"a":[0,0,0,0,0,0,0,0]}`), base); err == nil {
		t.Fatal("node limit input was accepted")
	}
}

func TestInt64PolicyPreservesAuthorityRangeWithoutSafeIntegerRestriction(t *testing.T) {
	t.Parallel()
	value, err := Parse([]byte(`{"value":9007199254740992}`), Limits{
		MaxDepth:       2,
		MaxNodes:       2,
		MaxStringBytes: 16,
		NumberPolicy:   NumberInt64,
	})
	if err != nil {
		t.Fatal(err)
	}
	if value.(map[string]any)["value"] != int64(9007199254740992) {
		t.Fatalf("int64 authority value drifted: %#v", value)
	}
}
