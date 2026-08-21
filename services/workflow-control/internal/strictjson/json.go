// Package strictjson provides the shared, bounded JSON decoder used by
// Workflow Control contracts. Callers retain their own frozen error surfaces.
package strictjson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"unicode/utf8"
)

type ErrorKind string

const (
	ErrorInvalid ErrorKind = "invalid"
	ErrorLimit   ErrorKind = "limit_exceeded"
)

type Error struct {
	Kind    ErrorKind
	Path    string
	Message string
	Cause   error
}

func (failure *Error) Error() string {
	if failure.Cause != nil {
		return failure.Message + ": " + failure.Cause.Error()
	}
	return failure.Message
}

func (failure *Error) Unwrap() error { return failure.Cause }

type NumberPolicy int

const (
	NumberInt64 NumberPolicy = iota
	NumberCanonicalSafeInteger
)

type Limits struct {
	MaxBytes       int
	MaxDepth       int
	MaxNodes       int
	MaxStringBytes int
	MaxSafeInteger int64
	NumberPolicy   NumberPolicy
}

func Parse(input []byte, limits Limits) (any, error) {
	if len(input) == 0 {
		return nil, fail(ErrorInvalid, "$", "JSON input is empty", nil)
	}
	if limits.MaxBytes > 0 && len(input) > limits.MaxBytes {
		return nil, fail(ErrorLimit, "$", "JSON byte length exceeds its limit", nil)
	}
	if len(input) >= 3 && bytes.Equal(input[:3], []byte{0xef, 0xbb, 0xbf}) {
		return nil, fail(ErrorInvalid, "$", "UTF-8 BOM is forbidden", nil)
	}
	if !utf8.Valid(input) {
		return nil, fail(ErrorInvalid, "$", "JSON is not valid UTF-8", nil)
	}
	if err := validateEscapedSurrogates(input); err != nil {
		return nil, fail(ErrorInvalid, "$", err.Error(), nil)
	}

	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	nodes := 0
	value, err := parseValue(decoder, 1, limits, &nodes, "$")
	if err != nil {
		return nil, err
	}
	if err := requireEOF(decoder); err != nil {
		return nil, err
	}
	return value, nil
}

func parseValue(decoder *json.Decoder, depth int, limits Limits, nodes *int, path string) (any, error) {
	if depth > limits.MaxDepth {
		return nil, fail(ErrorLimit, path, "JSON depth exceeds its limit", nil)
	}
	*nodes++
	if *nodes > limits.MaxNodes {
		return nil, fail(ErrorLimit, path, "JSON node count exceeds its limit", nil)
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, fail(ErrorInvalid, path, "invalid JSON", err)
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			result := map[string]any{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return nil, fail(ErrorInvalid, path, "invalid JSON object", keyErr)
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fail(ErrorInvalid, path, "object key is not a string", nil)
				}
				keyPath := path + "/" + key
				if len([]byte(key)) > limits.MaxStringBytes {
					return nil, fail(ErrorLimit, keyPath, "object key exceeds its byte limit", nil)
				}
				if _, duplicate := result[key]; duplicate {
					return nil, fail(ErrorInvalid, keyPath, "duplicate JSON object key", nil)
				}
				item, itemErr := parseValue(decoder, depth+1, limits, nodes, keyPath)
				if itemErr != nil {
					return nil, itemErr
				}
				result[key] = item
			}
			closing, closeErr := decoder.Token()
			if closeErr != nil || closing != json.Delim('}') {
				return nil, fail(ErrorInvalid, path, "object is not closed", closeErr)
			}
			return result, nil
		case '[':
			result := []any{}
			for index := 0; decoder.More(); index++ {
				item, itemErr := parseValue(decoder, depth+1, limits, nodes, fmt.Sprintf("%s/%d", path, index))
				if itemErr != nil {
					return nil, itemErr
				}
				result = append(result, item)
			}
			closing, closeErr := decoder.Token()
			if closeErr != nil || closing != json.Delim(']') {
				return nil, fail(ErrorInvalid, path, "array is not closed", closeErr)
			}
			return result, nil
		default:
			return nil, fail(ErrorInvalid, path, "unexpected JSON delimiter", nil)
		}
	}

	switch value := token.(type) {
	case json.Number:
		text := value.String()
		integer, parseErr := strconv.ParseInt(text, 10, 64)
		if parseErr != nil {
			return nil, fail(ErrorInvalid, path, "JSON number must be an int64", parseErr)
		}
		if limits.NumberPolicy == NumberCanonicalSafeInteger &&
			(text != strconv.FormatInt(integer, 10) || integer < -limits.MaxSafeInteger || integer > limits.MaxSafeInteger) {
			return nil, fail(ErrorInvalid, path, "JSON number must be a canonical safe integer", nil)
		}
		return integer, nil
	case string:
		if len([]byte(value)) > limits.MaxStringBytes {
			return nil, fail(ErrorLimit, path, "string exceeds its byte limit", nil)
		}
		return value, nil
	case bool, nil:
		return value, nil
	default:
		return nil, fail(ErrorInvalid, path, "unsupported JSON value", nil)
	}
}

func requireEOF(decoder *json.Decoder) error {
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fail(ErrorInvalid, "$", "trailing JSON value", nil)
		}
		return fail(ErrorInvalid, "$", "trailing JSON", err)
	}
	return nil
}

func validateEscapedSurrogates(input []byte) error {
	inString := false
	for index := 0; index < len(input); index++ {
		switch input[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(input) {
				continue
			}
			if input[index+1] != 'u' {
				index++
				continue
			}
			unit, ok := decodeHexUnit(input, index+2)
			if !ok {
				continue
			}
			index += 5
			if unit >= 0xd800 && unit <= 0xdbff {
				if index+6 >= len(input) || input[index+1] != '\\' || input[index+2] != 'u' {
					return fmt.Errorf("JSON string contains an unpaired Unicode surrogate")
				}
				low, valid := decodeHexUnit(input, index+3)
				if !valid || low < 0xdc00 || low > 0xdfff {
					return fmt.Errorf("JSON string contains an unpaired Unicode surrogate")
				}
				index += 6
			} else if unit >= 0xdc00 && unit <= 0xdfff {
				return fmt.Errorf("JSON string contains an unpaired Unicode surrogate")
			}
		}
	}
	return nil
}

func decodeHexUnit(input []byte, start int) (uint16, bool) {
	if start+4 > len(input) {
		return 0, false
	}
	var value uint16
	for _, digit := range input[start : start+4] {
		value <<= 4
		switch {
		case digit >= '0' && digit <= '9':
			value |= uint16(digit - '0')
		case digit >= 'a' && digit <= 'f':
			value |= uint16(digit-'a') + 10
		case digit >= 'A' && digit <= 'F':
			value |= uint16(digit-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

func fail(kind ErrorKind, path, message string, cause error) error {
	return &Error{Kind: kind, Path: path, Message: message, Cause: cause}
}
