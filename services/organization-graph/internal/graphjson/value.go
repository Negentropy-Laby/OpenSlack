// Package graphjson implements the strict JSON parser and ECMAScript-compatible
// canonical encoder used by the Organization Graph parity contract.
//
// It intentionally does not use encoding/json as a byte authority. The existing
// TypeScript authority sorts strings by UTF-16 code units and serializes numbers
// and strings with JSON.stringify semantics.
package graphjson

import (
	"unicode/utf16"
	"unicode/utf8"
)

// Value is one of nil, bool, string, float64, Array, Object, UndefinedValue,
// SparseArray, or another value that the canonical encoder will reject as an
// unsupported type.
type Value any

// Array is a JSON array.
type Array []Value

// Object is a JSON object with unique string members.
type Object map[string]Value

// UndefinedValue represents JavaScript undefined at an explicit parity
// boundary. It is never produced by the strict JSON parser.
type UndefinedValue struct{}

// Undefined is the singleton used to model JavaScript undefined.
var Undefined = UndefinedValue{}

// SparseArray represents a JavaScript array with explicitly present indexes.
// It is never produced by the strict JSON parser.
type SparseArray struct {
	Length   int
	Elements map[int]Value
}

// Limits bound parser and encoder work.
type Limits struct {
	MaxDepth        *int
	MaxNodes        *int
	MaxStringLength *int
}

type resolvedLimits struct {
	MaxDepth        int
	MaxNodes        int
	MaxStringLength int
}

var defaultLimits = resolvedLimits{
	MaxDepth:        64,
	MaxNodes:        250_000,
	MaxStringLength: 32_768,
}

func DefaultLimits() Limits {
	maxDepth := defaultLimits.MaxDepth
	maxNodes := defaultLimits.MaxNodes
	maxStringLength := defaultLimits.MaxStringLength
	return Limits{
		MaxDepth:        &maxDepth,
		MaxNodes:        &maxNodes,
		MaxStringLength: &maxStringLength,
	}
}

// Limit returns a pointer suitable for an explicitly configured limit,
// including zero or a negative value.
func Limit(value int) *int {
	return &value
}

func normalizedLimits(input Limits) resolvedLimits {
	result := defaultLimits
	if input.MaxDepth != nil {
		result.MaxDepth = *input.MaxDepth
	}
	if input.MaxNodes != nil {
		result.MaxNodes = *input.MaxNodes
	}
	if input.MaxStringLength != nil {
		result.MaxStringLength = *input.MaxStringLength
	}
	return result
}

// UTF16Len returns the JavaScript string length of value.
func UTF16Len(value string) int {
	length := 0
	for _, current := range value {
		if current > 0xffff {
			length += 2
		} else {
			length++
		}
	}
	return length
}

// UTF16Less implements the relational string ordering used by JavaScript.
func UTF16Less(left, right string) bool {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	limit := len(leftUnits)
	if len(rightUnits) < limit {
		limit = len(rightUnits)
	}
	for index := 0; index < limit; index++ {
		if leftUnits[index] == rightUnits[index] {
			continue
		}
		return leftUnits[index] < rightUnits[index]
	}
	return len(leftUnits) < len(rightUnits)
}

// ValidString reports whether value is valid UTF-8 and contains no surrogate
// code point. Go strings cannot normally contain encoded surrogate code points,
// but the explicit check keeps the boundary fail-closed.
func ValidString(value string) bool {
	if !utf8.ValidString(value) {
		return false
	}
	for _, current := range value {
		if current >= 0xd800 && current <= 0xdfff {
			return false
		}
	}
	return true
}
