package runnerbindingcontract

import (
	"bytes"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/strictjson"
)

// Record is the closed contract's neutral JSON object representation. Public
// validators return a fresh Record so callers cannot mutate embedded vectors
// or retain decoder-owned data.
type Record map[string]any

func parseStrictJSON(input []byte, maxBytes, maxDepth, maxNodes, maxStringBytes int, maxSafeInteger int64) (any, error) {
	return strictjson.Parse(input, strictjson.Limits{
		MaxBytes:       maxBytes,
		MaxDepth:       maxDepth,
		MaxNodes:       maxNodes,
		MaxStringBytes: maxStringBytes,
		MaxSafeInteger: maxSafeInteger,
		NumberPolicy:   strictjson.NumberCanonicalSafeInteger,
	})
}

func canonicalJSON(value any) ([]byte, error) { return canonicaljson.Encode(value) }

func canonicalLF(value any) ([]byte, error) {
	encoded, err := canonicalJSON(value)
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}

func hasExactlyOneLF(input []byte) bool {
	return len(input) > 1 && input[len(input)-1] == '\n' &&
		input[len(input)-2] != '\n' && !bytes.ContainsRune(input, '\r')
}
