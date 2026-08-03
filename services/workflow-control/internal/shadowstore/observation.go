package shadowstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"time"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
)

const idempotencyPrefix = "openslack.workflow-control-shadow.v1."

var (
	idempotencyPattern = regexp.MustCompile(`^openslack\.workflow-control-shadow\.v1\.[0-9a-f]{64}$`)
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
)

func ValidateIdempotencyKey(value string) error {
	if len(value) > MaxIdempotencyKeyBytes || !idempotencyPattern.MatchString(value) {
		return Failure(ErrorInputInvalid, "Idempotency-Key is not a bounded canonical value", nil)
	}
	return nil
}

func ExpectedIdempotencyKey(prepared PreparedObservation) string {
	return idempotencyPrefix + hex.EncodeToString(prepared.BodyDigest[:])
}

func ValidateObservationIdempotencyKey(prepared PreparedObservation, value string) error {
	if err := ValidateIdempotencyKey(value); err != nil {
		return err
	}
	if value != ExpectedIdempotencyKey(prepared) {
		return Failure(ErrorInputInvalid, "Idempotency-Key does not bind the exact canonical body", nil)
	}
	return nil
}

func ValidateProjectionIdentity(workspaceID, runID string) error {
	if !identifierPattern.MatchString(workspaceID) || !identifierPattern.MatchString(runID) {
		return Failure(ErrorInputInvalid, "projection identity is invalid", nil)
	}
	return nil
}

func PrepareObservation(input []byte) (PreparedObservation, error) {
	if len(input) == 0 || len(input) > MaxObservationBytes {
		return PreparedObservation{}, Failure(ErrorInputInvalid, "observation body exceeds its byte limit", nil)
	}
	envelope, err := workflowcontrol.ValidateCanonicalShadowEnvelopeBytes(input)
	if err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "validate canonical shadow envelope", err)
	}
	digest := sha256.Sum256(input)
	return PreparedObservation{
		Envelope:   envelope,
		ExactBody:  append([]byte(nil), input...),
		BodyDigest: digest,
	}, nil
}

func RequestFingerprint(prepared PreparedObservation) string {
	digest := sha256.New()
	_, _ = digest.Write([]byte("POST\n" + ObservationPath + "\n" + workflowcontrol.ShadowSourceBinding(prepared.Envelope.Source) + "\n"))
	_, _ = digest.Write(prepared.ExactBody)
	return "sha256:" + hex.EncodeToString(digest.Sum(nil))
}

func Evaluate(prepared PreparedObservation, previousExactBody []byte) Evaluation {
	readModel, projectionMatched, err := workflowcontrol.CompareShadowProjection(prepared.Envelope)
	result := Evaluation{Parity: ParityMatched, Status: prepared.Envelope.Observation.Status}
	if err != nil {
		return mismatch(result, "projection_invalid")
	}
	result.ObservationHash = readModel.ObservationHash
	result.ProjectionBytes, err = workflowcontrol.CanonicalReadModelBytes(readModel)
	if err != nil {
		return mismatch(result, "projection_invalid")
	}
	if !projectionMatched {
		return mismatch(result, "projection_mismatch")
	}
	if len(previousExactBody) == 0 {
		return result
	}
	previous, err := workflowcontrol.ValidateCanonicalShadowEnvelopeBytes(previousExactBody)
	if err != nil {
		return mismatch(result, "stored_observation_invalid")
	}
	prior := previous.Observation
	current := prepared.Envelope.Observation
	if prior.RunID != current.RunID || prior.WorkflowName != current.WorkflowName || prior.Mode != current.Mode ||
		prior.StartedAt != current.StartedAt || prior.ManifestHash != current.ManifestHash {
		return mismatch(result, "immutable_binding_drift")
	}
	if previous.Source.WorkspaceID != prepared.Envelope.Source.WorkspaceID || previous.Source.RunID != prepared.Envelope.Source.RunID {
		return mismatch(result, "source_binding_drift")
	}
	if current.Status != prior.Status {
		if err := workflowcontrol.ValidateTransition(prior.Status, current.Status); err != nil {
			return mismatch(result, "transition_invalid")
		}
	}
	priorTime, priorOK := parseTimestamp(prior.UpdatedAt)
	currentTime, currentOK := parseTimestamp(current.UpdatedAt)
	if !priorOK || !currentOK || currentTime.Before(priorTime) {
		return mismatch(result, "updated_at_regressed")
	}
	return result
}

func mismatch(value Evaluation, code string) Evaluation {
	value.Parity = ParityMismatched
	value.MismatchCode = code
	return value
}

func ParseFingerprint(value string) ([sha256.Size]byte, error) {
	var result [sha256.Size]byte
	if len(value) != len("sha256:")+sha256.Size*2 || value[:len("sha256:")] != "sha256:" {
		return result, Failure(ErrorInputInvalid, "request fingerprint is invalid", nil)
	}
	decoded, err := hex.DecodeString(value[len("sha256:"):])
	if err != nil || len(decoded) != sha256.Size {
		return result, Failure(ErrorInputInvalid, "request fingerprint is invalid", err)
	}
	copy(result[:], decoded)
	return result, nil
}

func DigestString(value [sha256.Size]byte) string { return hex.EncodeToString(value[:]) }

func SourceBinding(value workflowcontrol.ShadowSource) string {
	return Authority + "/" + value.WorkspaceID + "/" + value.RunID + "/" + strconv.FormatInt(value.SourceSequence, 10)
}

func ProjectionBytesEqual(left, right []byte) bool { return bytes.Equal(left, right) }

func parseTimestamp(value string) (time.Time, bool) {
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	return parsed, err == nil
}

func ValidateSourceSequence(expected, actual int64) error {
	if expected != actual {
		return Failure(ErrorSequenceConflict, fmt.Sprintf("expected source sequence %d", expected), nil)
	}
	return nil
}
