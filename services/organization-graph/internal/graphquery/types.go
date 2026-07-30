package graphquery

import "github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"

type Direction string

const (
	Outgoing Direction = "outgoing"
	Incoming Direction = "incoming"
	Both     Direction = "both"
)

type Input struct {
	ScenarioInstanceID string
	RootNodeIDs        []string
	NodeTypes          []string
	EdgeTypes          []string
	Statuses           []string
	Direction          Direction
	Depth              *int
	MaxNodes           *int
	MaxEdges           *int
	MaxResponseBytes   *int
	IncludeEvidence    *bool
	Cursor             *string
}

type Options struct {
	CursorSecret []byte
	CursorTTLMS  *int64
	NowMS        int64
}

type RelationshipPath struct {
	NodeID  string
	NodeIDs []string
	EdgeIDs []string
}

type Truncation struct {
	Truncated     bool
	NodeLimit     bool
	EdgeLimit     bool
	ByteLimit     bool
	Paginated     bool
	ResponseBytes int
}

type Result struct {
	ScenarioInstanceID string
	SnapshotCursor     string
	QueryHash          string
	Nodes              []graphcontract.Node
	Edges              []graphcontract.Edge
	Paths              []RelationshipPath
	Completeness       graphcontract.Completeness
	Truncation         Truncation
	NextCursor         *string
}

type ExplainInput struct {
	ScenarioInstanceID string
	TargetID           string
	RootNodeID         *string
	Direction          Direction
	Depth              *int
}

type ExplanationTruncation struct {
	SourceEventIDs bool
	EvidenceRefs   bool
	Path           bool
}

type Explanation struct {
	ScenarioInstanceID string
	TargetKind         string
	TargetID           string
	AuthorityRef       *graphcontract.AuthorityRef
	SourceEventIDs     []string
	EvidenceRefs       []string
	ProjectorVersion   string
	ValidFrom          string
	ValidTo            *string
	Completeness       graphcontract.Completeness
	Path               RelationshipPath
	Truncation         ExplanationTruncation
}
