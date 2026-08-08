// Package authoritystore owns the default-off GS9-B PostgreSQL qualification
// spine for Workflow Control runs explicitly routed to Go. It is independent
// from the workflow_runner_* job/attempt/lease/fence namespace.
package authoritystore

import (
	"context"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
)

const (
	AcceptSchema         = "openslack.workflow_control_authority_accept.v2"
	TransitionSchema     = "openslack.workflow_control_authority_transition.v2"
	RunRecordSchema      = "openslack.workflow_control_authority_run_record.v2"
	ReadSchema           = "openslack.workflow_control_authority_read.v2"
	OutboxSchema         = "openslack.workflow_control_authority_outbox.v2"
	Backend              = "go"
	Authority            = "workflow-control"
	IdempotencyPrefix    = authoritycontract.IdempotencyPrefix
	MaxRequestBytes      = authoritycontract.MaxStateBytes
	OutboxEventType      = "workflow_control.run_transitioned"
	OutboxKeyPrefix      = "openslack.workflow-control-authority-outbox.v2."
	ReconciliationPrefix = "wca-reconciliation"
)

type Operation string

const (
	OperationAccept     Operation = "accept"
	OperationTransition Operation = "transition"
)

type Route = authoritycontract.Route
type RunState = authoritycontract.RunState

type ExpectedBinding struct {
	Revision          int64     `json:"revision"`
	State             *RunState `json:"state"`
	CurrentPhaseID    *string   `json:"currentPhaseId"`
	CurrentPhaseIndex *int64    `json:"currentPhaseIndex"`
	ResumeGeneration  int64     `json:"resumeGeneration"`
}

// RunRecord is the canonical target head supplied by the caller. It contains
// no runner job, attempt, lease, or fence binding; those belong to GS9-F.
type RunRecord struct {
	Schema             string   `json:"schema"`
	WorkspaceID        string   `json:"workspaceId"`
	RunID              string   `json:"runId"`
	WorkflowID         string   `json:"workflowId"`
	WorkflowVersion    string   `json:"workflowVersion"`
	WorkflowSourceHash string   `json:"workflowSourceHash"`
	ManifestHash       string   `json:"manifestHash"`
	InputHash          string   `json:"inputHash"`
	Route              Route    `json:"route"`
	State              RunState `json:"state"`
	Revision           int64    `json:"revision"`
	CurrentPhaseID     *string  `json:"currentPhaseId"`
	CurrentPhaseIndex  *int64   `json:"currentPhaseIndex"`
	ResumeGeneration   int64    `json:"resumeGeneration"`
}

// OutboxPayload is the canonical transaction-outbox event body shared by the
// PostgreSQL writer and the HTTP read-path verifier.
type OutboxPayload struct {
	Schema        string          `json:"schema"`
	EventID       string          `json:"eventId"`
	ReceiptID     string          `json:"receiptId"`
	WorkspaceID   string          `json:"workspaceId"`
	RunID         string          `json:"runId"`
	Expected      ExpectedBinding `json:"expected"`
	Record        RunRecord       `json:"record"`
	RecordHash    string          `json:"recordHash"`
	CorrelationID string          `json:"correlationId"`
}

type RequestEnvelope struct {
	Schema        string          `json:"schema"`
	Operation     Operation       `json:"operation"`
	WorkspaceID   string          `json:"workspaceId"`
	RunID         string          `json:"runId"`
	Expected      ExpectedBinding `json:"expected"`
	Route         Route           `json:"route"`
	Record        RunRecord       `json:"record"`
	CorrelationID string          `json:"correlationId"`
}

type PreparedRequest struct {
	Envelope             RequestEnvelope
	CallerID             string
	ExpectedServiceBuild string
	RecordBytes          []byte
	RecordHash           string
	RequestHash          string
	ExactBody            []byte
}

type MutateInput struct {
	Prepared           PreparedRequest
	IdempotencyKey     string
	RequestFingerprint string
	ServiceBuildHash   string
}

// Receipt carries both the parsed frozen v2 receipt and the exact immutable
// bytes persisted for transport. Replay is metadata only and never changes
// ExactBytes.
type Receipt struct {
	Value      authoritycontract.Receipt
	ExactBytes []byte
	Replay     bool
	ReceiptID  string
	RecordedAt time.Time
}

type RunHead struct {
	Schema             string
	WorkspaceID        string
	RunID              string
	WorkflowID         string
	WorkflowVersion    string
	WorkflowSourceHash string
	ManifestHash       string
	InputHash          string
	Route              Route
	State              RunState
	Revision           int64
	CurrentPhaseID     *string
	CurrentPhaseIndex  *int64
	ResumeGeneration   int64
	RecordHash         string
	RecordBytes        []byte
	UpdatedAt          time.Time
}

type OutboxRecord struct {
	Schema         string
	OutboxID       string
	EventID        string
	WorkspaceID    string
	RunID          string
	RunRevision    int64
	EventType      string
	Status         string
	IdempotencyKey string
	PayloadHash    string
	PayloadBytes   []byte
	AttemptCount   int
	CreatedAt      time.Time
}

type Statistics struct {
	Runs                  int64
	Receipts              int64
	TransitionEvents      int64
	OutboxPending         int64
	ReconciliationPending int64
}

type Repository interface {
	Mutate(context.Context, MutateInput) (Receipt, error)
	Read(context.Context, string, string) (RunHead, error)
	ReadReceipt(context.Context, string, string) (Receipt, error)
	ReadOutbox(context.Context, string, string, int64) (OutboxRecord, error)
	Ready(context.Context) error
	Statistics(context.Context) (Statistics, error)
}
