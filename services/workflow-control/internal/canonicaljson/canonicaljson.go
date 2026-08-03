// Package canonicaljson provides the bounded ECMAScript-compatible encoder
// shared by the Workflow Control contract and shadow HTTP surface.
package canonicaljson

import (
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

type Value any
type Array []Value
type Object map[string]Value

const maxDepth = 64

type visit struct {
	kind     reflect.Kind
	pointer  uintptr
	length   int
	capacity int
}

func Encode(value Value) ([]byte, error) {
	encoder := &state{active: make(map[visit]struct{})}
	if err := encoder.write(reflect.ValueOf(value), "$", 0); err != nil {
		return nil, err
	}
	return encoder.output, nil
}

type state struct {
	output []byte
	active map[visit]struct{}
}

func (encoder *state) enter(value reflect.Value, path string) (func(), error) {
	if value.IsNil() {
		return func() {}, nil
	}
	current := visit{kind: value.Kind(), pointer: value.Pointer()}
	if value.Kind() == reflect.Slice {
		current.length = value.Len()
		current.capacity = value.Cap()
	}
	if _, exists := encoder.active[current]; exists {
		return nil, fmt.Errorf("canonical JSON cycle at %s", path)
	}
	encoder.active[current] = struct{}{}
	return func() { delete(encoder.active, current) }, nil
}

func (encoder *state) write(value reflect.Value, path string, depth int) error {
	if depth > maxDepth {
		return fmt.Errorf("canonical JSON depth exceeded at %s", path)
	}
	if !value.IsValid() {
		encoder.output = append(encoder.output, "null"...)
		return nil
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			encoder.output = append(encoder.output, "null"...)
			return nil
		}
		if value.Kind() == reflect.Pointer {
			leave, err := encoder.enter(value, path)
			if err != nil {
				return err
			}
			defer leave()
		}
		value = value.Elem()
	}

	switch value.Kind() {
	case reflect.Bool:
		encoder.output = strconv.AppendBool(encoder.output, value.Bool())
	case reflect.String:
		return encoder.writeString(value.String(), path)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		encoder.output = strconv.AppendInt(encoder.output, value.Int(), 10)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		encoder.output = strconv.AppendUint(encoder.output, value.Uint(), 10)
	case reflect.Float32, reflect.Float64:
		number, err := formatNumber(value.Float())
		if err != nil {
			return fmt.Errorf("canonical JSON number at %s: %w", path, err)
		}
		encoder.output = append(encoder.output, number...)
	case reflect.Slice, reflect.Array:
		if value.Kind() == reflect.Slice {
			leave, err := encoder.enter(value, path)
			if err != nil {
				return err
			}
			defer leave()
		}
		encoder.output = append(encoder.output, '[')
		for index := 0; index < value.Len(); index++ {
			if index > 0 {
				encoder.output = append(encoder.output, ',')
			}
			if err := encoder.write(value.Index(index), path+"["+strconv.Itoa(index)+"]", depth+1); err != nil {
				return err
			}
		}
		encoder.output = append(encoder.output, ']')
	case reflect.Map:
		if value.Type().Key().Kind() != reflect.String {
			return fmt.Errorf("unsupported canonical JSON map key %s at %s", value.Type().Key(), path)
		}
		leave, err := encoder.enter(value, path)
		if err != nil {
			return err
		}
		defer leave()
		keys := value.MapKeys()
		sort.Slice(keys, func(left, right int) bool {
			return utf16Less(keys[left].String(), keys[right].String())
		})
		encoder.output = append(encoder.output, '{')
		for index, key := range keys {
			name := key.String()
			if index > 0 {
				encoder.output = append(encoder.output, ',')
			}
			if err := encoder.writeString(name, path+"/"+name); err != nil {
				return err
			}
			encoder.output = append(encoder.output, ':')
			if err := encoder.write(value.MapIndex(key), path+"/"+name, depth+1); err != nil {
				return err
			}
		}
		encoder.output = append(encoder.output, '}')
	case reflect.Struct:
		type field struct {
			name  string
			value reflect.Value
		}
		fields := make([]field, 0, value.NumField())
		typeInfo := value.Type()
		for index := 0; index < value.NumField(); index++ {
			descriptor := typeInfo.Field(index)
			if !descriptor.IsExported() {
				continue
			}
			name := strings.Split(descriptor.Tag.Get("json"), ",")[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = descriptor.Name
			}
			fields = append(fields, field{name: name, value: value.Field(index)})
		}
		sort.Slice(fields, func(left, right int) bool {
			return utf16Less(fields[left].name, fields[right].name)
		})
		encoder.output = append(encoder.output, '{')
		for index, current := range fields {
			if index > 0 {
				encoder.output = append(encoder.output, ',')
			}
			if err := encoder.writeString(current.name, path+"/"+current.name); err != nil {
				return err
			}
			encoder.output = append(encoder.output, ':')
			if err := encoder.write(current.value, path+"/"+current.name, depth+1); err != nil {
				return err
			}
		}
		encoder.output = append(encoder.output, '}')
	default:
		return fmt.Errorf("unsupported canonical JSON value %s at %s", value.Kind(), path)
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
	limit := min(len(leftUnits), len(rightUnits))
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
