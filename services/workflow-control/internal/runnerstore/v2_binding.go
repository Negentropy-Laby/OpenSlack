package runnerstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

const (
	V2RuntimeAdmissionSchema        = "openslack.workflow_runner_v2_runtime_admission.v1"
	V2RuntimeAdmissionReceiptSchema = "openslack.workflow_runner_v2_runtime_admission_receipt.v1"
	V2RuntimeAdmissionKeyPrefix     = "openslack.workflow-runner-v2-runtime-admission.v1."
)

type V2RuntimeAdmission struct {
	Schema        string `json:"schema"`
	WorkspaceID   string `json:"workspaceId"`
	JobID         string `json:"jobId"`
	WorkflowRunID string `json:"workflowRunId"`
	AttemptID     string `json:"attemptId"`
	LeaseID       string `json:"leaseId"`
	FencingToken  int64  `json:"fencingToken"`
	JobSpecHash   string `json:"jobSpecHash"`
	Disposition   string `json:"disposition"`
}

type PreparedV2RuntimeAdmission struct {
	Value              V2RuntimeAdmission
	ExactBytes         []byte
	IdempotencyKey     string
	RequestFingerprint string
}

type V2RuntimeAdmissionReceipt struct {
	Schema             string `json:"schema"`
	Status             string `json:"status"`
	WorkspaceID        string `json:"workspaceId"`
	JobID              string `json:"jobId"`
	WorkflowRunID      string `json:"workflowRunId"`
	AttemptID          string `json:"attemptId"`
	LeaseID            string `json:"leaseId"`
	FencingToken       int64  `json:"fencingToken"`
	JobSpecHash        string `json:"jobSpecHash"`
	Disposition        string `json:"disposition"`
	IdempotencyKey     string `json:"idempotencyKey"`
	RequestFingerprint string `json:"requestFingerprint"`
	CommittedAt        string `json:"committedAt"`
	ExactBytes         []byte `json:"-"`
	Replay             bool   `json:"-"`
}

type V2RuntimeAdmissionInput struct {
	WorkspaceID        string
	Prepared           PreparedV2RuntimeAdmission
	IdempotencyKey     string
	RequestFingerprint string
}

func PrepareV2RuntimeAdmission(value V2RuntimeAdmission) (PreparedV2RuntimeAdmission, error) {
	if value.Schema != V2RuntimeAdmissionSchema || value.Disposition != "initial" && value.Disposition != "resume" ||
		!safeIDPattern.MatchString(value.WorkspaceID) || !safeIDPattern.MatchString(value.JobID) ||
		!safeIDPattern.MatchString(value.WorkflowRunID) || !safeIDPattern.MatchString(value.AttemptID) ||
		!safeIDPattern.MatchString(value.LeaseID) || value.FencingToken < 1 || value.FencingToken > authoritycontract.MaxSafeInteger ||
		!hashPattern.MatchString(value.JobSpecHash) {
		return PreparedV2RuntimeAdmission{}, Failure(ErrorInputInvalid, "v2 runtime admission is invalid", nil)
	}
	body, err := canonicaljson.Encode(value)
	if err != nil {
		return PreparedV2RuntimeAdmission{}, Failure(ErrorInputInvalid, "v2 runtime admission cannot be canonicalized", err)
	}
	body = append(body, '\n')
	keyHash := sha256.Sum256(append([]byte("openslack.workflow-runner-v2-runtime-admission.idempotency.v1\x00"), body...))
	fingerprintHash := sha256.Sum256(append([]byte("openslack.workflow-runner-v2-runtime-admission.fingerprint.v1\x00"), body...))
	return PreparedV2RuntimeAdmission{Value: value, ExactBytes: body,
		IdempotencyKey:     V2RuntimeAdmissionKeyPrefix + hex.EncodeToString(keyHash[:]),
		RequestFingerprint: "sha256:" + hex.EncodeToString(fingerprintHash[:])}, nil
}

func ParseV2RuntimeAdmission(input []byte) (PreparedV2RuntimeAdmission, error) {
	if len(input) < 2 || len(input) > MaxJobSpecBytes || input[len(input)-1] != '\n' || bytes.Contains(input[:len(input)-1], []byte{'\n'}) {
		return PreparedV2RuntimeAdmission{}, Failure(ErrorInputInvalid, "v2 runtime admission must be one exact LF record", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(input[:len(input)-1]))
	decoder.DisallowUnknownFields()
	var value V2RuntimeAdmission
	if err := decoder.Decode(&value); err != nil {
		return PreparedV2RuntimeAdmission{}, Failure(ErrorInputInvalid, "v2 runtime admission is not closed JSON", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return PreparedV2RuntimeAdmission{}, Failure(ErrorInputInvalid, "v2 runtime admission has trailing content", err)
	}
	prepared, err := PrepareV2RuntimeAdmission(value)
	if err != nil || !bytes.Equal(prepared.ExactBytes, input) {
		return PreparedV2RuntimeAdmission{}, Failure(ErrorHashMismatch, "v2 runtime admission is not exact canonical LF bytes", err)
	}
	return prepared, nil
}

func PrepareV2RuntimeAdmissionReceipt(value V2RuntimeAdmissionReceipt) ([]byte, error) {
	if value.Schema != V2RuntimeAdmissionReceiptSchema || value.Status != "accepted" || value.CommittedAt == "" {
		return nil, Failure(ErrorHashMismatch, "v2 runtime admission receipt is invalid", nil)
	}
	prepared, err := PrepareV2RuntimeAdmission(V2RuntimeAdmission{Schema: V2RuntimeAdmissionSchema,
		WorkspaceID: value.WorkspaceID, JobID: value.JobID, WorkflowRunID: value.WorkflowRunID,
		AttemptID: value.AttemptID, LeaseID: value.LeaseID, FencingToken: value.FencingToken,
		JobSpecHash: value.JobSpecHash, Disposition: value.Disposition})
	if err != nil || prepared.IdempotencyKey != value.IdempotencyKey || prepared.RequestFingerprint != value.RequestFingerprint {
		return nil, Failure(ErrorHashMismatch, "v2 runtime admission receipt bindings are invalid", err)
	}
	body, err := canonicaljson.Encode(value)
	if err != nil {
		return nil, err
	}
	return append(body, '\n'), nil
}

// V2AuthorityBindingInput carries one exact F2a companion frame. Prepared is
// recomputed by the HTTP edge and the repository still revalidates it before
// persistence; callers cannot smuggle a body/header mismatch through this
// typed port.
type V2AuthorityBindingInput struct {
	WorkspaceID        string
	Prepared           runnerbindingcontract.Prepared
	IdempotencyKey     string
	RequestFingerprint string
}

type V2AuthorityBindingReceipt struct {
	Value      runnerbindingcontract.Record
	ExactBytes []byte
	Replay     bool
}

type V2ControlAcknowledgementInput struct {
	BindingID          string
	WorkspaceID        string
	Prepared           runnerbindingcontract.Prepared
	IdempotencyKey     string
	RequestFingerprint string
}

type V2ControlAcknowledgementView struct {
	ControlEventID    string
	ControlKind       string
	ControlSequence   int64
	CompanionSequence int64
	Disposition       string
	ExactControlBytes []byte
	ExactACKBytes     []byte
	ProcessedAt       time.Time
}

type V2AuthorityBindingView struct {
	BindingID              string
	Operation              runnerbindingcontract.Operation
	State                  string
	WorkspaceID            string
	JobID                  string
	RunID                  string
	AttemptID              string
	LeaseID                string
	FencingToken           int64
	ExpectedRunRevision    int64
	AcceptedRunRevision    int64
	ExpectedGeneration     int64
	AcceptedGeneration     int64
	TargetEventID          string
	TargetKind             string
	TargetSequence         int64
	ExactTargetBytes       []byte
	ExactStageBytes        []byte
	ExactStageReceipt      []byte
	ExactResolutionBytes   []byte
	ExactResolutionReceipt []byte
	SourcePlane            *string
	SourceEvidenceState    *string
	ExactSourceResult      []byte
	SourceResultHash       []byte
	ReconciliationID       *string
	ReconciliationReason   *string
	ControlACKs            []V2ControlAcknowledgementView
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

// V2AuthorityBindingStore is exposed only by the schema-8, loopback,
// qualification-only composition root.
type V2AuthorityBindingStore interface {
	StageAuthorityBinding(context.Context, V2AuthorityBindingInput) (V2AuthorityBindingReceipt, error)
	ResolveAuthorityBinding(context.Context, string, V2AuthorityBindingInput) (V2AuthorityBindingReceipt, error)
	AcknowledgeV2Control(context.Context, V2ControlAcknowledgementInput) (V2AuthorityBindingReceipt, error)
	ReadAuthorityBindingReceipt(context.Context, string, string) (V2AuthorityBindingReceipt, error)
	ReadAuthorityBindingForEvent(context.Context, string, []byte) (V2AuthorityBindingView, error)
	RecoverAuthorityBindings(context.Context, string, time.Time, int) ([]V2AuthorityBindingView, error)
}

type V2RuntimeAdmissionStore interface {
	SealV2RuntimeAdmission(context.Context, V2RuntimeAdmissionInput) (V2RuntimeAdmissionReceipt, error)
}
