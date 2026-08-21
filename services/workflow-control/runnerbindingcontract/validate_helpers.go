package runnerbindingcontract

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

var (
	hashPattern        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	fingerprintPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	safeIDPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	safeRefPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$`)
	decimalPattern     = regexp.MustCompile(`^(?:0|[1-9][0-9]*)$`)
	bindingRatePattern = regexp.MustCompile(`^(?:0|[1-9][0-9]*|(?:0|[1-9][0-9]*)\.([0-9]*[1-9]))$`)
	timestampPattern   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	forbiddenKeys      = map[string]struct{}{
		"provider": {}, "prompt": {}, "rawPrompt": {}, "model": {}, "response": {}, "rawResponse": {},
		"result": {}, "nonce": {}, "detail": {}, "credential": {}, "credentials": {}, "bearer": {},
		"bearerToken": {}, "endpoint": {}, "baseUrl": {}, "attestationNonce": {}, "providerId": {}, "modelId": {},
	}
)

func closedRecord(value any, fields []string, path string) (Record, error) {
	var record Record
	switch current := value.(type) {
	case Record:
		record = current
	case map[string]any:
		record = Record(current)
	default:
		return nil, failure(ErrorInvalid, path, path+" must be an inert object.")
	}
	if record == nil {
		return nil, failure(ErrorInvalid, path, path+" must be an inert object.")
	}
	allowed := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		allowed[field] = struct{}{}
	}
	for _, field := range fields {
		if _, ok := record[field]; !ok {
			return nil, failure(ErrorUnknownField, path+"/"+field, "A required field is missing.")
		}
	}
	keys := make([]string, 0, len(record))
	for key := range record {
		keys = append(keys, key)
	}
	canonicaljson.SortStringsUTF16(keys)
	for _, key := range keys {
		if _, ok := allowed[key]; !ok {
			return nil, failure(ErrorUnknownField, path+"/"+key, path+" contains an unknown field.")
		}
	}
	return record, nil
}

func textValue(value any, path string, pattern *regexp.Regexp, maxBytes int) (string, error) {
	text, ok := value.(string)
	if !ok || !utf8.ValidString(text) || len([]byte(text)) > maxBytes || !pattern.MatchString(text) {
		return "", failure(ErrorInvalid, path, path+" is invalid.")
	}
	return text, nil
}

func identifier(value any, path string) (string, error) {
	return textValue(value, path, safeIDPattern, 256)
}

func reference(value any, path string) (string, error) {
	return textValue(value, path, safeRefPattern, 512)
}

func hashValue(value any, path string) (string, error) {
	return textValue(value, path, hashPattern, 64)
}

func rateValue(value any, path string) (string, error) {
	rate, err := textValue(value, path, bindingRatePattern, MaxRateDecimalBytes)
	if err != nil {
		return "", err
	}
	fraction := ""
	if separator := strings.IndexByte(rate, '.'); separator >= 0 {
		fraction = rate[separator+1:]
	}
	if len(fraction) > MaxRateFractionDigits {
		return "", failure(ErrorLimitExceeded, path, path+" has too many fractional digits.")
	}
	return rate, nil
}

func timestampValue(value any, path string) (string, error) {
	text, err := textValue(value, path, timestampPattern, 24)
	if err != nil {
		return "", err
	}
	parsed, parseErr := time.Parse("2006-01-02T15:04:05.000Z", text)
	if parseErr != nil || parsed.UTC().Format("2006-01-02T15:04:05.000Z") != text {
		return "", failure(ErrorInvalid, path, path+" is not canonical UTC.")
	}
	return text, nil
}

func integerValue(value any, path string, minimum int64) (int64, error) {
	var result int64
	switch current := value.(type) {
	case int:
		result = int64(current)
	case int8:
		result = int64(current)
	case int16:
		result = int64(current)
	case int32:
		result = int64(current)
	case int64:
		result = current
	case uint:
		if uint64(current) > uint64(MaxSafeInteger) {
			return 0, failure(ErrorInvalid, path, path+" is not a bounded safe integer.")
		}
		result = int64(current)
	case uint8:
		result = int64(current)
	case uint16:
		result = int64(current)
	case uint32:
		result = int64(current)
	case uint64:
		if current > uint64(MaxSafeInteger) {
			return 0, failure(ErrorInvalid, path, path+" is not a bounded safe integer.")
		}
		result = int64(current)
	case float64:
		if math.IsNaN(current) || math.IsInf(current, 0) || current != math.Trunc(current) || math.Abs(current) > float64(MaxSafeInteger) {
			return 0, failure(ErrorInvalid, path, path+" is not a bounded safe integer.")
		}
		result = int64(current)
	case json.Number:
		parsed, err := strconv.ParseInt(current.String(), 10, 64)
		if err != nil || current.String() != strconv.FormatInt(parsed, 10) {
			return 0, failure(ErrorInvalid, path, path+" is not a bounded safe integer.")
		}
		result = parsed
	default:
		return 0, failure(ErrorInvalid, path, path+" is not a bounded safe integer.")
	}
	if result < minimum || result > MaxSafeInteger {
		return 0, failure(ErrorInvalid, path, path+" is not a bounded safe integer.")
	}
	return result, nil
}

func literalString(value any, expected, path string) (string, error) {
	text, ok := value.(string)
	if !ok || text != expected {
		return "", failure(ErrorInvalid, path, path+" is invalid.")
	}
	return text, nil
}

func literalInteger(value any, expected int64, path string) (int64, error) {
	integer, err := integerValue(value, path, 0)
	if err != nil || integer != expected {
		return 0, failure(ErrorInvalid, path, path+" is invalid.")
	}
	return integer, nil
}

func enumString(value any, options []string, path string) (string, error) {
	text, ok := value.(string)
	if ok {
		for _, candidate := range options {
			if text == candidate {
				return text, nil
			}
		}
	}
	return "", failure(ErrorInvalid, path, path+" is invalid.")
}

func operationValue(value any, path string) (Operation, error) {
	text, ok := value.(string)
	if ok {
		for _, operation := range Operations() {
			if text == string(operation) {
				return operation, nil
			}
		}
	}
	return "", failure(ErrorInvalid, path, path+" is invalid.")
}

func rejectForbiddenKeys(value any, path string) error {
	switch current := value.(type) {
	case Record:
		keys := make([]string, 0, len(current))
		for key := range current {
			keys = append(keys, key)
		}
		canonicaljson.SortStringsUTF16(keys)
		for _, key := range keys {
			entry := current[key]
			if _, forbidden := forbiddenKeys[key]; forbidden {
				return failure(ErrorForbiddenField, path+"/"+key, "Raw provider, prompt, result, nonce, endpoint, token, or credential fields are forbidden.")
			}
			if err := rejectForbiddenKeys(entry, path+"/"+key); err != nil {
				return err
			}
		}
	case map[string]any:
		return rejectForbiddenKeys(Record(current), path)
	case []any:
		for index, entry := range current {
			if err := rejectForbiddenKeys(entry, path+"/"+strconv.Itoa(index)); err != nil {
				return err
			}
		}
	}
	return nil
}
