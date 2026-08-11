// Package checkpointshadowstore owns the independent GS9-C checkpoint
// observation spine. It never owns checkpoint or resume decisions.
package checkpointshadowstore

import "context"

const (
	ObservationSchema = "openslack.workflow_checkpoint_shadow_observation.v1"
	EnvelopeSchema    = "openslack.workflow_checkpoint_shadow_envelope.v1"
	ReceiptSchema     = "openslack.workflow_checkpoint_shadow_receipt.v1"
	HeadSchema        = "openslack.workflow_checkpoint_shadow_head.v1"
	IdempotencyPrefix = "openslack.workflow-checkpoint-shadow.v1."
	MaxRequestBytes   = 512 * 1024
	MaxReceiptBytes   = 64 * 1024
	MaxSafeInteger    = int64(9007199254740991)
	MaxSourceSequence = MaxSafeInteger - 1
)

type RunnerBinding struct {
	WorkspaceID     string `json:"workspaceId"`
	JobID           string `json:"jobId"`
	AttemptID       string `json:"attemptId"`
	LeaseID         string `json:"leaseId"`
	FencingToken    int64  `json:"fencingToken"`
	CorrelationID   string `json:"correlationId"`
	RunnerBuildHash string `json:"runnerBuildHash"`
}

type Checkpoint struct {
	CheckpointID      string  `json:"checkpointId"`
	PhaseID           string  `json:"phaseId"`
	PhaseIndex        int64   `json:"phaseIndex"`
	CommitPoint       string  `json:"commitPoint"`
	ArtifactRef       string  `json:"artifactRef"`
	ArtifactHash      string  `json:"artifactHash"`
	ResultHash        *string `json:"resultHash"`
	CacheKeyHash      *string `json:"cacheKeyHash"`
	CommittedRevision int64   `json:"committedRevision"`
	ResumeGeneration  int64   `json:"resumeGeneration"`
	CommittedAt       string  `json:"committedAt"`
}

type Operation string

const (
	OperationCheckpointCommit Operation = "checkpoint_commit"
	OperationResumeAdvance    Operation = "resume_advance"
)

type Observation struct {
	Schema             string        `json:"schema"`
	Authority          string        `json:"authority"`
	GoRole             string        `json:"goRole"`
	RunID              string        `json:"runId"`
	Revision           int64         `json:"revision"`
	ResumeGeneration   int64         `json:"resumeGeneration"`
	WorkflowSourceHash string        `json:"workflowSourceHash"`
	ManifestHash       string        `json:"manifestHash"`
	InputHash          string        `json:"inputHash"`
	Runner             RunnerBinding `json:"runner"`
	Checkpoint         *Checkpoint   `json:"checkpoint"`
	PriorCheckpoint    *Checkpoint   `json:"priorCheckpoint"`
	NextPhaseID        *string       `json:"nextPhaseId"`
	NextPhaseIndex     *int64        `json:"nextPhaseIndex"`
}

type Envelope struct {
	Schema          string      `json:"schema"`
	GoRole          string      `json:"goRole"`
	SourceSequence  int64       `json:"sourceSequence"`
	Operation       Operation   `json:"operation"`
	Observation     Observation `json:"observation"`
	ObservationHash string      `json:"observationHash"`
}

type PreparedObservation struct {
	Envelope         Envelope
	ExactBody        []byte
	EnvelopeHash     string
	ObservationBytes []byte
}

type ObserveInput struct {
	Prepared           PreparedObservation
	IdempotencyKey     string
	RequestFingerprint string
	ServiceBuildHash   string
}

type ReceiptValue struct {
	Schema              string    `json:"schema"`
	Status              string    `json:"status"`
	IdempotencyKey      string    `json:"idempotencyKey"`
	ReceiptID           string    `json:"receiptId"`
	ObservationID       *string   `json:"observationId"`
	WorkspaceID         string    `json:"workspaceId"`
	RunID               string    `json:"runId"`
	SourceSequence      int64     `json:"sourceSequence"`
	Operation           Operation `json:"operation"`
	Parity              string    `json:"parity"`
	MismatchCode        *string   `json:"mismatchCode"`
	ReconciliationToken *string   `json:"reconciliationToken"`
	EnvelopeHash        string    `json:"envelopeHash"`
	ObservationHash     string    `json:"observationHash"`
	ServiceBuildHash    string    `json:"serviceBuildHash"`
	CommittedAt         *string   `json:"committedAt"`
}

type Receipt struct {
	Value      ReceiptValue
	ExactBytes []byte
	Replay     bool
}

type Head struct {
	Schema                string       `json:"schema"`
	GoRole                string       `json:"goRole"`
	WorkspaceID           string       `json:"workspaceId"`
	RunID                 string       `json:"runId"`
	SourceSequence        int64        `json:"sourceSequence"`
	Operation             Operation    `json:"operation"`
	MatchedSourceSequence *int64       `json:"matchedSourceSequence"`
	MismatchLatched       bool         `json:"mismatchLatched"`
	ObservationHash       *string      `json:"observationHash"`
	Observation           *Observation `json:"observation"`
	UpdatedAt             string       `json:"updatedAt"`
}

type Statistics struct{ Runs, Observations, Receipts, ReconciliationPending int64 }

type Store interface {
	Observe(context.Context, ObserveInput) (Receipt, error)
	ReadHead(context.Context, string, string) (Head, error)
	ReadReceipt(context.Context, string, string) (Receipt, error)
	Ready(context.Context) error
	Statistics(context.Context) (Statistics, error)
}
