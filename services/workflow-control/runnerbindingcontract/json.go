package runnerbindingcontract

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"unicode/utf8"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

// Record is the closed contract's neutral JSON object representation. Public
// validators return a fresh Record so callers cannot mutate embedded vectors
// or retain decoder-owned data.
type Record map[string]any

func parseStrictJSON(
	input []byte,
	maxBytes, maxDepth, maxNodes, maxStringBytes int,
	maxSafeInteger int64,
) (any, error) {
	if len(input) == 0 {
		return nil, fmt.Errorf("JSON input is empty")
	}
	if len(input) > maxBytes {
		return nil, fmt.Errorf("JSON byte length exceeds its limit")
	}
	if len(input) >= 3 && bytes.Equal(input[:3], []byte{0xef, 0xbb, 0xbf}) {
		return nil, fmt.Errorf("UTF-8 BOM is forbidden")
	}
	if !utf8.Valid(input) {
		return nil, fmt.Errorf("JSON is not valid UTF-8")
	}
	if err := validateEscapedSurrogates(input); err != nil {
		return nil, err
	}

	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	nodes := 0
	value, err := parseJSONValue(
		decoder,
		0,
		maxDepth,
		maxNodes,
		&nodes,
		"$",
		maxStringBytes,
		maxSafeInteger,
	)
	if err != nil {
		return nil, err
	}
	if err := requireJSONEOF(decoder); err != nil {
		return nil, err
	}
	return value, nil
}

func parseJSONValue(
	decoder *json.Decoder,
	depth, maxDepth, maxNodes int,
	nodes *int,
	path string,
	maxStringBytes int,
	maxSafeInteger int64,
) (any, error) {
	if depth > maxDepth {
		return nil, fmt.Errorf("JSON depth exceeds its limit at %s", path)
	}
	*nodes++
	if *nodes > maxNodes {
		return nil, fmt.Errorf("JSON node count exceeds its limit at %s", path)
	}

	token, err := decoder.Token()
	if err != nil {
		return nil, fmt.Errorf("invalid JSON at %s: %w", path, err)
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			result := Record{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return nil, fmt.Errorf("invalid JSON object at %s: %w", path, keyErr)
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string at %s", path)
				}
				if len([]byte(key)) > maxStringBytes {
					return nil, fmt.Errorf("object key exceeds its byte limit at %s/%s", path, key)
				}
				if _, duplicate := result[key]; duplicate {
					return nil, fmt.Errorf("duplicate JSON object key at %s/%s", path, key)
				}
				item, itemErr := parseJSONValue(
					decoder,
					depth+1,
					maxDepth,
					maxNodes,
					nodes,
					path+"/"+key,
					maxStringBytes,
					maxSafeInteger,
				)
				if itemErr != nil {
					return nil, itemErr
				}
				result[key] = item
			}
			closing, closeErr := decoder.Token()
			if closeErr != nil || closing != json.Delim('}') {
				return nil, fmt.Errorf("object is not closed at %s", path)
			}
			return result, nil
		case '[':
			result := []any{}
			for index := 0; decoder.More(); index++ {
				item, itemErr := parseJSONValue(
					decoder,
					depth+1,
					maxDepth,
					maxNodes,
					nodes,
					fmt.Sprintf("%s/%d", path, index),
					maxStringBytes,
					maxSafeInteger,
				)
				if itemErr != nil {
					return nil, itemErr
				}
				result = append(result, item)
			}
			closing, closeErr := decoder.Token()
			if closeErr != nil || closing != json.Delim(']') {
				return nil, fmt.Errorf("array is not closed at %s", path)
			}
			return result, nil
		default:
			return nil, fmt.Errorf("unexpected JSON delimiter at %s", path)
		}
	}

	switch value := token.(type) {
	case json.Number:
		text := value.String()
		integer, parseErr := strconv.ParseInt(text, 10, 64)
		if parseErr != nil || text != strconv.FormatInt(integer, 10) ||
			integer < -maxSafeInteger || integer > maxSafeInteger {
			return nil, fmt.Errorf("JSON number must be a canonical safe integer at %s", path)
		}
		return integer, nil
	case string:
		if len([]byte(value)) > maxStringBytes {
			return nil, fmt.Errorf("string exceeds its byte limit at %s", path)
		}
		return value, nil
	case bool, nil:
		return value, nil
	default:
		return nil, fmt.Errorf("unsupported JSON value at %s", path)
	}
}

func requireJSONEOF(decoder *json.Decoder) error {
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fmt.Errorf("trailing JSON value")
		}
		return fmt.Errorf("trailing JSON: %w", err)
	}
	return nil
}

// validateEscapedSurrogates runs before encoding/json can replace an invalid
// UTF-16 escape with U+FFFD. A high surrogate must be followed immediately by
// one low surrogate, and a low surrogate cannot occur by itself.
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

func canonicalJSON(value any) ([]byte, error) {
	encoded, err := canonicaljson.Encode(value)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

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
