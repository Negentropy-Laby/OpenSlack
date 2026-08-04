package authoritycontract

type Route struct {
	Backend            string `json:"backend"`
	Authority          string `json:"authority"`
	RoutingEpoch       int64  `json:"routingEpoch"`
	AuthorityBuildHash string `json:"authorityBuildHash"`
}

type CheckpointHead struct {
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
}

type LegacyRunGate struct {
	Plane                   string         `json:"plane"`
	Status                  ApprovalStatus `json:"status"`
	Revision                int64          `json:"revision"`
	EffectDecisionAuthority bool           `json:"effectDecisionAuthority"`
}

type EffectV2Approval struct {
	Plane        string         `json:"plane"`
	Schema       string         `json:"schema"`
	Status       ApprovalStatus `json:"status"`
	Revision     int64          `json:"revision"`
	ApprovalHash *string        `json:"approvalHash"`
}

type Approvals struct {
	LegacyRunGate LegacyRunGate    `json:"legacyRunGate"`
	EffectV2      EffectV2Approval `json:"effectV2"`
}

type Budget struct {
	PolicyHash          string   `json:"policyHash"`
	TokenLimit          Quantity `json:"tokenLimit"`
	CostLimitNanoUSD    Quantity `json:"costLimitNanoUsd"`
	CallLimit           Quantity `json:"callLimit"`
	ReservedTokens      Quantity `json:"reservedTokens"`
	SettledTokens       Quantity `json:"settledTokens"`
	ReservedCostNanoUSD Quantity `json:"reservedCostNanoUsd"`
	SettledCostNanoUSD  Quantity `json:"settledCostNanoUsd"`
	ReservedCalls       Quantity `json:"reservedCalls"`
	SettledCalls        Quantity `json:"settledCalls"`
}

// State is a validated mirror of the TypeScript-owned v2 authority state. It
// is an inert value; this package has no store and cannot commit a revision.
type State struct {
	Schema                 string          `json:"schema"`
	ContractVersion        string          `json:"contractVersion"`
	ContractAuthority      string          `json:"contractAuthority"`
	GoRole                 string          `json:"goRole"`
	AuthorityClaim         string          `json:"authorityClaim"`
	WorkspaceID            string          `json:"workspaceId"`
	RunID                  string          `json:"runId"`
	WorkflowID             string          `json:"workflowId"`
	WorkflowVersion        string          `json:"workflowVersion"`
	WorkflowSourceHash     string          `json:"workflowSourceHash"`
	ManifestHash           string          `json:"manifestHash"`
	InputHash              string          `json:"inputHash"`
	Route                  Route           `json:"route"`
	State                  RunState        `json:"state"`
	Revision               int64           `json:"revision"`
	ResumeGeneration       int64           `json:"resumeGeneration"`
	CurrentPhaseID         *string         `json:"currentPhaseId"`
	CurrentPhaseIndex      *int64          `json:"currentPhaseIndex"`
	CheckpointHead         *CheckpointHead `json:"checkpointHead"`
	Approvals              Approvals       `json:"approvals"`
	Budget                 Budget          `json:"budget"`
	ReconciliationRequired bool            `json:"reconciliationRequired"`
	UpdatedAt              string          `json:"updatedAt"`
}

type Message struct {
	Schema             string         `json:"schema"`
	ProtocolVersion    string         `json:"protocolVersion"`
	Kind               Kind           `json:"kind"`
	WorkspaceID        string         `json:"workspaceId"`
	JobID              *string        `json:"jobId"`
	WorkflowRunID      *string        `json:"workflowRunId"`
	AttemptID          *string        `json:"attemptId"`
	LeaseID            *string        `json:"leaseId"`
	FencingToken       *int64         `json:"fencingToken"`
	Sequence           *int64         `json:"sequence"`
	AuthorityBackend   *string        `json:"authorityBackend"`
	Authority          *string        `json:"authority"`
	RoutingEpoch       *int64         `json:"routingEpoch"`
	AuthorityBuildHash *string        `json:"authorityBuildHash"`
	RunRevision        *int64         `json:"runRevision"`
	ResumeGeneration   *int64         `json:"resumeGeneration"`
	EventID            string         `json:"eventId"`
	CorrelationID      string         `json:"correlationId"`
	SentAt             string         `json:"sentAt"`
	Payload            map[string]any `json:"payload"`
}

type PreparedMessage struct {
	Schema             string    `json:"schema"`
	Direction          Direction `json:"direction"`
	Body               string    `json:"body"`
	MessageDigest      string    `json:"messageDigest"`
	IdempotencyKey     string    `json:"idempotencyKey"`
	RequestFingerprint string    `json:"requestFingerprint"`
}

type Receipt struct {
	Schema              string           `json:"schema"`
	Operation           ReceiptOperation `json:"operation"`
	Status              ReceiptStatus    `json:"status"`
	WorkspaceID         string           `json:"workspaceId"`
	RunID               string           `json:"runId"`
	ExpectedRevision    int64            `json:"expectedRevision"`
	AcceptedRevision    *int64           `json:"acceptedRevision"`
	ResumeGeneration    int64            `json:"resumeGeneration"`
	Route               Route            `json:"route"`
	IdempotencyKey      string           `json:"idempotencyKey"`
	RequestFingerprint  string           `json:"requestFingerprint"`
	RequestHash         string           `json:"requestHash"`
	RecordHash          *string          `json:"recordHash"`
	CorrelationID       string           `json:"correlationId"`
	ServiceBuildHash    string           `json:"serviceBuildHash"`
	CommittedAt         *string          `json:"committedAt"`
	ReconciliationToken *string          `json:"reconciliationToken"`
}
