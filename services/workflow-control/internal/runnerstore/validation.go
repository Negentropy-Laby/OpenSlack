package runnerstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

var (
	safeIDPattern            = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	hashPattern              = regexp.MustCompile(`^[0-9a-f]{64}$`)
	timestampPattern         = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	idempotencyPattern       = regexp.MustCompile(`^openslack\.workflow-runner-job\.v1\.[0-9a-f]{64}$`)
	cancelIdempotencyPattern = regexp.MustCompile(`^openslack\.workflow-runner-cancel\.v1\.[0-9a-f]{64}$`)
	fingerprintPattern       = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

func ParseJobSpec(input []byte) (PreparedJobSpec, error) {
	if len(input) == 0 || len(input) > MaxJobSpecBytes || !utf8.Valid(input) {
		return PreparedJobSpec{}, Failure(ErrorLimitExceeded, "job specification bytes are invalid", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	var value JobSpec
	if err := decoder.Decode(&value); err != nil {
		return PreparedJobSpec{}, Failure(ErrorInputInvalid, "job specification is not closed JSON", err)
	}
	if err := requireEOF(decoder); err != nil {
		return PreparedJobSpec{}, Failure(ErrorInputInvalid, "job specification has trailing content", err)
	}
	return PrepareJobSpec(value)
}

func PrepareJobSpec(value JobSpec) (PreparedJobSpec, error) {
	if err := ValidateJobSpec(value); err != nil {
		return PreparedJobSpec{}, err
	}
	body, err := canonicaljson.Encode(value)
	if err != nil {
		return PreparedJobSpec{}, Failure(ErrorInputInvalid, "job specification cannot be canonicalized", err)
	}
	digest := sha256.Sum256(append([]byte(JobSpecHashDomain), body...))
	return PreparedJobSpec{Spec: value, ExactBody: body, JobSpecHash: hex.EncodeToString(digest[:])}, nil
}

func ValidateJobSpec(value JobSpec) error {
	if value.Schema != JobSpecSchema {
		return Failure(ErrorInputInvalid, "job specification schema is unsupported", nil)
	}
	for name, text := range map[string]string{
		"workspaceId": value.WorkspaceID, "jobId": value.JobID,
		"workflowRunId": value.WorkflowRunID, "correlationId": value.CorrelationID,
		"executionDescriptorRef": value.ExecutionDescriptorRef,
		"workflowId":             value.WorkflowID, "workflowVersion": value.WorkflowVersion,
	} {
		if len(text) > runnerprotocol.MaxIdentifierBytes || !safeIDPattern.MatchString(text) {
			return Failure(ErrorInputInvalid, fmt.Sprintf("%s is invalid", name), nil)
		}
	}
	for name, value := range map[string]string{
		"executionDescriptorHash": value.ExecutionDescriptorHash,
		"workflowSourceHash":      value.WorkflowSourceHash, "manifestHash": value.ManifestHash,
		"inputHash": value.InputHash,
	} {
		if !hashPattern.MatchString(value) {
			return Failure(ErrorHashMismatch, fmt.Sprintf("%s must be a full SHA-256", name), nil)
		}
	}
	if value.WholeTimeoutMS < MinWholeTimeout.Milliseconds() || value.WholeTimeoutMS > MaxWholeTimeout.Milliseconds() {
		return Failure(ErrorLimitExceeded, "wholeTimeoutMs is outside the closed range", nil)
	}
	if _, err := ParseTimestamp(value.SubmittedAt); err != nil {
		return err
	}
	return nil
}

func ValidateSubmitInput(input SubmitInput) error {
	prepared, err := PrepareJobSpec(input.Prepared.Spec)
	if err != nil {
		return err
	}
	if !bytes.Equal(prepared.ExactBody, input.Prepared.ExactBody) || prepared.JobSpecHash != input.Prepared.JobSpecHash {
		return Failure(ErrorHashMismatch, "prepared job specification binding is invalid", nil)
	}
	if !idempotencyPattern.MatchString(input.IdempotencyKey) {
		return Failure(ErrorInputInvalid, "job idempotency key is invalid", nil)
	}
	if !fingerprintPattern.MatchString(input.RequestFingerprint) {
		return Failure(ErrorInputInvalid, "job request fingerprint is invalid", nil)
	}
	expectedKey, expectedFingerprint := SubmissionBindings(prepared)
	if input.IdempotencyKey != expectedKey || input.RequestFingerprint != expectedFingerprint {
		return Failure(ErrorHashMismatch, "job request bindings do not match the exact specification", nil)
	}
	return nil
}

func SubmissionBindings(prepared PreparedJobSpec) (string, string) {
	idempotency := sha256.Sum256(append([]byte("openslack.workflow-runner-job.idempotency.v1\x00"), prepared.ExactBody...))
	fingerprintInput, _ := canonicaljson.Encode(map[string]any{
		"schema":        "openslack.workflow_runner_job_fingerprint.v1",
		"workspaceId":   prepared.Spec.WorkspaceID,
		"jobId":         prepared.Spec.JobID,
		"workflowRunId": prepared.Spec.WorkflowRunID,
		"jobSpecHash":   prepared.JobSpecHash,
	})
	fingerprint := sha256.Sum256(fingerprintInput)
	return "openslack.workflow-runner-job.v1." + hex.EncodeToString(idempotency[:]), "sha256:" + hex.EncodeToString(fingerprint[:])
}

func CancelBindings(input CancelInput) (string, string, error) {
	if err := ValidateCancelInputShape(input); err != nil {
		return "", "", err
	}
	preimage, err := canonicaljson.Encode(map[string]any{
		"schema":      "openslack.workflow_runner_cancel_admission.v1",
		"workspaceId": input.WorkspaceID, "jobId": input.JobID,
		"correlationId":     input.CorrelationID,
		"expectedAttemptId": input.ExpectedAttemptID,
		"expectedLeaseId":   input.ExpectedLeaseID,
		"expectedFence":     input.ExpectedFence, "reason": input.Reason,
		"requestedAt": CanonicalTimestamp(input.Now),
		"expiresAt":   CanonicalTimestamp(input.ExpiresAt),
	})
	if err != nil {
		return "", "", Failure(ErrorInputInvalid, "cancel admission cannot be canonicalized", err)
	}
	idempotency := sha256.Sum256(append([]byte("openslack.workflow-runner-cancel.idempotency.v1\x00"), preimage...))
	fingerprint := sha256.Sum256(append([]byte("openslack.workflow-runner-cancel.fingerprint.v1\x00"), preimage...))
	return "openslack.workflow-runner-cancel.v1." + hex.EncodeToString(idempotency[:]), "sha256:" + hex.EncodeToString(fingerprint[:]), nil
}

func ValidateCancelInput(input CancelInput) error {
	if err := ValidateCancelInputShape(input); err != nil {
		return err
	}
	if !cancelIdempotencyPattern.MatchString(input.IdempotencyKey) || !fingerprintPattern.MatchString(input.RequestFingerprint) {
		return Failure(ErrorInputInvalid, "cancel request bindings are invalid", nil)
	}
	key, fingerprint, err := CancelBindings(input)
	if err != nil {
		return err
	}
	if input.IdempotencyKey != key || input.RequestFingerprint != fingerprint {
		return Failure(ErrorHashMismatch, "cancel request bindings do not match the exact control", nil)
	}
	return nil
}

func ValidateCancelInputShape(input CancelInput) error {
	for name, value := range map[string]string{
		"workspaceId": input.WorkspaceID, "jobId": input.JobID,
		"correlationId": input.CorrelationID, "expectedAttemptId": input.ExpectedAttemptID,
		"expectedLeaseId": input.ExpectedLeaseID,
	} {
		if len(value) > runnerprotocol.MaxIdentifierBytes || !safeIDPattern.MatchString(value) {
			return Failure(ErrorInputInvalid, name+" is invalid", nil)
		}
	}
	if input.ExpectedFence < 1 || input.ExpectedFence > runnerprotocol.MaxSafeInteger {
		return Failure(ErrorInputInvalid, "expectedFence is invalid", nil)
	}
	allowedReason := input.Reason == "operator" || input.Reason == "lease_expired" || input.Reason == "shutdown" || input.Reason == "superseded" || input.Reason == "timeout"
	if !allowedReason {
		return Failure(ErrorInputInvalid, "cancel reason is invalid", nil)
	}
	requested := input.Now.UTC().Truncate(time.Millisecond)
	expires := input.ExpiresAt.UTC().Truncate(time.Millisecond)
	if !expires.After(requested) || expires.Sub(requested) > MaxCancellationWindow {
		return Failure(ErrorControlExpired, "cancel control expiry is outside the closed window", nil)
	}
	return nil
}

func ParseTimestamp(value string) (time.Time, error) {
	if !timestampPattern.MatchString(value) {
		return time.Time{}, Failure(ErrorInputInvalid, "timestamp must use canonical millisecond UTC", nil)
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	if err != nil {
		return time.Time{}, Failure(ErrorInputInvalid, "timestamp is invalid", err)
	}
	return parsed, nil
}

func CanonicalTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func ValidateRecordEventInput(input RecordEventInput) (runnerprotocol.PreparedMessage, error) {
	if err := runnerprotocol.ValidateEnvelope(input.Message); err != nil {
		return runnerprotocol.PreparedMessage{}, err
	}
	direction, err := runnerprotocol.DirectionForKind(input.Message.Kind)
	if err != nil {
		return runnerprotocol.PreparedMessage{}, err
	}
	if direction != runnerprotocol.DirectionRunnerToControl || input.Message.Kind == runnerprotocol.KindHello {
		return runnerprotocol.PreparedMessage{}, Failure(ErrorInputInvalid, "only leased runner events are durable", nil)
	}
	prepared, err := runnerprotocol.PrepareEnvelope(input.Message)
	if err != nil {
		return runnerprotocol.PreparedMessage{}, err
	}
	if !bytes.Equal(prepared.Body, input.ExactBytes) {
		return runnerprotocol.PreparedMessage{}, Failure(ErrorHashMismatch, "event bytes are not the exact canonical message bytes", nil)
	}
	if !hashPattern.MatchString(input.ControlBuildHash) {
		return runnerprotocol.PreparedMessage{}, Failure(ErrorHashMismatch, "control build hash is invalid", nil)
	}
	return prepared, nil
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return fmt.Errorf("multiple JSON values")
	}
	return err
}
