package canonicaljson

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

var forbiddenKeys = map[string]struct{}{
	"__proto__": {}, "prototype": {}, "constructor": {},
}

func Encode(value Value) ([]byte, error) {
	encoder := encoder{activeArrays: map[*Array]struct{}{}, activeObjects: map[*Object]struct{}{}}
	if err := encoder.value(value, "$", 0); err != nil {
		return nil, err
	}
	return encoder.output, nil
}

type encoder struct {
	output        []byte
	activeArrays  map[*Array]struct{}
	activeObjects map[*Object]struct{}
}

func (encoder *encoder) value(value Value, path string, depth int) error {
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
		encoder.output = append(encoder.output, '[')
		for index, item := range current {
			if index > 0 {
				encoder.output = append(encoder.output, ',')
			}
			if err := encoder.value(item, path+"["+strconv.Itoa(index)+"]", depth+1); err != nil {
				return err
			}
		}
		encoder.output = append(encoder.output, ']')
	case Object:
		keys := make([]string, 0, len(current))
		for key := range current {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(left, right int) bool { return UTF16Less(keys[left], keys[right]) })
		encoder.output = append(encoder.output, '{')
		for index, key := range keys {
			if !ValidString(key) {
				return encodeFail(ErrorUnsupported, path, "canonical JSON rejects invalid Unicode keys")
			}
			if _, forbidden := forbiddenKeys[key]; forbidden {
				return encodeFail(ErrorForbidden, path+"/"+key, "canonical JSON rejects forbidden key")
			}
			if index > 0 {
				encoder.output = append(encoder.output, ',')
			}
			if err := encoder.string(key, path+"/"+key); err != nil {
				return err
			}
			encoder.output = append(encoder.output, ':')
			if err := encoder.value(current[key], path+"/"+key, depth+1); err != nil {
				return err
			}
		}
		encoder.output = append(encoder.output, '}')
	default:
		return encodeFail(ErrorUnsupported, path, "canonical JSON accepts only strict JSON values")
	}
	return nil
}

func (encoder *encoder) string(value, path string) error {
	if !ValidString(value) {
		return encodeFail(ErrorUnsupported, path, "canonical JSON rejects invalid Unicode strings")
	}
	encoder.output = append(encoder.output, '"')
	for cursor := 0; cursor < len(value); {
		if unit, size, ok := decodeWTF8Surrogate(value[cursor:]); ok {
			const hexadecimal = "0123456789abcdef"
			encoder.output = append(encoder.output, '\\', 'u',
				hexadecimal[unit>>12], hexadecimal[(unit>>8)&0x0f],
				hexadecimal[(unit>>4)&0x0f], hexadecimal[unit&0x0f])
			cursor += size
			continue
		}
		current, size := utf8.DecodeRuneInString(value[cursor:])
		cursor += size
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
				encoder.output = append(encoder.output, '\\', 'u', '0', '0', hexadecimal[byte(current)>>4], hexadecimal[byte(current)&0x0f])
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
		return "", encodeFail(ErrorUnsupported, path, "canonical JSON rejects non-finite numbers")
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
	prefix, suffix := result[:exponent+1], result[exponent+1:]
	sign := ""
	if strings.HasPrefix(suffix, "+") || strings.HasPrefix(suffix, "-") {
		sign, suffix = suffix[:1], suffix[1:]
	}
	suffix = strings.TrimLeft(suffix, "0")
	if suffix == "" {
		suffix = "0"
	}
	return prefix + sign + suffix, nil
}
