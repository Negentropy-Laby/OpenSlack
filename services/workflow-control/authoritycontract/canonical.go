package authoritycontract

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

func CanonicalJSON(value any) ([]byte, error) {
	return canonicaljson.Encode(value)
}

func HashValue(value any) (string, error) {
	canonical, err := CanonicalJSON(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func requireCanonicalSize(value any, maximum int, path string) error {
	canonical, err := CanonicalJSON(value)
	if err != nil {
		return failure(ErrorInvalid, path, err.Error())
	}
	if len(canonical)+1 > maximum {
		return failure(ErrorLimitExceeded, path, "canonical value exceeds its byte limit")
	}
	return nil
}

func normalizeStrictJSONError(err error) error {
	var contractError *ContractError
	if errors.As(err, &contractError) {
		return err
	}
	code := ErrorInvalid
	if strings.Contains(err.Error(), "exceeds its limit") || strings.Contains(err.Error(), "exceeds its byte limit") {
		code = ErrorLimitExceeded
	}
	return failure(code, "$", err.Error())
}

func sha256Hex(input []byte) string {
	digest := sha256.Sum256(input)
	return hex.EncodeToString(digest[:])
}
