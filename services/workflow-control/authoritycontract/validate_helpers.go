package authoritycontract

import (
	"regexp"
	"time"
)

var (
	hashPattern        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	referencePattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$`)
	timestampPattern   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	idempotencyPattern = regexp.MustCompile(`^openslack\.workflow-control-authority\.v2\.[0-9a-f]{64}$`)
	fingerprintPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	semverPattern      = regexp.MustCompile(`^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
)

func closedRecord(value any, fields []string, path string) (map[string]any, error) {
	record, ok := value.(map[string]any)
	if !ok || record == nil {
		return nil, failure(ErrorInvalid, path, "value must be an object")
	}
	allowed := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		allowed[field] = struct{}{}
		if _, exists := record[field]; !exists {
			return nil, failure(ErrorInvalid, path+"/"+field, "required field is missing")
		}
	}
	for _, field := range sortedObjectKeys(record) {
		if _, exists := allowed[field]; !exists {
			return nil, failure(ErrorUnknownField, path+"/"+field, "unknown field")
		}
	}
	return record, nil
}

func requireString(value any, path string, maximum int, pattern *regexp.Regexp) (string, error) {
	text, ok := value.(string)
	if !ok || len(text) > maximum || (pattern != nil && !pattern.MatchString(text)) {
		return "", failure(ErrorInvalid, path, "string is invalid")
	}
	return text, nil
}

func requireIdentifier(value any, path string) (string, error) {
	return requireString(value, path, MaxIdentifierBytes, identifierPattern)
}

func requireReference(value any, path string) (string, error) {
	return requireString(value, path, 512, referencePattern)
}

func requireHash(value any, path string) (string, error) {
	return requireString(value, path, 64, hashPattern)
}

func requireTimestamp(value any, path string) (string, error) {
	text, err := requireString(value, path, 24, timestampPattern)
	if err != nil {
		return "", err
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", text)
	if err != nil || parsed.Format("2006-01-02T15:04:05.000Z") != text {
		return "", failure(ErrorInvalid, path, path+" is not a valid timestamp.")
	}
	return text, nil
}

func requireInteger(value any, path string, minimum int64) (int64, error) {
	integer, ok := value.(int64)
	if !ok || integer < minimum || integer > MaxSafeInteger {
		return 0, failure(ErrorInvalid, path, "value must be a bounded safe integer")
	}
	return integer, nil
}

func requireBoolean(value any, path string) (bool, error) {
	boolean, ok := value.(bool)
	if !ok {
		return false, failure(ErrorInvalid, path, "value must be boolean")
	}
	return boolean, nil
}

func requireEnum[T ~string](value any, path string, allowed []T) (T, error) {
	text, ok := value.(string)
	if ok {
		for _, candidate := range allowed {
			if text == string(candidate) {
				return candidate, nil
			}
		}
	}
	var zero T
	return zero, failure(ErrorInvalid, path, "value is outside the closed vocabulary")
}

func nullableString(value any, path string, validate func(any, string) (string, error)) (*string, error) {
	if value == nil {
		return nil, nil
	}
	result, err := validate(value, path)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func nullableInteger(value any, path string, minimum int64) (*int64, error) {
	if value == nil {
		return nil, nil
	}
	result, err := requireInteger(value, path, minimum)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func quantity(value any, path string) (Quantity, error) {
	return ValidateDecimal(value, path)
}

func lessOrEqual(left, right Quantity) bool {
	leftValue, _ := left.Int64()
	rightValue, _ := right.Int64()
	return leftValue <= rightValue
}
