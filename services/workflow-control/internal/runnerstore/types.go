// Package runnerstore owns the GS8-B runner control records. It deliberately
// does not own Workflow RunStore status, checkpoints, resume, approvals, or
// budget accounting; those remain TypeScript authority through GS8.
package runnerstore

import (
	"context"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

const (
	JobSpecSchema        = "openslack.workflow_runner_job_spec.v1"
	JobReceiptSchema     = "openslack.workflow_runner_job_receipt.v1"
	JobViewSchema        = "openslack.workflow_runner_job_view.v1"
	ReconciliationSchema = "openslack.workflow_runner_reconciliation.v1"
	JobSpecHashDomain    = "openslack.workflow-runner.job-spec.v1\x00"

	MaxJobSpecBytes       = 64 * 1024
	MaxWholeTimeout       = 24 * time.Hour
	MinWholeTimeout       = time.Second
	MaxLeaseDuration      = 24 * time.Hour
	MinLeaseDuration      = time.Second
	MaxCancellationWindow = 5 * time.Minute
	MaxDispatchFailures   = 5
	MinDispatchBackoff    = 250 * time.Millisecond
	MaxDispatchBackoff    = 30 * time.Second
)

type JobState string

const (
	JobQueued                 JobState = "queued"
	JobOffered                JobState = "offered"
	JobRunning                JobState = "running"
	JobCancelling             JobState = "cancelling"
	JobTerminal               JobState = "terminal"
	JobReconciliationRequired JobState = "reconciliation_required"
)

type AttemptState string

const (
	AttemptOffered                AttemptState = "offered"
	AttemptAccepted               AttemptState = "accepted"
	AttemptRunning                AttemptState = "running"
	AttemptCancelling             AttemptState = "cancelling"
	AttemptTerminal               AttemptState = "terminal"
	AttemptRejected               AttemptState = "rejected"
	AttemptExpired                AttemptState = "expired"
	AttemptCrashed                AttemptState = "crashed"
	AttemptReconciliationRequired AttemptState = "reconciliation_required"
)

type ReceiptStatus string

const (
	ReceiptAccepted               ReceiptStatus = "accepted"
	ReceiptDuplicate              ReceiptStatus = "duplicate"
	ReceiptReconciliationRequired ReceiptStatus = "reconciliation_required"
)

type ProcessExitClass string

const (
	ProcessExitedCleanly ProcessExitClass = "clean"
	ProcessCrashed       ProcessExitClass = "crashed"
	ProcessForced        ProcessExitClass = "forced"
)

// JobSpec is the closed, hash-only admission record. executionDescriptorRef is
// opaque; Go never resolves it or receives workflow paths, arguments, prompts,
// credentials, provider payloads, approval decisions, or budget decisions.
type JobSpec struct {
	Schema                  string `json:"schema"`
	WorkspaceID             string `json:"workspaceId"`
	JobID                   string `json:"jobId"`
	WorkflowRunID           string `json:"workflowRunId"`
	CorrelationID           string `json:"correlationId"`
	ExecutionDescriptorRef  string `json:"executionDescriptorRef"`
	ExecutionDescriptorHash string `json:"executionDescriptorHash"`
	WorkflowID              string `json:"workflowId"`
	WorkflowVersion         string `json:"workflowVersion"`
	WorkflowSourceHash      string `json:"workflowSourceHash"`
	ManifestHash            string `json:"manifestHash"`
	InputHash               string `json:"inputHash"`
	WholeTimeoutMS          int64  `json:"wholeTimeoutMs"`
	SubmittedAt             string `json:"submittedAt"`
}

type PreparedJobSpec struct {
	Spec        JobSpec
	ExactBody   []byte
	JobSpecHash string
}

type SubmitInput struct {
	Prepared           PreparedJobSpec
	IdempotencyKey     string
	RequestFingerprint string
}

type JobReceipt struct {
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
}

type ClaimInput struct {
	WorkspaceID          string
	SupervisorInstanceID string
	LeaseOfferTimeout    time.Duration
	LeaseDuration        time.Duration
	Now                  time.Time
}

type AttemptLease struct {
	WorkspaceID             string
	JobID                   string
	WorkflowRunID           string
	CorrelationID           string
	AttemptID               string
	AttemptOrdinal          int64
	LeaseID                 string
	FencingToken            int64
	ControlSequence         int64
	ExecutionDescriptorRef  string
	ExecutionDescriptorHash string
	JobSpecHash             string
	WorkflowID              string
	WorkflowVersion         string
	WorkflowSourceHash      string
	ManifestHash            string
	InputHash               string
	OfferedAt               time.Time
	OfferExpiresAt          time.Time
	LeaseExpiresAt          time.Time
	WholeDeadline           time.Time
	LeaseOffer              runnerprotocol.Envelope
	LeaseOfferBytes         []byte
}

type RecordEventInput struct {
	Message          runnerprotocol.Envelope
	ExactBytes       []byte
	ControlBuildHash string
	Now              time.Time
}

type NegotiationInput struct {
	Lease             AttemptLease
	Hello             runnerprotocol.Envelope
	ExactBytes        []byte
	ControlBuildHash  string
	HeartbeatInterval time.Duration
	LeaseOfferTimeout time.Duration
	Now               time.Time
}

type Negotiation struct {
	ProcessSessionID string
	HelloAck         runnerprotocol.Envelope
	HelloAckBytes    []byte
}

type RecordedEvent struct {
	Receipt      runnerprotocol.Envelope
	ReceiptBytes []byte
	Status       ReceiptStatus
	JobState     JobState
	AttemptState AttemptState
	Duplicate    bool
}

type CancelInput struct {
	WorkspaceID        string
	JobID              string
	CorrelationID      string
	ExpectedAttemptID  string
	ExpectedLeaseID    string
	ExpectedFence      int64
	Reason             string
	IdempotencyKey     string
	RequestFingerprint string
	Now                time.Time
	ExpiresAt          time.Time
}

type CancelControl struct {
	WorkspaceID     string
	JobID           string
	WorkflowRunID   string
	AttemptID       string
	LeaseID         string
	FencingToken    int64
	CancelID        string
	Reason          string
	RequestedAt     time.Time
	ExpiresAt       time.Time
	ControlSequence int64
	Message         runnerprotocol.Envelope
	ExactBytes      []byte
	Duplicate       bool
}

type JobView struct {
	Schema             string                         `json:"schema"`
	WorkspaceID        string                         `json:"workspaceId"`
	JobID              string                         `json:"jobId"`
	WorkflowRunID      string                         `json:"workflowRunId"`
	CorrelationID      string                         `json:"correlationId"`
	State              JobState                       `json:"state"`
	Revision           int64                          `json:"revision"`
	FencingToken       int64                          `json:"fencingToken"`
	AttemptID          *string                        `json:"attemptId"`
	LeaseID            *string                        `json:"leaseId"`
	AttemptState       *AttemptState                  `json:"attemptState"`
	LeaseExpiresAt     *string                        `json:"leaseExpiresAt"`
	TerminalStatus     *runnerprotocol.TerminalStatus `json:"terminalStatus"`
	TerminalReason     *string                        `json:"terminalReason"`
	ResultHash         *string                        `json:"resultHash"`
	OpenEffectCount    int64                          `json:"openEffectCount"`
	ReconciliationID   *string                        `json:"reconciliationId"`
	ReconciliationCode *string                        `json:"reconciliationCode"`
	ExecutionStarted   bool                           `json:"executionStarted"`
	CreatedAt          string                         `json:"createdAt"`
	UpdatedAt          string                         `json:"updatedAt"`
}

type ProcessExitInput struct {
	WorkspaceID  string
	JobID        string
	AttemptID    string
	LeaseID      string
	FencingToken int64
	Class        ProcessExitClass
	ObservedAt   time.Time
}

type AttemptFailureKind string

const (
	AttemptLaunchFailed         AttemptFailureKind = "launch_failed"
	AttemptTerminationUncertain AttemptFailureKind = "termination_uncertain"
)

type AttemptFailureInput struct {
	WorkspaceID  string
	JobID        string
	AttemptID    string
	LeaseID      string
	FencingToken int64
	Kind         AttemptFailureKind
	ObservedAt   time.Time
}

type RecoveryResult struct {
	WorkspaceID       string
	JobID             string
	AttemptID         string
	LeaseID           string
	PreviousFence     int64
	State             JobState
	SafeForNewAttempt bool
}

type RecoverExpiredInput struct {
	Now   time.Time
	Limit int
}

type Statistics struct {
	QueuedJobs            int64
	ActiveLeases          int64
	ExpiredLeases         int64
	Takeovers             int64
	StaleFenceRejects     int64
	ProcessCrashes        int64
	ForcedTerminations    int64
	ReconciliationPending int64
}

type Store interface {
	Submit(context.Context, SubmitInput) (JobReceipt, error)
	ClaimNext(context.Context, ClaimInput) (AttemptLease, error)
	RecordNegotiation(context.Context, NegotiationInput) (Negotiation, error)
	RecordEvent(context.Context, RecordEventInput) (RecordedEvent, error)
	RequestCancel(context.Context, CancelInput) (CancelControl, error)
	PendingCancel(context.Context, string, string, string) (*CancelControl, error)
	MarkControlDelivered(context.Context, string, string, string, time.Time) error
	RecordProcessExit(context.Context, ProcessExitInput) (JobView, error)
	RecoverExpired(context.Context, RecoverExpiredInput) ([]RecoveryResult, error)
	RecoverOrphans(context.Context, string, time.Time, int) ([]RecoveryResult, error)
	ReadJob(context.Context, string, string) (JobView, error)
	Statistics(context.Context) (Statistics, error)
}
