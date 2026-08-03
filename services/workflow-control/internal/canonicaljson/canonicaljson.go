// Package canonicaljson provides the bounded ECMAScript-compatible encoder
// used for the Workflow Control shadow HTTP surface.
package canonicaljson

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

type Value any
type Array []Value
type Object map[string]Value

func Encode(value Value) ([]byte, error) {
	encoder := &state{arrays: map[*Array]struct{}{}, objects: map[*Object]struct{}{}}
	if err := encoder.write(value, "$", 0); err != nil {
		return nil, err
	}
	return encoder.output, nil
}

type state struct {
	output  []byte
	arrays  map[*Array]struct{}
	objects map[*Object]struct{}
}

func (encoder *state) write(value Value, path string, depth int) error {
	if depth > 64 {
		return fmt.Errorf("canonical JSON depth exceeded at %s", path)
	}
	switch current := value.(type) {
	case nil:
		encoder.output = append(encoder.output, "null"...)
	case bool:
		encoder.output = strconv.AppendBool(encoder.output, current)
	case string:
		return encoder.writeString(current, path)
	case float64:
		number, err := formatNumber(current)
		if err != nil {
			return fmt.Errorf("canonical JSON number at %s: %w", path, err)
		}
		encoder.output = append(encoder.output, number...)
	case int:
		encoder.output = strconv.AppendInt(encoder.output, int64(current), 10)
	case int64:
		encoder.output = strconv.AppendInt(encoder.output, current, 10)
	case Array:
		if _, active := encoder.arrays[&current]; active {
			return fmt.Errorf("canonical JSON cycle at %s", path)
		}
		encoder.arrays[&current] = struct{}{}
		defer delete(encoder.arrays, &current)
		encoder.output = append(encoder.output, '[')
		for index, item := range current {
			if index > 0 {
				encoder.output = append(encoder.output, ',')
			}
			if err := encoder.write(item, path+"["+strconv.Itoa(index)+"]", depth+1); err != nil {
				return err
			}
		}
		encoder.output = append(encoder.output, ']')
	case Object:
		if _, active := encoder.objects[&current]; active {
			return fmt.Errorf("canonical JSON cycle at %s", path)
		}
		encoder.objects[&current] = struct{}{}
		defer delete(encoder.objects, &current)
		keys := make([]string, 0, len(current))
		for key := range current {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(left, right int) bool { return utf16Less(keys[left], keys[right]) })
		encoder.output = append(encoder.output, '{')
		for index, key := range keys {
			if index > 0 {
				encoder.output = append(encoder.output, ',')
			}
			if err := encoder.writeString(key, path+"/"+key); err != nil {
				return err
			}
			encoder.output = append(encoder.output, ':')
			if err := encoder.write(current[key], path+"/"+key, depth+1); err != nil {
				return err
			}
		}
		encoder.output = append(encoder.output, '}')
	default:
		return fmt.Errorf("unsupported canonical JSON value %T at %s", value, path)
	}
	return nil
}

func (encoder *state) writeString(value, path string) error {
	if !utf8.ValidString(value) {
		return fmt.Errorf("invalid UTF-8 string at %s", path)
	}
	encoder.output = append(encoder.output, '"')
	for _, current := range value {
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
				encoder.output = append(encoder.output, fmt.Sprintf("\\u%04x", current)...)
			} else {
				encoder.output = utf8.AppendRune(encoder.output, current)
			}
		}
	}
	encoder.output = append(encoder.output, '"')
	return nil
}

func utf16Less(left, right string) bool {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
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

func formatNumber(value float64) (string, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", fmt.Errorf("non-finite number")
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
