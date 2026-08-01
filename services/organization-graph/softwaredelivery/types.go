// Package softwaredelivery provides the pure Go shadow of the TypeScript-owned
// Software Delivery projector. It accepts only caller-supplied strict JSON and
// performs no I/O, clock reads, or authoritative mutations.
package softwaredelivery

import graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"

const (
	// SourceSchema is the only accepted Software Delivery source schema.
	SourceSchema = "openslack.software_delivery_source_snapshot.v1"
	// ProjectorID is the registered Software Delivery projector identity.
	ProjectorID = "openslack.software_delivery.v1"

	MaxObservationsPerKind = 500
	MaxTotalObservations   = 3_000
	MaxTotalRelations      = 12_000
	MaxSourceBytes         = 4 * 1024 * 1024
	MaxSourceJSONNodes     = 100_000
	MaxSourceProperties    = 128
	MaxSourceArrayItems    = 12_000
	MaxProjectedBytes      = 16 * 1024 * 1024
	MaxLabelsPerIssue      = 50
	MaxRelationsPerItem    = 100
	MaxCompletenessEntries = 50
	MaxTextBytes           = 2_048
)

// Result is a sealed Software Delivery graph projection.
type Result struct {
	ProjectorID string
	Snapshot    graph.Snapshot
}

type evidence struct {
	ID               string
	AuthorityVersion string
	ObservationKind  string
	ObservedAt       string
	SourceEventIDs   []string
	EvidenceRefs     []string
}

type repositoryObservation struct {
	evidence
	RepositoryID  string
	FullName      string
	DefaultBranch string
}

type actorObservation struct {
	evidence
	AuthorityProvider string
	Actor             graph.ActorRef
}

type label struct {
	Name     string
	Category string
}

type issueObservation struct {
	evidence
	RepositoryID      string
	Number            int64
	Title             string
	State             string
	Labels            []label
	AssigneeIDs       []string
	AssigneesComplete bool
	ClosureComplete   bool
	CreatedAt         string
	UpdatedAt         string
	ClosedAt          *string
}

type claimObservation struct {
	evidence
	IssueID      string
	ClaimRef     string
	TargetSHA    *string
	Status       string
	AgentActorID string
	ClaimedAt    string
	ExpiresAt    string
}

type worktreeObservation struct {
	evidence
	IssueID    string
	ClaimID    *string
	AgentRunID *string
	WorktreeID string
	BaseSHA    *string
	BranchName string
	Status     string
	CreatedAt  string
	ClosedAt   *string
}

type commitObservation struct {
	evidence
	RepositoryID string
	SHA          string
	IssueIDs     []string
	WorktreeID   *string
	AuthoredAt   string
}

type pullRequestObservation struct {
	evidence
	RepositoryID  string
	Number        int64
	Title         string
	AuthorActorID string
	State         string
	Draft         bool
	BaseSHA       *string
	HeadSHA       *string
	IssueIDs      []string
	CommitSHAs    []string
	OpenedAt      string
	UpdatedAt     string
}

type checkObservation struct {
	evidence
	PullRequestID string
	Name          string
	Status        string
	Conclusion    *string
	HeadSHA       *string
	StartedAt     string
	CompletedAt   *string
}

type reviewObservation struct {
	evidence
	PullRequestID string
	ActorID       string
	ActorKind     string
	State         string
	CommitOID     *string
	SubmittedAt   string
}

type mergeObservation struct {
	evidence
	PullRequestID  string
	HeadSHA        *string
	MergeCommitSHA *string
	ActorID        string
	MergedAt       string
}

type workflowRunObservation struct {
	evidence
	WorkflowID     string
	Status         string
	IssueIDs       []string
	PullRequestIDs []string
	StartedAt      string
	CompletedAt    *string
}

type agentRunObservation struct {
	evidence
	WorkflowRunID *string
	AgentActorID  string
	Status        string
	WorktreeID    *string
	StartedAt     string
	CompletedAt   *string
}

type prmsReportObservation struct {
	evidence
	PullRequestID string
	BaseSHA       *string
	HeadSHA       *string
	Status        string
	BlockerCount  int64
}

type handoffObservation struct {
	evidence
	Status        string
	FromActorID   string
	ToActorID     string
	IssueID       *string
	PullRequestID *string
	WorkflowRunID *string
	CreatedAt     string
	ClosedAt      *string
}

type decisionObservation struct {
	evidence
	Topic            string
	Status           string
	DecidedByActorID string
	IssueID          *string
	PullRequestID    *string
	WorkflowRunID    *string
	CreatedAt        string
	SupersededAt     *string
}

type sourceBatch[T any] struct {
	Status       string
	BatchVersion *string
	ObservedAt   *string
	Items        []T
	WarningCodes []string
	ReasonCode   string
}

type sourceBatches struct {
	Repository   sourceBatch[repositoryObservation]
	Actors       sourceBatch[actorObservation]
	Issues       sourceBatch[issueObservation]
	Claims       sourceBatch[claimObservation]
	Worktrees    sourceBatch[worktreeObservation]
	Commits      sourceBatch[commitObservation]
	PullRequests sourceBatch[pullRequestObservation]
	Checks       sourceBatch[checkObservation]
	Reviews      sourceBatch[reviewObservation]
	Merges       sourceBatch[mergeObservation]
	WorkflowRuns sourceBatch[workflowRunObservation]
	AgentRuns    sourceBatch[agentRunObservation]
	PRMSReports  sourceBatch[prmsReportObservation]
	Handoffs     sourceBatch[handoffObservation]
	Decisions    sourceBatch[decisionObservation]
}

type sourceSnapshot struct {
	Schema               string
	ScenarioDefinitionID string
	ScenarioInstanceID   string
	Cursor               string
	GeneratedAt          string
	ProjectorVersion     string
	Sources              sourceBatches
	canonicalBytes       int
}
