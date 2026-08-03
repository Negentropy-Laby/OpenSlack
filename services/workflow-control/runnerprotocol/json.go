package runnerprotocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"unicode/utf8"
)

func parseStrictJSON(input []byte, maxDepth, maxNodes int) (any, error) {
	if len(input) >= 3 && bytes.Equal(input[:3], []byte{0xef, 0xbb, 0xbf}) {
		return nil, failure(ErrorInvalidMessage, "$", "UTF-8 BOM is forbidden")
	}
	if !utf8.Valid(input) {
		return nil, failure(ErrorInvalidMessage, "$", "JSON is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	nodes := 0
	value, err := parseJSONValue(decoder, 1, maxDepth, maxNodes, &nodes, "$")
	if err != nil {
		return nil, err
	}
	if err := requireEOF(decoder); err != nil {
		return nil, failure(ErrorInvalidMessage, "$", err.Error())
	}
	return normalizeJSONNumbers(value, "$", 0)
}

func parseJSONValue(decoder *json.Decoder, depth, maxDepth, maxNodes int, nodes *int, path string) (any, error) {
	if depth > maxDepth {
		return nil, failure(ErrorLimitExceeded, path, "JSON depth exceeds its limit")
	}
	*nodes++
	if *nodes > maxNodes {
		return nil, failure(ErrorLimitExceeded, path, "JSON node count exceeds its limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, failure(ErrorInvalidMessage, path, err.Error())
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			result := map[string]any{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return nil, failure(ErrorInvalidMessage, path, keyErr.Error())
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, failure(ErrorInvalidMessage, path, "object key is not a string")
				}
				if _, duplicate := result[key]; duplicate {
					return nil, failure(ErrorInvalidMessage, path+"/"+key, "duplicate JSON object key")
				}
				item, itemErr := parseJSONValue(decoder, depth+1, maxDepth, maxNodes, nodes, path+"/"+key)
				if itemErr != nil {
					return nil, itemErr
				}
				result[key] = item
			}
			if closeToken, closeErr := decoder.Token(); closeErr != nil || closeToken != json.Delim('}') {
				return nil, failure(ErrorInvalidMessage, path, "object is not closed")
			}
			return result, nil
		case '[':
			result := []any{}
			for index := 0; decoder.More(); index++ {
				item, itemErr := parseJSONValue(decoder, depth+1, maxDepth, maxNodes, nodes, fmt.Sprintf("%s/%d", path, index))
				if itemErr != nil {
					return nil, itemErr
				}
				result = append(result, item)
			}
			if closeToken, closeErr := decoder.Token(); closeErr != nil || closeToken != json.Delim(']') {
				return nil, failure(ErrorInvalidMessage, path, "array is not closed")
			}
			return result, nil
		default:
			return nil, failure(ErrorInvalidMessage, path, "unexpected JSON delimiter")
		}
	}
	return token, nil
}

func requireEOF(decoder *json.Decoder) error {
	if err := decoder.Decode(&struct{}{}); !errorsIsEOF(err) {
		if err == nil {
			return fmt.Errorf("trailing JSON value")
		}
		return err
	}
	return nil
}

func errorsIsEOF(err error) bool { return err == io.EOF }

func normalizeJSONNumbers(value any, path string, depth int) (any, error) {
	if depth > MaxJSONDepth {
		return nil, failure(ErrorLimitExceeded, path, "JSON depth exceeds its limit")
	}
	switch current := value.(type) {
	case json.Number:
		text := current.String()
		if integer, err := strconv.ParseInt(text, 10, 64); err == nil {
			if integer < -MaxSafeInteger || integer > MaxSafeInteger {
				return nil, failure(ErrorLimitExceeded, path, "integer exceeds the ECMAScript safe range")
			}
			return integer, nil
		}
		number, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
			return nil, failure(ErrorInvalidMessage, path, "JSON number is invalid")
		}
		if math.Trunc(number) == number && number >= -float64(MaxSafeInteger) && number <= float64(MaxSafeInteger) {
			return int64(number), nil
		}
		return number, nil
	case string:
		if len(current) > MaxStringBytes {
			return nil, failure(ErrorLimitExceeded, path, "string exceeds its byte limit")
		}
		return current, nil
	case map[string]any:
		result := make(map[string]any, len(current))
		for _, key := range sortedObjectKeys(current) {
			item := current[key]
			normalized, err := normalizeJSONNumbers(item, path+"/"+key, depth+1)
			if err != nil {
				return nil, err
			}
			result[key] = normalized
		}
		return result, nil
	case []any:
		result := make([]any, len(current))
		for index, item := range current {
			normalized, err := normalizeJSONNumbers(item, fmt.Sprintf("%s/%d", path, index), depth+1)
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

func sortedObjectKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
