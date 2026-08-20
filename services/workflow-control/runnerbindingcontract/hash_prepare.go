package runnerbindingcontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

type Prepared struct {
	Schema             string `json:"schema"`
	Body               string `json:"body"`
	BodyHash           string `json:"bodyHash"`
	IdempotencyKey     string `json:"idempotencyKey"`
	RequestFingerprint string `json:"requestFingerprint"`
	Value              Record `json:"value"`
}

func HashStage(value any) (string, error) {
	validated, err := ValidateStage(value)
	if err != nil {
		return "", err
	}
	return domainHash("stage", validated)
}

func HashResolution(value any) (string, error) {
	validated, err := ValidateResolution(value)
	if err != nil {
		return "", err
	}
	return domainHash("resolution", validated)
}

func HashReceipt(value any) (string, error) {
	validated, err := ValidateReceipt(value)
	if err != nil {
		return "", err
	}
	return domainHash("receipt", validated)
}

// HashEvidence validates and hashes exact operation-specific authority
// evidence in the same domain as the TypeScript source contract.
func HashEvidence(value any, operation Operation) (string, error) {
	validated, err := validateEvidence(value, operation, "$")
	if err != nil {
		return "", err
	}
	return hashValidatedEvidence(validated)
}

func hashValidatedEvidence(value Record) (string, error) {
	canonical, err := canonicalJSON(value)
	if err != nil {
		return "", failure(ErrorInvalid, "$", err.Error())
	}
	digest := sha256.Sum256(append([]byte("openslack.workflow-runner-authority-binding.evidence.v1\x00"), canonical...))
	return hex.EncodeToString(digest[:]), nil
}

// MissingProviderUsageHash binds a budget settlement without provider usage
// to the prepared request hash without inventing provider evidence.
func MissingProviderUsageHash(preparedRequestHash any) (string, error) {
	validated, err := hashValue(preparedRequestHash, "$/preparedRequestHash")
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte("openslack.workflow-runner-authority-binding.missing-provider-usage.v1\x00" + validated))
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func domainHash(domain string, value Record) (string, error) {
	canonical, err := canonicalJSON(value)
	if err != nil {
		return "", failure(ErrorInvalid, "$", err.Error())
	}
	digest := sha256.Sum256(append([]byte("openslack.workflow-runner-authority-binding."+domain+".v1\x00"), canonical...))
	return hex.EncodeToString(digest[:]), nil
}

func PrepareStage(value any) (Prepared, error) {
	validated, err := ValidateStage(value)
	if err != nil {
		return Prepared{}, err
	}
	return prepareValue("stage", validated)
}

func PrepareResolution(value any) (Prepared, error) {
	validated, err := ValidateResolution(value)
	if err != nil {
		return Prepared{}, err
	}
	return prepareValue("resolution", validated)
}

func PrepareReceipt(value any) (Prepared, error) {
	validated, err := ValidateReceipt(value)
	if err != nil {
		return Prepared{}, err
	}
	return prepareValue("receipt", validated)
}

func PrepareError(value any) (Prepared, error) {
	validated, err := ValidateErrorRecord(value)
	if err != nil {
		return Prepared{}, err
	}
	return prepareValue("error", validated)
}

func prepareValue(domain string, value Record) (Prepared, error) {
	body, err := canonicalLF(value)
	if err != nil {
		return Prepared{}, failure(ErrorInvalid, "$", err.Error())
	}
	bodyHash, err := domainHash(domain, value)
	if err != nil {
		return Prepared{}, err
	}
	fingerprintDigest := sha256.Sum256([]byte("openslack.workflow-runner-authority-binding.fingerprint.v1\x00" + domain + "\x00" + bodyHash))
	return Prepared{
		Schema: PreparedSchema, Body: string(body), BodyHash: bodyHash,
		IdempotencyKey:     IdempotencyPrefix + bodyHash,
		RequestFingerprint: "sha256:" + hex.EncodeToString(fingerprintDigest[:]),
		Value:              value,
	}, nil
}

func ParseStageBytes(input []byte) (Record, error) {
	return parseCanonicalBytes(input, MaxFrameBytes, ValidateStage)
}

func ParseResolutionBytes(input []byte) (Record, error) {
	return parseCanonicalBytes(input, MaxFrameBytes, ValidateResolution)
}

func ParseReceiptBytes(input []byte) (Record, error) {
	return parseCanonicalBytes(input, MaxReceiptBytes, ValidateReceipt)
}

func ParseErrorBytes(input []byte) (Record, error) {
	return parseCanonicalBytes(input, MaxErrorBytes, ValidateErrorRecord)
}

func parseCanonicalBytes(
	input []byte,
	limit int,
	validate func(any) (Record, error),
) (Record, error) {
	if len(input) == 0 || len(input) > limit {
		return nil, failure(ErrorLimitExceeded, "$", "Binding frame size is invalid.")
	}
	if !hasExactlyOneLF(input) {
		return nil, failure(ErrorInvalid, "$", "Binding frame must be canonical JSON plus exactly one LF.")
	}
	parsed, err := parseStrictJSON(input[:len(input)-1], limit, MaxJSONDepth, MaxJSONNodes, MaxStringBytes, MaxSafeInteger)
	if err != nil {
		code := ErrorInvalid
		if strings.Contains(err.Error(), "exceeds") {
			code = ErrorLimitExceeded
		}
		return nil, failure(code, "$", err.Error())
	}
	validated, err := validate(parsed)
	if err != nil {
		return nil, err
	}
	canonical, err := canonicalLF(validated)
	if err != nil {
		return nil, failure(ErrorInvalid, "$", err.Error())
	}
	if !bytes.Equal(input, canonical) {
		return nil, failure(ErrorInvalid, "$", "Binding frame is not canonical exact bytes.")
	}
	return validated, nil
}
