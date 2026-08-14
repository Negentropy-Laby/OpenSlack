package budgetcontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

func ParseBytes(contents []byte) (any, error) {
	return parseBytes(contents, MaxIdentifierBytes)
}

func parseBytes(contents []byte, maxStringBytes int) (any, error) {
	if len(contents) > MaxRecordBytes {
		return nil, failure(ErrorLimitExceeded, "$", "Budget authority bytes exceed the limit.")
	}
	if !utf8.Valid(contents) {
		return nil, failure(ErrorInvalid, "$", "Budget authority bytes are not valid UTF-8.")
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.UseNumber()
	nodes := 0
	value, err := parseValue(decoder, 1, &nodes, maxStringBytes)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return nil, failure(ErrorInvalid, "$", "Trailing JSON value is forbidden.")
		}
		return nil, failure(ErrorInvalid, "$", "Budget authority JSON framing is invalid.")
	}
	return value, nil
}

func parseValue(decoder *json.Decoder, depth int, nodes *int, maxStringBytes int) (any, error) {
	if depth > MaxJSONDepth {
		return nil, failure(ErrorLimitExceeded, "$", "Budget authority JSON depth exceeds the limit.")
	}
	*nodes++
	if *nodes > MaxJSONNodes {
		return nil, failure(ErrorLimitExceeded, "$", "Budget authority JSON nodes exceed the limit.")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, failure(ErrorInvalid, "$", "Budget authority JSON is invalid.")
	}
	switch token := token.(type) {
	case json.Delim:
		switch token {
		case '{':
			result := Record{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return nil, failure(ErrorInvalid, "$", "Budget authority object is invalid.")
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, failure(ErrorInvalid, "$", "Budget authority object key is invalid.")
				}
				if _, exists := result[key]; exists {
					return nil, failure(ErrorInvalid, "$", "Duplicate JSON object key is forbidden.")
				}
				value, valueErr := parseValue(decoder, depth+1, nodes, maxStringBytes)
				if valueErr != nil {
					return nil, valueErr
				}
				result[key] = value
			}
			if closing, closeErr := decoder.Token(); closeErr != nil || closing != json.Delim('}') {
				return nil, failure(ErrorInvalid, "$", "Budget authority object is truncated.")
			}
			return result, nil
		case '[':
			result := []any{}
			for decoder.More() {
				value, valueErr := parseValue(decoder, depth+1, nodes, maxStringBytes)
				if valueErr != nil {
					return nil, valueErr
				}
				result = append(result, value)
			}
			if closing, closeErr := decoder.Token(); closeErr != nil || closing != json.Delim(']') {
				return nil, failure(ErrorInvalid, "$", "Budget authority array is truncated.")
			}
			return result, nil
		default:
			return nil, failure(ErrorInvalid, "$", "Unexpected JSON delimiter.")
		}
	case string:
		if len([]byte(token)) > maxStringBytes {
			return nil, failure(ErrorLimitExceeded, "$", "Budget authority string exceeds the limit.")
		}
		return token, nil
	case json.Number:
		if !canonicalJSONNumber(token.String()) {
			return nil, failure(ErrorInvalid, "$", "Budget authority number is not a safe canonical integer.")
		}
		return token, nil
	case bool, nil:
		return token, nil
	default:
		return nil, failure(ErrorInvalid, "$", "Budget authority JSON value is invalid.")
	}
}

func canonicalJSONNumber(value string) bool {
	parsed, err := strconv.ParseInt(value, 10, 64)
	return err == nil && parsed >= -MaxSafeInteger && parsed <= MaxSafeInteger && value == strconv.FormatInt(parsed, 10)
}

func CanonicalJSON(value any) (string, error) {
	var buffer bytes.Buffer
	if err := appendCanonical(&buffer, value); err != nil {
		return "", err
	}
	return buffer.String(), nil
}

func appendCanonical(buffer *bytes.Buffer, value any) error {
	switch value := value.(type) {
	case nil:
		buffer.WriteString("null")
	case bool:
		buffer.WriteString(strconv.FormatBool(value))
	case string:
		encoded, _ := json.Marshal(value)
		buffer.Write(encoded)
	case json.Number:
		if !canonicalJSONNumber(value.String()) {
			return failure(ErrorInvalid, "$", "Budget authority number is not a safe canonical integer.")
		}
		buffer.WriteString(value.String())
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) || math.Abs(value) > float64(MaxSafeInteger) {
			return failure(ErrorInvalid, "$", "Budget authority number is not a safe canonical integer.")
		}
		buffer.WriteString(strconv.FormatFloat(value, 'f', -1, 64))
	case int:
		if int64(value) < -MaxSafeInteger || int64(value) > MaxSafeInteger {
			return failure(ErrorInvalid, "$", "Budget authority number is not a safe canonical integer.")
		}
		buffer.WriteString(strconv.Itoa(value))
	case int64:
		if value < -MaxSafeInteger || value > MaxSafeInteger {
			return failure(ErrorInvalid, "$", "Budget authority number is not a safe canonical integer.")
		}
		buffer.WriteString(strconv.FormatInt(value, 10))
	case Record:
		return appendCanonicalRecord(buffer, value)
	case map[string]any:
		return appendCanonicalRecord(buffer, Record(value))
	case []any:
		buffer.WriteByte('[')
		for index, entry := range value {
			if index != 0 {
				buffer.WriteByte(',')
			}
			if err := appendCanonical(buffer, entry); err != nil {
				return err
			}
		}
		buffer.WriteByte(']')
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return failure(ErrorInvalid, "$", "Budget authority value is not JSON data.")
		}
		decoded, err := parseBytes(encoded, MaxRecordBytes)
		if err != nil {
			return err
		}
		return appendCanonical(buffer, decoded)
	}
	return nil
}

func appendCanonicalRecord(buffer *bytes.Buffer, value Record) error {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	buffer.WriteByte('{')
	for index, key := range keys {
		if index != 0 {
			buffer.WriteByte(',')
		}
		encoded, _ := json.Marshal(key)
		buffer.Write(encoded)
		buffer.WriteByte(':')
		if err := appendCanonical(buffer, value[key]); err != nil {
			return err
		}
	}
	buffer.WriteByte('}')
	return nil
}

func hashValue(domain string, value any) (string, error) {
	if domain == "" || len(domain) > 64 {
		return "", failure(ErrorInvalid, "$/domain", "Hash domain is invalid.")
	}
	for index, character := range domain {
		if (index == 0 && (character < 'a' || character > 'z')) ||
			(index > 0 && !((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '-')) {
			return "", failure(ErrorInvalid, "$/domain", "Hash domain is invalid.")
		}
	}
	canonical, err := CanonicalJSON(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte("openslack.workflow-budget-authority." + domain + ".v1\x00" + canonical))
	return hex.EncodeToString(digest[:]), nil
}

func HashValue(domain string, value any) (string, error) { return hashValue(domain, value) }

func exactEqual(left, right any) bool {
	leftJSON, leftErr := CanonicalJSON(left)
	rightJSON, rightErr := CanonicalJSON(right)
	return leftErr == nil && rightErr == nil && leftJSON == rightJSON
}

func prefixedSHA(value string) bool {
	return strings.HasPrefix(value, "sha256:") && len(value) == 71 && isLowerHex(value[7:])
}

func isLowerHex(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}

func mustCanonical(value any) string {
	result, err := CanonicalJSON(value)
	if err != nil {
		panic(fmt.Sprintf("validated value is not canonical: %v", err))
	}
	return result
}
