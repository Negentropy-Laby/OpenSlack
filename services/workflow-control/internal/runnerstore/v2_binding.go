package runnerstore

import (
	"context"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

const (
	V2RuntimeAdmissionSchema        = runnerbindingcontract.RuntimeAdmissionSchema
	V2RuntimeAdmissionReceiptSchema = runnerbindingcontract.RuntimeAdmissionReceiptSchema
	V2RuntimeAdmissionKeyPrefix     = runnerbindingcontract.RuntimeAdmissionKeyPrefix
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
	prepared, err := runnerbindingcontract.PrepareRuntimeAdmission(runtimeAdmissionRecord(value))
	if err != nil {
		return PreparedV2RuntimeAdmission{}, Failure(ErrorInputInvalid, "v2 runtime admission is invalid", err)
	}
	return preparedV2RuntimeAdmission(prepared), nil
}

func ParseV2RuntimeAdmission(input []byte) (PreparedV2RuntimeAdmission, error) {
	prepared, err := runnerbindingcontract.ParseRuntimeAdmissionBytes(input)
	if err != nil {
		return PreparedV2RuntimeAdmission{}, Failure(ErrorHashMismatch, "v2 runtime admission is not exact canonical LF bytes", err)
	}
	return preparedV2RuntimeAdmission(prepared), nil
}

func PrepareV2RuntimeAdmissionReceipt(value V2RuntimeAdmissionReceipt) ([]byte, error) {
	prepared, err := PrepareV2RuntimeAdmission(V2RuntimeAdmission{Schema: V2RuntimeAdmissionSchema,
		WorkspaceID: value.WorkspaceID, JobID: value.JobID, WorkflowRunID: value.WorkflowRunID,
		AttemptID: value.AttemptID, LeaseID: value.LeaseID, FencingToken: value.FencingToken,
		JobSpecHash: value.JobSpecHash, Disposition: value.Disposition})
	if err != nil {
		return nil, err
	}
	contractPrepared, contractErr := runnerbindingcontract.PrepareRuntimeAdmission(runtimeAdmissionRecord(prepared.Value))
	if contractErr != nil {
		return nil, Failure(ErrorHashMismatch, "v2 runtime admission receipt bindings are invalid", contractErr)
	}
	validated, contractErr := runnerbindingcontract.ValidateRuntimeAdmissionReceipt(runtimeAdmissionReceiptRecord(value), contractPrepared)
	if contractErr != nil {
		return nil, Failure(ErrorHashMismatch, "v2 runtime admission receipt bindings are invalid", contractErr)
	}
	body, contractErr := canonicaljson.Encode(validated)
	if contractErr != nil {
		return nil, contractErr
	}
	return append(body, '\n'), nil
}

func ParseV2RuntimeAdmissionReceipt(input []byte, prepared PreparedV2RuntimeAdmission) (V2RuntimeAdmissionReceipt, error) {
	contractPrepared, err := runnerbindingcontract.PrepareRuntimeAdmission(runtimeAdmissionRecord(prepared.Value))
	if err != nil {
		return V2RuntimeAdmissionReceipt{}, Failure(ErrorHashMismatch, "v2 runtime admission receipt request is invalid", err)
	}
	record, err := runnerbindingcontract.ParseRuntimeAdmissionReceiptBytes(input, contractPrepared)
	if err != nil {
		return V2RuntimeAdmissionReceipt{}, Failure(ErrorHashMismatch, "v2 runtime admission receipt is not exact", err)
	}
	return V2RuntimeAdmissionReceipt{Schema: V2RuntimeAdmissionReceiptSchema, Status: "accepted",
		WorkspaceID: record["workspaceId"].(string), JobID: record["jobId"].(string),
		WorkflowRunID: record["workflowRunId"].(string), AttemptID: record["attemptId"].(string),
		LeaseID: record["leaseId"].(string), FencingToken: record["fencingToken"].(int64),
		JobSpecHash: record["jobSpecHash"].(string), Disposition: record["disposition"].(string),
		IdempotencyKey: record["idempotencyKey"].(string), RequestFingerprint: record["requestFingerprint"].(string),
		CommittedAt: record["committedAt"].(string), ExactBytes: append([]byte(nil), input...)}, nil
}

func runtimeAdmissionRecord(value V2RuntimeAdmission) runnerbindingcontract.Record {
	return runnerbindingcontract.Record{"schema": value.Schema, "workspaceId": value.WorkspaceID,
		"jobId": value.JobID, "workflowRunId": value.WorkflowRunID, "attemptId": value.AttemptID,
		"leaseId": value.LeaseID, "fencingToken": value.FencingToken, "jobSpecHash": value.JobSpecHash,
		"disposition": value.Disposition}
}

func runtimeAdmissionReceiptRecord(value V2RuntimeAdmissionReceipt) runnerbindingcontract.Record {
	record := runtimeAdmissionRecord(V2RuntimeAdmission{Schema: V2RuntimeAdmissionSchema,
		WorkspaceID: value.WorkspaceID, JobID: value.JobID, WorkflowRunID: value.WorkflowRunID,
		AttemptID: value.AttemptID, LeaseID: value.LeaseID, FencingToken: value.FencingToken,
		JobSpecHash: value.JobSpecHash, Disposition: value.Disposition})
	record["schema"], record["status"] = value.Schema, value.Status
	record["idempotencyKey"], record["requestFingerprint"] = value.IdempotencyKey, value.RequestFingerprint
	record["committedAt"] = value.CommittedAt
	return record
}

func preparedV2RuntimeAdmission(prepared runnerbindingcontract.PreparedRuntimeAdmission) PreparedV2RuntimeAdmission {
	value := prepared.Value
	return PreparedV2RuntimeAdmission{Value: V2RuntimeAdmission{Schema: V2RuntimeAdmissionSchema,
		WorkspaceID: value["workspaceId"].(string), JobID: value["jobId"].(string),
		WorkflowRunID: value["workflowRunId"].(string), AttemptID: value["attemptId"].(string),
		LeaseID: value["leaseId"].(string), FencingToken: value["fencingToken"].(int64),
		JobSpecHash: value["jobSpecHash"].(string), Disposition: value["disposition"].(string)},
		ExactBytes: prepared.ExactBytes, IdempotencyKey: prepared.IdempotencyKey,
		RequestFingerprint: prepared.RequestFingerprint}
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

type V2AuthorityRecoverySummary struct {
	Examined   int
	Reconciled int
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

type V2AuthorityRecoveryStore interface {
	RecoverAuthorityBindingsAtStartup(context.Context, string, time.Time, int) (V2AuthorityRecoverySummary, error)
}

type V2RuntimeAdmissionStore interface {
	SealV2RuntimeAdmission(context.Context, V2RuntimeAdmissionInput) (V2RuntimeAdmissionReceipt, error)
}
