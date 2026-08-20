package runnerbindingcontract

import (
	"bytes"
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
