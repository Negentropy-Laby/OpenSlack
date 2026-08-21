package runnerbindingcontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/strictjson"
)

type canonicalRecordEntry struct {
	value Record
	bytes []byte
}

type validatedBudgetPrepared struct {
	prepared budgetcontract.PreparedRequest
	request  budgetcontract.Record
}

type validatedBudgetDurable struct {
	record     Record
	projection budgetcontract.Record
	bytes      []byte
	hash       string
}

// bindingValidationSession keeps canonical bytes local to one validation
// operation. Retaining the Record in each entry prevents pointer reuse while
// the session is live; no process-global or unbounded cache is involved.
type bindingValidationSession struct {
	canonicalByRecord map[uintptr]canonicalRecordEntry
	budgetPrepared    map[string]validatedBudgetPrepared
	budgetDurable     map[string]validatedBudgetDurable
	onEncode          func(Record)
	onValidate        func(string)
}

func newBindingValidationSession(onEncode func(Record)) *bindingValidationSession {
	return &bindingValidationSession{
		canonicalByRecord: make(map[uintptr]canonicalRecordEntry),
		budgetPrepared:    make(map[string]validatedBudgetPrepared),
		budgetDurable:     make(map[string]validatedBudgetDurable),
		onEncode:          onEncode,
	}
}

func (session *bindingValidationSession) canonical(value any) ([]byte, error) {
	record, cacheable := value.(Record)
	if cacheable {
		identity := reflect.ValueOf(record).Pointer()
		if entry, ok := session.canonicalByRecord[identity]; ok {
			return entry.bytes, nil
		}
		encoded, err := canonicalJSON(record)
		if err != nil {
			return nil, err
		}
		session.canonicalByRecord[identity] = canonicalRecordEntry{value: record, bytes: encoded}
		if session.onEncode != nil {
			session.onEncode(record)
		}
		return encoded, nil
	}
	return canonicalJSON(value)
}

func (session *bindingValidationSession) byteBound(value any, limit int, path string, framed bool) error {
	encoded, err := session.canonical(value)
	if err != nil {
		return failure(ErrorInvalid, path, err.Error())
	}
	length := len(encoded)
	if framed {
		length++
	}
	if length > limit {
		return failure(ErrorLimitExceeded, path, path+" exceeds its byte limit.")
	}
	return nil
}

type Prepared struct {
	Schema             string `json:"schema"`
	Body               string `json:"body"`
	BodyHash           string `json:"bodyHash"`
	IdempotencyKey     string `json:"idempotencyKey"`
	RequestFingerprint string `json:"requestFingerprint"`
	Value              Record `json:"value"`
}

func HashStage(value any) (string, error) {
	session := newBindingValidationSession(nil)
	validated, err := validateStageWithSession(value, session)
	if err != nil {
		return "", err
	}
	return domainHashWithSession(session, "stage", validated)
}

func HashResolution(value any) (string, error) {
	session := newBindingValidationSession(nil)
	validated, err := validateResolutionWithSession(value, session)
	if err != nil {
		return "", err
	}
	return domainHashWithSession(session, "resolution", validated)
}

func HashReceipt(value any) (string, error) {
	session := newBindingValidationSession(nil)
	validated, err := validateReceiptWithSession(value, session)
	if err != nil {
		return "", err
	}
	return domainHashWithSession(session, "receipt", validated)
}

// HashEvidence validates and hashes exact operation-specific authority
// evidence in the same domain as the TypeScript source contract.
func HashEvidence(value any, operation Operation) (string, error) {
	session := newBindingValidationSession(nil)
	validated, err := validateEvidence(value, operation, "$", session)
	if err != nil {
		return "", err
	}
	if err := session.byteBound(validated, MaxEvidenceBytes, "$", false); err != nil {
		return "", err
	}
	return hashValidatedEvidenceWithSession(session, validated)
}

func hashValidatedEvidenceWithSession(session *bindingValidationSession, value Record) (string, error) {
	return domainHashWithSession(session, "evidence", value)
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

func domainHashWithSession(session *bindingValidationSession, domain string, value Record) (string, error) {
	_, hash, err := canonicalAndDomainHashWithSession(session, domain, value)
	return hash, err
}

func canonicalAndDomainHashWithSession(session *bindingValidationSession, domain string, value Record) ([]byte, string, error) {
	canonical, err := session.canonical(value)
	if err != nil {
		return nil, "", failure(ErrorInvalid, "$", err.Error())
	}
	digest := sha256.Sum256(append([]byte("openslack.workflow-runner-authority-binding."+domain+".v1\x00"), canonical...))
	return canonical, hex.EncodeToString(digest[:]), nil
}

func PrepareStage(value any) (Prepared, error) {
	session := newBindingValidationSession(nil)
	validated, err := validateStageWithSession(value, session)
	if err != nil {
		return Prepared{}, err
	}
	return prepareValueWithSession(session, "stage", validated)
}

func PrepareResolution(value any) (Prepared, error) {
	session := newBindingValidationSession(nil)
	validated, err := validateResolutionWithSession(value, session)
	if err != nil {
		return Prepared{}, err
	}
	return prepareValueWithSession(session, "resolution", validated)
}

func PrepareReceipt(value any) (Prepared, error) {
	session := newBindingValidationSession(nil)
	validated, err := validateReceiptWithSession(value, session)
	if err != nil {
		return Prepared{}, err
	}
	return prepareValueWithSession(session, "receipt", validated)
}

func PrepareError(value any) (Prepared, error) {
	session := newBindingValidationSession(nil)
	validated, err := validateErrorRecordWithSession(value, session)
	if err != nil {
		return Prepared{}, err
	}
	return prepareValueWithSession(session, "error", validated)
}

func prepareValueWithSession(session *bindingValidationSession, domain string, value Record) (Prepared, error) {
	canonical, bodyHash, err := canonicalAndDomainHashWithSession(session, domain, value)
	if err != nil {
		return Prepared{}, err
	}
	body := append(append([]byte(nil), canonical...), '\n')
	fingerprintDigest := sha256.Sum256([]byte("openslack.workflow-runner-authority-binding.fingerprint.v1\x00" + domain + "\x00" + bodyHash))
	return Prepared{
		Schema: PreparedSchema, Body: string(body), BodyHash: bodyHash,
		IdempotencyKey:     IdempotencyPrefix + bodyHash,
		RequestFingerprint: "sha256:" + hex.EncodeToString(fingerprintDigest[:]),
		Value:              value,
	}, nil
}

func ParseStageBytes(input []byte) (Record, error) {
	return parseCanonicalBytes(input, MaxFrameBytes, validateStageWithSession)
}

func ParseResolutionBytes(input []byte) (Record, error) {
	return parseCanonicalBytes(input, MaxFrameBytes, validateResolutionWithSession)
}

func ParseReceiptBytes(input []byte) (Record, error) {
	return parseCanonicalBytes(input, MaxReceiptBytes, validateReceiptWithSession)
}

func ParseErrorBytes(input []byte) (Record, error) {
	return parseCanonicalBytes(input, MaxErrorBytes, validateErrorRecordWithSession)
}

func parseCanonicalBytes(
	input []byte,
	limit int,
	validate func(any, *bindingValidationSession) (Record, error),
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
		var jsonError *strictjson.Error
		if errors.As(err, &jsonError) && jsonError.Kind == strictjson.ErrorLimit {
			code = ErrorLimitExceeded
		}
		return nil, failure(code, "$", err.Error())
	}
	session := newBindingValidationSession(nil)
	validated, err := validate(parsed, session)
	if err != nil {
		return nil, err
	}
	canonical, err := session.canonical(validated)
	if err != nil {
		return nil, failure(ErrorInvalid, "$", err.Error())
	}
	canonical = append(append([]byte(nil), canonical...), '\n')
	if !bytes.Equal(input, canonical) {
		return nil, failure(ErrorInvalid, "$", "Binding frame is not canonical exact bytes.")
	}
	return validated, nil
}
