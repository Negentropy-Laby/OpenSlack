// Package canonicaljson implements the strict JSON and ECMAScript-compatible
// canonical encoding used by the TypeScript governed-plan authority.
package canonicaljson

import (
	"unicode/utf16"
	"unicode/utf8"
)

type Value any
type Array []Value
type Object map[string]Value

type Limits struct {
	MaxDepth        int
	MaxNodes        int
	MaxStringLength int
}

func UTF16Less(left, right string) bool {
	leftUnits, leftValid := UTF16CodeUnits(left, -1)
	rightUnits, rightValid := UTF16CodeUnits(right, -1)
	if !leftValid || !rightValid {
		return left < right
	}
	limit := len(leftUnits)
	if len(rightUnits) < limit {
		limit = len(rightUnits)
	}
	for index := 0; index < limit; index++ {
		if leftUnits[index] != rightUnits[index] {
			return leftUnits[index] < rightUnits[index]
		}
	}
	return len(leftUnits) < len(rightUnits)
}

func ValidString(value string) bool {
	_, valid := UTF16CodeUnits(value, -1)
	return valid
}

// UTF16CodeUnits decodes normal UTF-8 plus the internal WTF-8 representation
// used to preserve lone ECMAScript UTF-16 surrogates. A non-negative limit
// stops allocation as soon as the returned unit count exceeds the limit.
func UTF16CodeUnits(value string, limit int) ([]uint16, bool) {
	units := make([]uint16, 0, min(len(value), boundedCapacity(limit)))
	for cursor := 0; cursor < len(value); {
		if unit, size, ok := decodeWTF8Surrogate(value[cursor:]); ok {
			units = append(units, unit)
			cursor += size
		} else {
			current, size := utf8.DecodeRuneInString(value[cursor:])
			if current == utf8.RuneError && size == 1 {
				return nil, false
			}
			if current > 0xffff {
				first, second := utf16.EncodeRune(current)
				units = append(units, uint16(first), uint16(second))
			} else {
				units = append(units, uint16(current))
			}
			cursor += size
		}
		if limit >= 0 && len(units) > limit {
			return units, true
		}
	}
	return units, true
}

func boundedCapacity(limit int) int {
	if limit < 0 {
		return 0
	}
	return limit + 1
}

func decodeWTF8Surrogate(value string) (uint16, int, bool) {
	if len(value) < 3 || value[0] != 0xed || value[1] < 0xa0 || value[1] > 0xbf || value[2] < 0x80 || value[2] > 0xbf {
		return 0, 0, false
	}
	unit := uint16(value[0]&0x0f)<<12 | uint16(value[1]&0x3f)<<6 | uint16(value[2]&0x3f)
	return unit, 3, unit >= 0xd800 && unit <= 0xdfff
}

func AppendWTF8CodeUnit(output []byte, unit uint16) []byte {
	return append(output,
		0xe0|byte(unit>>12),
		0x80|byte((unit>>6)&0x3f),
		0x80|byte(unit&0x3f),
	)
}
