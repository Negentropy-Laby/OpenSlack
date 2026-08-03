package workflowcontrol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
)

const (
	ShadowObservationSchema = "openslack.workflow_control_shadow_observation.v1"
	ShadowReceiptSchema     = "openslack.workflow_control_shadow_receipt.v1"
	ShadowProjectionSchema  = "openslack.workflow_control_shadow_projection.v1"
	ShadowObservationPath   = "/v1/shadow/workflow-control/observations"
	MaxShadowEnvelopeBytes  = 512 * 1024
	MaxSourceSequence       = int64(1<<53 - 1)
)

// ShadowSource binds a TypeScript observation to one workspace-local run and
// a contiguous source sequence. It carries no actor, prompt, credential, or
// execution capability.
type ShadowSource struct {
	RunID          string `json:"runId"`
	SourceSequence int64  `json:"sourceSequence"`
	WorkspaceID    string `json:"workspaceId"`
}

// ShadowEnvelope carries both the TypeScript observation and its TypeScript
// projection. Go recomputes the projection so a semantic drift is recorded as
// a parity mismatch instead of being rejected as malformed input.
type ShadowEnvelope struct {
	Authority   string       `json:"authority"`
	Observation Observation  `json:"observation"`
	Projection  ReadModel    `json:"projection"`
	Schema      string       `json:"schema"`
	Source      ShadowSource `json:"source"`
}

func ValidateShadowEnvelopeJSON(input []byte) (ShadowEnvelope, error) {
	if len(input) == 0 || len(input) > MaxShadowEnvelopeBytes {
		return ShadowEnvelope{}, fail(ErrorLimitExceeded, "$", "shadow envelope exceeds its byte limit")
	}
	if err := validateEscapedSurrogates(input); err != nil {
		return ShadowEnvelope{}, err
	}
	value, err := parseStrictJSON(input, MaxJSONDepth+4, MaxJSONNodes*2)
	if err != nil {
		return ShadowEnvelope{}, err
	}
	if path, ok := sensitivePath(value, "$", 0); ok {
		return ShadowEnvelope{}, fail(ErrorSensitiveField, path, "raw sensitive field is forbidden")
	}
	root, err := requireClosedObject(value, "$", []string{
		"authority", "observation", "projection", "schema", "source",
	})
	if err != nil {
		return ShadowEnvelope{}, err
	}
	if err := requireNonNull(root, "$", []string{
		"authority", "observation", "projection", "schema", "source",
	}); err != nil {
		return ShadowEnvelope{}, err
	}
	source, err := requireClosedObject(root["source"], "$/source", []string{
		"runId", "sourceSequence", "workspaceId",
	})
	if err != nil {
		return ShadowEnvelope{}, err
	}
	if err := requireNonNull(source, "$/source", []string{
		"runId", "sourceSequence", "workspaceId",
	}); err != nil {
		return ShadowEnvelope{}, err
	}

	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	var envelope ShadowEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return ShadowEnvelope{}, fail(ErrorInvalid, "$", err.Error())
	}
	if err := requireEOF(decoder); err != nil {
		return ShadowEnvelope{}, fail(ErrorInvalid, "$", err.Error())
	}
	if err := ValidateShadowEnvelope(envelope); err != nil {
		return ShadowEnvelope{}, err
	}
	return envelope, nil
}

func ValidateCanonicalShadowEnvelopeBytes(input []byte) (ShadowEnvelope, error) {
	envelope, err := ValidateShadowEnvelopeJSON(input)
	if err != nil {
		return ShadowEnvelope{}, err
	}
	canonical, err := CanonicalShadowEnvelopeBytes(envelope)
	if err != nil {
		return ShadowEnvelope{}, err
	}
	if !bytes.Equal(input, canonical) {
		return ShadowEnvelope{}, fail(ErrorInvalid, "$", "shadow envelope bytes are not canonical")
	}
	return envelope, nil
}

func ValidateShadowEnvelope(value ShadowEnvelope) error {
	if value.Schema != ShadowObservationSchema {
		return fail(ErrorInvalid, "$/schema", "shadow observation schema is unsupported")
	}
	if value.Authority != Authority {
		return fail(ErrorInvalid, "$/authority", "TypeScript must remain the shadow source authority")
	}
	if !safeIDPattern.MatchString(value.Source.WorkspaceID) || len(value.Source.WorkspaceID) > MaxIdentifierBytes {
		return fail(ErrorInvalid, "$/source/workspaceId", "workspaceId is invalid")
	}
	if !safeIDPattern.MatchString(value.Source.RunID) || len(value.Source.RunID) > MaxIdentifierBytes {
		return fail(ErrorInvalid, "$/source/runId", "runId is invalid")
	}
	if value.Source.SourceSequence < 1 || value.Source.SourceSequence > MaxSourceSequence {
		return fail(ErrorInvalid, "$/source/sourceSequence", "sourceSequence is invalid")
	}
	if err := ValidateObservation(value.Observation); err != nil {
		return err
	}
	if value.Source.RunID != value.Observation.RunID {
		return fail(ErrorInvalid, "$/source/runId", "source runId does not bind the observation")
	}
	return validateShadowProjectionShape(value.Projection)
}

func CanonicalShadowEnvelopeBytes(value ShadowEnvelope) ([]byte, error) {
	if err := ValidateShadowEnvelope(value); err != nil {
		return nil, err
	}
	encoded, err := canonicalJSON(value)
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}

func HashShadowEnvelope(value ShadowEnvelope) (string, error) {
	canonical, err := CanonicalShadowEnvelopeBytes(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

// CompareShadowProjection returns the recomputed Go read model and whether its
// exact canonical bytes equal the TypeScript-supplied projection.
func CompareShadowProjection(value ShadowEnvelope) (ReadModel, bool, error) {
	if err := ValidateShadowEnvelope(value); err != nil {
		return ReadModel{}, false, err
	}
	expected, err := ProjectReadModel(value.Observation)
	if err != nil {
		return ReadModel{}, false, err
	}
	expectedBytes, err := CanonicalReadModelBytes(expected)
	if err != nil {
		return ReadModel{}, false, err
	}
	actualBytes, err := CanonicalReadModelBytes(value.Projection)
	if err != nil {
		return ReadModel{}, false, err
	}
	return expected, bytes.Equal(expectedBytes, actualBytes), nil
}

func validateShadowProjectionShape(value ReadModel) error {
	// The supplied TypeScript projection is evidence rather than authority. It
	// may differ semantically, but it must remain bounded, closed, and safely
	// canonicalizable so the mismatch can be durably recorded.
	if value.Schema == "" || value.Authority == "" || value.GoRole == "" || value.RunID == "" {
		return fail(ErrorInvalid, "$/projection", "shadow projection required fields are missing")
	}
	if len(value.QualificationGaps) > MaxCount {
		return fail(ErrorLimitExceeded, "$/projection/qualificationGaps", "qualification gap count exceeds its limit")
	}
	if _, err := canonicalJSON(value); err != nil {
		return err
	}
	return nil
}

// ShadowProjectionEqual is intentionally exact. It is useful in consumer
// tests without exposing the internal canonical encoder.
func ShadowProjectionEqual(left, right ReadModel) bool {
	return reflect.DeepEqual(left, right)
}

func ShadowSourceBinding(value ShadowSource) string {
	return fmt.Sprintf("%s/%s/%s/%d", Authority, value.WorkspaceID, value.RunID, value.SourceSequence)
}
