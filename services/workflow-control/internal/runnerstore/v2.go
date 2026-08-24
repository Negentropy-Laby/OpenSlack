package runnerstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"unicode/utf8"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerprotocols"
)

const (
	V2JobSpecSchema     = "openslack.workflow_runner_job_spec.v2"
	V2JobReceiptSchema  = "openslack.workflow_runner_job_receipt.v2"
	V2JobSpecHashDomain = "openslack.workflow-runner.job-spec.v2\x00"
	V2JobKeyPrefix      = "openslack.workflow-runner-job.v2."
)

func V2RequiredCapabilities() []string { return runnerprotocols.Capabilities() }

// V2JobSpec is an additive admission contract. The budget policy remains in
// the hash-bound execution descriptor; it is deliberately not duplicated in
// the runner-control admission body.
type V2JobSpec struct {
	Schema                  string                  `json:"schema"`
	WorkspaceID             string                  `json:"workspaceId"`
	JobID                   string                  `json:"jobId"`
	WorkflowRunID           string                  `json:"workflowRunId"`
	CorrelationID           string                  `json:"correlationId"`
	ExecutionDescriptorRef  string                  `json:"executionDescriptorRef"`
	ExecutionDescriptorHash string                  `json:"executionDescriptorHash"`
	WorkflowID              string                  `json:"workflowId"`
	WorkflowVersion         string                  `json:"workflowVersion"`
	WorkflowSourceHash      string                  `json:"workflowSourceHash"`
	ManifestHash            string                  `json:"manifestHash"`
	InputHash               string                  `json:"inputHash"`
	WholeTimeoutMS          int64                   `json:"wholeTimeoutMs"`
	SubmittedAt             string                  `json:"submittedAt"`
	RequiredProtocolVersion string                  `json:"requiredProtocolVersion"`
	RequiredCapabilities    []string                `json:"requiredCapabilities"`
	AuthorityRoute          authoritycontract.Route `json:"authorityRoute"`
	RunRevision             int64                   `json:"runRevision"`
	ResumeGeneration        int64                   `json:"resumeGeneration"`
}

type PreparedV2JobSpec struct {
	Spec        V2JobSpec
	ExactBody   []byte
	JobSpecHash string
}

type V2SubmitInput struct {
	Prepared           PreparedV2JobSpec
	IdempotencyKey     string
	RequestFingerprint string
}

type V2JobReceipt struct {
	Schema             string        `json:"schema"`
	Status             ReceiptStatus `json:"status"`
	WorkspaceID        string        `json:"workspaceId"`
	JobID              string        `json:"jobId"`
	WorkflowRunID      string        `json:"workflowRunId"`
	State              JobState      `json:"state"`
	Revision           int64         `json:"revision"`
	JobSpecHash        string        `json:"jobSpecHash"`
	IdempotencyKey     string        `json:"idempotencyKey"`
	RequestFingerprint string        `json:"requestFingerprint"`
	CommittedAt        string        `json:"committedAt"`
	ReconciliationID   *string       `json:"reconciliationId"`
	ExactBytes         []byte        `json:"-"`
	Replay             bool          `json:"-"`
}

type V2JobStore interface {
	SubmitV2(context.Context, V2SubmitInput) (V2JobReceipt, error)
}

func ParseV2JobSpec(input []byte) (PreparedV2JobSpec, error) {
	return parseV2JobSpec(input, false)
}

// ParseV2RuntimeJobSpec admits the schema-8 qualification-only Go route. The
// caller must already have proven that the runtime-delivery profile is
// explicitly enabled; production routing remains a later batch.
func ParseV2RuntimeJobSpec(input []byte) (PreparedV2JobSpec, error) {
	return parseV2JobSpec(input, true)
}

func parseV2JobSpec(input []byte, runtimeDelivery bool) (PreparedV2JobSpec, error) {
	if len(input) == 0 || len(input) > MaxJobSpecBytes || !utf8.Valid(input) {
		return PreparedV2JobSpec{}, Failure(ErrorLimitExceeded, "v2 job specification bytes are invalid", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	var value V2JobSpec
	if err := decoder.Decode(&value); err != nil {
		return PreparedV2JobSpec{}, Failure(ErrorInputInvalid, "v2 job specification is not closed JSON", err)
	}
	if err := requireEOF(decoder); err != nil {
		return PreparedV2JobSpec{}, Failure(ErrorInputInvalid, "v2 job specification has trailing content", err)
	}
	prepared, err := PrepareV2JobSpec(value)
	if err != nil {
		return PreparedV2JobSpec{}, err
	}
	if err := ValidateV2Admission(value, runtimeDelivery); err != nil {
		return PreparedV2JobSpec{}, err
	}
	return prepared, nil
}

func PrepareV2JobSpec(value V2JobSpec) (PreparedV2JobSpec, error) {
	if err := ValidateV2JobSpec(value); err != nil {
		return PreparedV2JobSpec{}, err
	}
	body, err := canonicaljson.Encode(value)
	if err != nil {
		return PreparedV2JobSpec{}, Failure(ErrorInputInvalid, "v2 job specification cannot be canonicalized", err)
	}
	digest := sha256.Sum256(append([]byte(V2JobSpecHashDomain), body...))
	return PreparedV2JobSpec{Spec: value, ExactBody: body, JobSpecHash: hex.EncodeToString(digest[:])}, nil
}

func ValidateV2JobSpec(value V2JobSpec) error {
	if value.Schema != V2JobSpecSchema || value.RequiredProtocolVersion != authoritycontract.ProtocolVersion {
		return Failure(ErrorUnsupportedProtocol, "v2 job specification requires Workflow Runner protocol v2", nil)
	}
	base := JobSpec{
		Schema: JobSpecSchema, WorkspaceID: value.WorkspaceID, JobID: value.JobID,
		WorkflowRunID: value.WorkflowRunID, CorrelationID: value.CorrelationID,
		ExecutionDescriptorRef: value.ExecutionDescriptorRef, ExecutionDescriptorHash: value.ExecutionDescriptorHash,
		WorkflowID: value.WorkflowID, WorkflowVersion: value.WorkflowVersion,
		WorkflowSourceHash: value.WorkflowSourceHash, ManifestHash: value.ManifestHash, InputHash: value.InputHash,
		WholeTimeoutMS: value.WholeTimeoutMS, SubmittedAt: value.SubmittedAt,
	}
	if err := ValidateJobSpec(base); err != nil {
		return err
	}
	if len(value.WorkflowVersion) > 64 || !semverPattern.MatchString(value.WorkflowVersion) {
		return Failure(ErrorInputInvalid, "v2 workflowVersion must be exact semantic version text", nil)
	}
	if !runnerprotocols.CapabilitiesMatch(value.RequiredCapabilities) {
		return Failure(ErrorCapabilityMismatch, "v2 job capabilities must match the closed qualification set", nil)
	}
	if _, err := authoritycontract.ValidateRoute(map[string]any{
		"backend": value.AuthorityRoute.Backend, "authority": value.AuthorityRoute.Authority,
		"routingEpoch": value.AuthorityRoute.RoutingEpoch, "authorityBuildHash": value.AuthorityRoute.AuthorityBuildHash,
	}, "$/authorityRoute"); err != nil {
		return Failure(ErrorAuthorityBinding, "v2 job authority route is invalid", nil)
	}
	if value.RunRevision < 1 || value.RunRevision > authoritycontract.MaxSafeInteger || value.ResumeGeneration < 0 || value.ResumeGeneration > authoritycontract.MaxSafeInteger {
		return Failure(ErrorAuthorityBinding, "v2 job run revision or resume generation is invalid", nil)
	}
	return nil
}

// ValidateV2JobReceipt validates the closed receipt independently of its
// transport. Replay metadata and ExactBytes are deliberately not serialized.
func ValidateV2JobReceipt(value V2JobReceipt) error {
	if value.Schema != V2JobReceiptSchema ||
		(value.Status != ReceiptAccepted && value.Status != ReceiptReconciliationRequired) {
		return Failure(ErrorHashMismatch, "v2 job receipt schema or status is invalid", nil)
	}
	for _, identifier := range []string{value.WorkspaceID, value.JobID, value.WorkflowRunID} {
		if len(identifier) > 256 || !safeIDPattern.MatchString(identifier) {
			return Failure(ErrorHashMismatch, "v2 job receipt identity is invalid", nil)
		}
	}
	if !hashPattern.MatchString(value.JobSpecHash) ||
		!v2IdempotencyPattern.MatchString(value.IdempotencyKey) ||
		!fingerprintPattern.MatchString(value.RequestFingerprint) ||
		value.Revision < 1 || value.Revision > authoritycontract.MaxSafeInteger {
		return Failure(ErrorHashMismatch, "v2 job receipt binding is invalid", nil)
	}
	if _, err := ParseTimestamp(value.CommittedAt); err != nil {
		return Failure(ErrorHashMismatch, "v2 job receipt timestamp is invalid", err)
	}
	switch value.Status {
	case ReceiptAccepted:
		if value.State != JobQueued || value.Revision != 1 || value.ReconciliationID != nil {
			return Failure(ErrorHashMismatch, "accepted v2 job receipt state is invalid", nil)
		}
	case ReceiptReconciliationRequired:
		if value.State != JobReconciliationRequired || value.ReconciliationID == nil || !safeIDPattern.MatchString(*value.ReconciliationID) {
			return Failure(ErrorHashMismatch, "reconciliation v2 job receipt state is invalid", nil)
		}
	}
	return nil
}

// ValidateV2JobReceiptForSubmit prevents a canonical receipt from another
// job, workspace, workflow run, or idempotency request being cross-spliced.
func ValidateV2JobReceiptForSubmit(value V2JobReceipt, input V2SubmitInput) error {
	if err := ValidateV2JobReceipt(value); err != nil {
		return err
	}
	spec := input.Prepared.Spec
	if value.WorkspaceID != spec.WorkspaceID || value.JobID != spec.JobID ||
		value.WorkflowRunID != spec.WorkflowRunID || value.JobSpecHash != input.Prepared.JobSpecHash ||
		value.IdempotencyKey != input.IdempotencyKey || value.RequestFingerprint != input.RequestFingerprint {
		return Failure(ErrorHashMismatch, "v2 job receipt does not bind the submitted job", nil)
	}
	return nil
}

func ValidateV2SubmitInput(input V2SubmitInput) error {
	return ValidateV2SubmitInputForProfile(input, false)
}

func ValidateV2SubmitInputForProfile(input V2SubmitInput, runtimeDelivery bool) error {
	prepared, err := PrepareV2JobSpec(input.Prepared.Spec)
	if err != nil {
		return err
	}
	if !bytes.Equal(prepared.ExactBody, input.Prepared.ExactBody) || prepared.JobSpecHash != input.Prepared.JobSpecHash {
		return Failure(ErrorHashMismatch, "prepared v2 job binding is invalid", nil)
	}
	key, fingerprint := V2SubmissionBindings(prepared)
	if input.IdempotencyKey != key || input.RequestFingerprint != fingerprint {
		return Failure(ErrorHashMismatch, "v2 job request bindings do not match the exact specification", nil)
	}
	if err := ValidateV2Admission(input.Prepared.Spec, runtimeDelivery); err != nil {
		return err
	}
	return nil
}

// ValidateV2QualificationAdmission narrows the frozen v2 wire contract to the
// F1 operational profile. The contract can describe a future Go authority
// route, but a TypeScript worker must never execute such a job before the real
// authority adapters and writer cutover exist.
func ValidateV2QualificationAdmission(value V2JobSpec) error {
	return ValidateV2Admission(value, false)
}

func ValidateV2Admission(value V2JobSpec, runtimeDelivery bool) error {
	if runtimeDelivery && value.AuthorityRoute.Backend == "go" && value.AuthorityRoute.Authority == "workflow-control" {
		return nil
	}
	if value.AuthorityRoute.Backend != "ts-local" || value.AuthorityRoute.Authority != "typescript" {
		return Failure(ErrorAuthorityUnavailable, "v2 qualification admits only the TypeScript authority route", nil)
	}
	return nil
}

func V2SubmissionBindings(prepared PreparedV2JobSpec) (string, string) {
	idempotency := sha256.Sum256(append([]byte("openslack.workflow-runner-job.idempotency.v2\x00"), prepared.ExactBody...))
	fingerprintInput, _ := canonicaljson.Encode(map[string]any{
		"schema": "openslack.workflow_runner_job_fingerprint.v2", "workspaceId": prepared.Spec.WorkspaceID,
		"jobId": prepared.Spec.JobID, "workflowRunId": prepared.Spec.WorkflowRunID, "jobSpecHash": prepared.JobSpecHash,
		"requiredProtocolVersion": prepared.Spec.RequiredProtocolVersion,
	})
	fingerprint := sha256.Sum256(fingerprintInput)
	return V2JobKeyPrefix + hex.EncodeToString(idempotency[:]), "sha256:" + hex.EncodeToString(fingerprint[:])
}

func (value V2JobSpec) String() string {
	return fmt.Sprintf("%s/%s@%s", value.WorkspaceID, value.JobID, value.RequiredProtocolVersion)
}
