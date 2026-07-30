package graphjson

import (
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

var forbiddenKeys = map[string]struct{}{
	"__proto__":   {},
	"prototype":   {},
	"constructor": {},
}

// Encode returns the canonical JSON bytes used by the TypeScript authority.
func Encode(value Value) ([]byte, error) {
	return encodeWithLimits(value, resolvedLimits{
		MaxDepth:        math.MaxInt,
		MaxNodes:        math.MaxInt,
		MaxStringLength: math.MaxInt,
	})
}

// EncodeBounded returns canonical JSON while bounding recursive work.
func EncodeBounded(value Value, limits Limits) ([]byte, error) {
	return encodeWithLimits(value, normalizedLimits(limits))
}

func encodeWithLimits(value Value, limits resolvedLimits) ([]byte, error) {
	encoder := encoder{
		limits: limits,
		active: map[containerIdentity]struct{}{},
	}
	if err := encoder.value(value, 1, "$"); err != nil {
		return nil, err
	}
	return encoder.output, nil
}

type encoder struct {
	output []byte
	nodes  int
	limits resolvedLimits
	active map[containerIdentity]struct{}
}

type containerIdentity struct {
	kind     reflect.Kind
	pointer  uintptr
	length   int
	capacity int
}

func identityOf(value Value) (containerIdentity, bool) {
	switch current := value.(type) {
	case Array:
		reflected := reflect.ValueOf(current)
		return containerIdentity{
			kind: reflect.Slice, pointer: reflected.Pointer(),
			length: len(current), capacity: cap(current),
		}, true
	case Object:
		return containerIdentity{
			kind: reflect.Map, pointer: reflect.ValueOf(current).Pointer(),
			length: len(current),
		}, true
	case SparseArray:
		return containerIdentity{
			kind: reflect.Map, pointer: reflect.ValueOf(current.Elements).Pointer(),
			length: current.Length,
		}, true
	default:
		return containerIdentity{}, false
	}
}

func (encoder *encoder) value(value Value, depth int, path string) error {
	if depth > encoder.limits.MaxDepth {
		return fail(ErrorLimit, len(encoder.output), "JSON nesting depth exceeds its limit")
	}
	encoder.nodes++
	if encoder.nodes > encoder.limits.MaxNodes {
		return fail(ErrorLimit, len(encoder.output), "JSON node count exceeds its limit")
	}
	if identity, container := identityOf(value); container {
		if _, exists := encoder.active[identity]; exists {
			return canonicalFail(
				CanonicalUnsupported,
				path,
				"Canonical JSON rejects cyclic values.",
			)
		}
		encoder.active[identity] = struct{}{}
		defer delete(encoder.active, identity)
	}
	switch current := value.(type) {
	case nil:
		encoder.output = append(encoder.output, "null"...)
	case bool:
		encoder.output = strconv.AppendBool(encoder.output, current)
	case string:
		return encoder.string(current, path)
	case float64:
		number, err := formatNumber(current, path)
		if err != nil {
			return err
		}
		encoder.output = append(encoder.output, number...)
	case Array:
		if current == nil {
			return canonicalFail(CanonicalUnsupported, path, "Canonical JSON rejects nil arrays.")
		}
		encoder.output = append(encoder.output, '[')
		for index, item := range current {
			if index > 0 {
				encoder.output = append(encoder.output, ',')
			}
			if err := encoder.value(item, depth+1, path+"["+strconv.Itoa(index)+"]"); err != nil {
				return err
			}
		}
		encoder.output = append(encoder.output, ']')
	case Object:
		if current == nil {
			return canonicalFail(CanonicalUnsupported, path, "Canonical JSON rejects nil objects.")
		}
		return encoder.object(current, depth, path)
	case UndefinedValue:
		return canonicalFail(CanonicalUnsupported, path, "Canonical JSON rejects undefined.")
	case SparseArray:
		if current.Length < 0 {
			return canonicalFail(CanonicalUnsupported, path, "Canonical JSON rejects invalid sparse arrays.")
		}
		for index := range current.Elements {
			if index < 0 || index >= current.Length {
				return canonicalFail(CanonicalUnsupported, path, "Canonical JSON rejects invalid sparse arrays.")
			}
		}
		encoder.output = append(encoder.output, '[')
		for index := 0; index < current.Length; index++ {
			item, exists := current.Elements[index]
			if !exists {
				return canonicalFail(
					CanonicalSparseArray,
					path+"["+strconv.Itoa(index)+"]",
					"Canonical JSON rejects sparse arrays.",
				)
			}
			if index > 0 {
				encoder.output = append(encoder.output, ',')
			}
			if err := encoder.value(item, depth+1, path+"["+strconv.Itoa(index)+"]"); err != nil {
				return err
			}
		}
		encoder.output = append(encoder.output, ']')
	default:
		return canonicalFail(CanonicalUnsupported, path, "Canonical JSON accepts only strict JSON values.")
	}
	return nil
}

func (encoder *encoder) object(value Object, depth int, path string) error {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(left, right int) bool {
		return UTF16Less(keys[left], keys[right])
	})
	encoder.output = append(encoder.output, '{')
	for index, key := range keys {
		if !ValidString(key) {
			return canonicalFail(CanonicalUnsupported, path, "Canonical JSON rejects invalid Unicode keys.")
		}
		if _, forbidden := forbiddenKeys[key]; forbidden {
			return canonicalFail(CanonicalForbidden, path+"."+key, "Canonical JSON rejects key "+key+".")
		}
		if index > 0 {
			encoder.output = append(encoder.output, ',')
		}
		if err := encoder.string(key, path+"."+key); err != nil {
			return err
		}
		encoder.output = append(encoder.output, ':')
		if _, undefined := value[key].(UndefinedValue); undefined {
			return canonicalFail(
				CanonicalUndefined,
				path+"."+key,
				"Canonical JSON rejects undefined.",
			)
		}
		if err := encoder.value(value[key], depth+1, path+"."+key); err != nil {
			return err
		}
	}
	encoder.output = append(encoder.output, '}')
	return nil
}

func (encoder *encoder) string(value, path string) error {
	if !ValidString(value) {
		return canonicalFail(CanonicalUnsupported, path, "Canonical JSON rejects invalid Unicode strings.")
	}
	if UTF16Len(value) > encoder.limits.MaxStringLength {
		return fail(ErrorLimit, len(encoder.output), "JSON string exceeds its limit")
	}
	encoder.output = append(encoder.output, '"')
	for len(value) > 0 {
		current, size := utf8.DecodeRuneInString(value)
		value = value[size:]
		switch current {
		case '"', '\\':
			encoder.output = append(encoder.output, '\\', byte(current))
		case '\b':
			encoder.output = append(encoder.output, '\\', 'b')
		case '\t':
			encoder.output = append(encoder.output, '\\', 't')
		case '\n':
			encoder.output = append(encoder.output, '\\', 'n')
		case '\f':
			encoder.output = append(encoder.output, '\\', 'f')
		case '\r':
			encoder.output = append(encoder.output, '\\', 'r')
		default:
			if current <= 0x1f {
				const hexadecimal = "0123456789abcdef"
				encoder.output = append(
					encoder.output,
					'\\', 'u', '0', '0',
					hexadecimal[byte(current)>>4],
					hexadecimal[byte(current)&0x0f],
				)
			} else {
				encoder.output = utf8.AppendRune(encoder.output, current)
			}
		}
	}
	encoder.output = append(encoder.output, '"')
	return nil
}

func formatNumber(value float64, path string) (string, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", canonicalFail(CanonicalNonFinite, path, "Canonical JSON rejects non-finite numbers.")
	}
	if value == 0 {
		return "0", nil
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64), nil
	}
	result := strconv.FormatFloat(value, 'e', -1, 64)
	exponent := strings.LastIndexByte(result, 'e')
	if exponent < 0 {
		return result, nil
	}
	prefix := result[:exponent+1]
	suffix := result[exponent+1:]
	sign := ""
	if strings.HasPrefix(suffix, "+") || strings.HasPrefix(suffix, "-") {
		sign = suffix[:1]
		suffix = suffix[1:]
	}
	suffix = strings.TrimLeft(suffix, "0")
	if suffix == "" {
		suffix = "0"
	}
	return prefix + sign + suffix, nil
}
