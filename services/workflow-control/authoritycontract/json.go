package authoritycontract

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"unicode/utf8"
)

// parseStrictJSON is intentionally local to the v2 contract. It rejects the
// ambiguous inputs that encoding/json would otherwise accept, while keeping
// the frozen runnerprotocol v1 implementation untouched.
func parseStrictJSON(input []byte, maxDepth, maxNodes, maxStringBytes int) (any, error) {
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
	value, err := parseJSONValue(decoder, 1, maxDepth, maxNodes, &nodes, "$", maxStringBytes)
	if err != nil {
		return nil, err
	}
	if err := requireEOF(decoder); err != nil {
		return nil, err
	}
	return normalizeJSONNumbers(value, "$", 0, maxDepth, maxStringBytes)
}

func parseJSONValue(
	decoder *json.Decoder,
	depth, maxDepth, maxNodes int,
	nodes *int,
	path string,
	maxStringBytes int,
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
			result := map[string]any{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return nil, fmt.Errorf("invalid JSON object at %s: %w", path, keyErr)
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string at %s", path)
				}
				if len(key) > maxStringBytes {
					return nil, fmt.Errorf("object key exceeds its byte limit at %s/%s", path, key)
				}
				if _, duplicate := result[key]; duplicate {
					return nil, fmt.Errorf("duplicate JSON object key at %s/%s", path, key)
				}
				item, itemErr := parseJSONValue(
					decoder, depth+1, maxDepth, maxNodes, nodes, path+"/"+key, maxStringBytes,
				)
				if itemErr != nil {
					return nil, itemErr
				}
				result[key] = item
			}
			if closeToken, closeErr := decoder.Token(); closeErr != nil || closeToken != json.Delim('}') {
				return nil, fmt.Errorf("object is not closed at %s", path)
			}
			return result, nil
		case '[':
			result := []any{}
			for index := 0; decoder.More(); index++ {
				item, itemErr := parseJSONValue(
					decoder, depth+1, maxDepth, maxNodes, nodes,
					fmt.Sprintf("%s/%d", path, index), maxStringBytes,
				)
				if itemErr != nil {
					return nil, itemErr
				}
				result = append(result, item)
			}
			if closeToken, closeErr := decoder.Token(); closeErr != nil || closeToken != json.Delim(']') {
				return nil, fmt.Errorf("array is not closed at %s", path)
			}
			return result, nil
		default:
			return nil, fmt.Errorf("unexpected JSON delimiter at %s", path)
		}
	}
	return token, nil
}

func requireEOF(decoder *json.Decoder) error {
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fmt.Errorf("trailing JSON value")
		}
		return fmt.Errorf("trailing JSON: %w", err)
	}
	return nil
}

func normalizeJSONNumbers(value any, path string, depth, maxDepth, maxStringBytes int) (any, error) {
	if depth > maxDepth {
		return nil, fmt.Errorf("JSON depth exceeds its limit at %s", path)
	}
	switch current := value.(type) {
	case json.Number:
		text := current.String()
		integer, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("authority JSON number must be an int64 at %s", path)
		}
		return integer, nil
	case string:
		if len(current) > maxStringBytes {
			return nil, fmt.Errorf("string exceeds its byte limit at %s", path)
		}
		return current, nil
	case map[string]any:
		result := make(map[string]any, len(current))
		for _, key := range sortedObjectKeys(current) {
			normalized, err := normalizeJSONNumbers(current[key], path+"/"+key, depth+1, maxDepth, maxStringBytes)
			if err != nil {
				return nil, err
			}
			result[key] = normalized
		}
		return result, nil
	case []any:
		result := make([]any, len(current))
		for index, item := range current {
			normalized, err := normalizeJSONNumbers(item, fmt.Sprintf("%s/%d", path, index), depth+1, maxDepth, maxStringBytes)
			if err != nil {
				return nil, err
			}
			result[index] = normalized
		}
		return result, nil
	default:
		return value, nil
	}
}

// validateEscapedSurrogates runs before encoding/json can replace an invalid
// JSON UTF-16 escape with U+FFFD. It intentionally examines only escapes that
// occur inside strings and requires every high surrogate to be immediately
// followed by one low surrogate.
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

func sortedObjectKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
