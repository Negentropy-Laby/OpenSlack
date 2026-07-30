package graphcontract

import "github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"

const (
	SnapshotSchema = "openslack.graph_snapshot.v1"
	DeltaSchema    = "openslack.graph_delta.v1"
)

func AuthorityProviders() []string {
	return []string{"github", "openslack", "demo_fixture", "dingtalk", "crm", "erp", "hr"}
}

const (
	MaxDepth             = 3
	MaxNodes             = 200
	MaxEdges             = 500
	MaxResponseBytes     = 512 * 1024
	MaxPropertyDepth     = 8
	MaxPropertyKeys      = 64
	MaxPropertyItems     = 200
	MaxEvidenceRefs      = 50
	MaxOwners            = 50
	MaxSourceEventIDs    = 50
	MaxSnapshotNodes     = 10_000
	MaxSnapshotEdges     = 25_000
	MaxDeltaEvidenceRefs = 200
	MaxTraversalSteps    = 100_000
)

const (
	MaxBoundedStringCharacters       = 2_048
	MaxIdentifierCharacters          = 512
	MaxDateTimeCharacters            = 64
	MaxAuthorityObjectTypeCharacters = 256
	MaxPropertyStringCharacters      = 32_768
	MaxCompletenessItems             = 50
	MaxQueryFilterItems              = 50
)

type AuthorityRef struct {
	Provider   string
	ObjectType string
	ObjectID   string
	Version    string
	ObservedAt string
}

type ActorRef struct {
	ID          string
	Kind        string
	DisplayName *string
}

type Node struct {
	ID                   string
	Type                 string
	ScenarioDefinitionID string
	ScenarioInstanceID   string
	Title                string
	Status               *string
	AuthorityRef         AuthorityRef
	Owners               []ActorRef
	Properties           graphjson.Object
	SourceEventIDs       []string
	EvidenceRefs         []string
	ProjectorVersion     string
	ValidFrom            string
	ValidTo              *string
}

type Edge struct {
	ID                 string
	Type               string
	From               string
	To                 string
	ScenarioInstanceID string
	AuthorityRef       *AuthorityRef
	SourceEventIDs     []string
	EvidenceRefs       []string
	ProjectorVersion   string
	ValidFrom          string
	ValidTo            *string
}

type Completeness struct {
	SourcesRequested []string
	SourcesObserved  []string
	MissingSources   []string
	Warnings         []string
}

type Snapshot struct {
	Schema             string
	Cursor             string
	ScenarioInstanceID string
	GeneratedAt        string
	ProjectorVersion   string
	Nodes              []Node
	Edges              []Edge
	Completeness       Completeness
	IntegrityHash      string
}

type Delta struct {
	Schema             string
	ScenarioInstanceID string
	FromCursor         string
	ToCursor           string
	GeneratedAt        string
	UpsertNodes        []Node
	CloseNodeIDs       []string
	UpsertEdges        []Edge
	CloseEdgeIDs       []string
	EvidenceRefs       []string
	IntegrityHash      string
}
