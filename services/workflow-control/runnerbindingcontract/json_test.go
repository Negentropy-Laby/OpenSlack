package runnerbindingcontract

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestStrictJSONRejectsAmbiguousInputs(t *testing.T) {
	const (
		maxBytes       = 1_024
		maxDepth       = 4
		maxNodes       = 16
		maxStringBytes = 32
		maxSafeInteger = int64(1<<53 - 1)
	)
	for name, input := range map[string][]byte{
		"empty":             {},
		"bom":               {0xef, 0xbb, 0xbf, '{', '}'},
		"duplicate":         []byte(`{"a":1,"a":2}`),
		"fraction":          []byte(`{"a":1.5}`),
		"noncanonical-zero": []byte(`{"a":-0}`),
		"unsafe-integer":    []byte(`{"a":9007199254740992}`),
		"trailing":          []byte(`{} {}`),
		"high-surrogate":    []byte(`{"a":"\ud800"}`),
		"low-surrogate":     []byte(`{"a":"\udc00"}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseStrictJSON(
				input,
				maxBytes,
				maxDepth,
				maxNodes,
				maxStringBytes,
				maxSafeInteger,
			); err == nil {
				t.Fatal("ambiguous JSON input was accepted")
			}
		})
	}
}

func TestBindingParserIncludesTerminalLFInFrameLimit(t *testing.T) {
	t.Parallel()
	fixedBytes := len([]byte(`{"x":["",""]}`)) + 1
	firstLength := MaxStringBytes
	secondLength := MaxFrameBytes - fixedBytes - firstLength
	exact := []byte(`{"x":["` + strings.Repeat("a", firstLength) + `","` + strings.Repeat("b", secondLength) + `"]}` + "\n")
	if len(exact) != MaxFrameBytes {
		t.Fatalf("test frame has %d bytes, want %d", len(exact), MaxFrameBytes)
	}
	_, err := ParseStageBytes(exact)
	var contractErr *ContractError
	if !errors.As(err, &contractErr) || contractErr.Code != ErrorUnknownField || contractErr.Path != "$/schema" {
		t.Fatalf("exact-limit frame should reach validation, got %v", err)
	}
	over := append(append([]byte(nil), exact[:len(exact)-1]...), ' ', '\n')
	_, err = ParseStageBytes(over)
	if !errors.As(err, &contractErr) || contractErr.Code != ErrorLimitExceeded {
		t.Fatalf("over-limit frame should fail before parsing, got %v", err)
	}
}

func TestBindingParserClassifiesStrictJSONFailures(t *testing.T) {
	t.Parallel()
	for name, input := range map[string][]byte{
		"bom":          append([]byte{0xef, 0xbb, 0xbf}, []byte("{}\n")...),
		"invalid utf8": {'{', '"', 'x', '"', ':', '"', 0xff, '"', '}', '\n'},
		"duplicate":    []byte("{\"x\":1,\"x\":2}\n"),
		"surrogate":    []byte("{\"x\":\"\\ud800\"}\n"),
		"unsafe":       []byte("{\"x\":9007199254740992}\n"),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ParseStageBytes(input)
			var contractErr *ContractError
			if !errors.As(err, &contractErr) || contractErr.Code != ErrorInvalid || contractErr.Path != "$" {
				t.Fatalf("expected strict invalid binding frame, got %v", err)
			}
		})
	}
	longKey := strings.Repeat("界", MaxStringBytes/3+1)
	_, err := ParseStageBytes([]byte(`{"` + longKey + `":0}` + "\n"))
	var contractErr *ContractError
	if !errors.As(err, &contractErr) || contractErr.Code != ErrorLimitExceeded || contractErr.Path != "$" {
		t.Fatalf("expected binding key byte limit, got %v", err)
	}
}

func TestCanonicalLFUsesUTF16KeyOrderAndExactFraming(t *testing.T) {
	encoded, err := canonicalLF(Record{"\ue000": int64(2), "\U00010000": int64(1)})
	if err != nil {
		t.Fatal(err)
	}
	if want := []byte("{\"𐀀\":1,\"\":2}\n"); !bytes.Equal(encoded, want) {
		t.Fatalf("canonical bytes drifted: got %q want %q", encoded, want)
	}
	if !hasExactlyOneLF(encoded) || hasExactlyOneLF(bytes.TrimSuffix(encoded, []byte{'\n'})) ||
		hasExactlyOneLF(append(append([]byte(nil), encoded...), '\n')) ||
		hasExactlyOneLF([]byte(strings.TrimSuffix(string(encoded), "\n")+"\r\n")) {
		t.Fatal("exactly-one-LF framing predicate drifted")
	}
}
