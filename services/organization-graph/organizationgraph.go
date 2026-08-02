// Package organizationgraph provides the pure Organization Graph contract,
// integrity, query, cursor, pagination, and explanation behavior.
package organizationgraph

import (
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphquery"
)

const (
	SnapshotSchema       = graphcontract.SnapshotSchema
	DeltaSchema          = graphcontract.DeltaSchema
	MaxDepth             = graphcontract.MaxDepth
	MaxNodes             = graphcontract.MaxNodes
	MaxEdges             = graphcontract.MaxEdges
	MaxResponseBytes     = graphcontract.MaxResponseBytes
	MaxPropertyDepth     = graphcontract.MaxPropertyDepth
	MaxPropertyKeys      = graphcontract.MaxPropertyKeys
	MaxPropertyItems     = graphcontract.MaxPropertyItems
	MaxEvidenceRefs      = graphcontract.MaxEvidenceRefs
	MaxOwners            = graphcontract.MaxOwners
	MaxSourceEventIDs    = graphcontract.MaxSourceEventIDs
	MaxSnapshotNodes     = graphcontract.MaxSnapshotNodes
	MaxSnapshotEdges     = graphcontract.MaxSnapshotEdges
	MaxDeltaEvidenceRefs = graphcontract.MaxDeltaEvidenceRefs
	MaxTraversalSteps    = graphcontract.MaxTraversalSteps

	MaxBoundedStringCharacters       = graphcontract.MaxBoundedStringCharacters
	MaxIdentifierCharacters          = graphcontract.MaxIdentifierCharacters
	MaxDateTimeCharacters            = graphcontract.MaxDateTimeCharacters
	MaxAuthorityObjectTypeCharacters = graphcontract.MaxAuthorityObjectTypeCharacters
	MaxPropertyStringCharacters      = graphcontract.MaxPropertyStringCharacters
	MaxCompletenessItems             = graphcontract.MaxCompletenessItems
	MaxQueryFilterItems              = graphcontract.MaxQueryFilterItems

	DefaultCursorTTLMS            = graphquery.DefaultCursorTTLMS
	MinCursorTTLMS                = graphquery.MinCursorTTLMS
	MaxCursorTTLMS                = graphquery.MaxCursorTTLMS
	MinQueryResponseBytes         = graphquery.MinResponseBytes
	CursorCharacters              = graphquery.CursorCharacters
	CursorSecretMinBytes          = graphquery.CursorSecretMinBytes
	CursorSecretMaxBytes          = graphquery.CursorSecretMaxBytes
	CursorPayloadDepth            = graphquery.CursorPayloadDepth
	CursorPayloadNodes            = graphquery.CursorPayloadNodes
	CursorPayloadStringCharacters = graphquery.CursorPayloadStringCharacters
)

const (
	AlgorithmStrictJSON         = "openslack.strict_graph_json.v1"
	AlgorithmCanonicalJSON      = "openslack.ecmascript_canonical_json.v1"
	AlgorithmNodeIdentity       = "openslack.graph_node_identity.sha256.v1"
	AlgorithmEdgeIdentity       = "openslack.graph_edge_identity.sha256.v1"
	AlgorithmSnapshotIntegrity  = "openslack.graph_snapshot_integrity.sha256.v1"
	AlgorithmDeltaIntegrity     = "openslack.graph_delta_integrity.sha256.v1"
	AlgorithmQueryNormalization = "openslack.graph_query_normalization.v1"
	AlgorithmQueryCursor        = "openslack.graph_query_cursor.hmac_sha256.v1"
	AlgorithmExplain            = "openslack.graph_explain.v1"
)

type (
	Value                  = graphjson.Value
	Array                  = graphjson.Array
	Object                 = graphjson.Object
	UndefinedValue         = graphjson.UndefinedValue
	SparseArray            = graphjson.SparseArray
	JSONLimits             = graphjson.Limits
	JSONError              = graphjson.Error
	JSONErrorCode          = graphjson.ErrorCode
	CanonicalJSONError     = graphjson.CanonicalError
	CanonicalJSONErrorCode = graphjson.CanonicalErrorCode

	AuthorityRef      = graphcontract.AuthorityRef
	ActorRef          = graphcontract.ActorRef
	Node              = graphcontract.Node
	Edge              = graphcontract.Edge
	Completeness      = graphcontract.Completeness
	Snapshot          = graphcontract.Snapshot
	Delta             = graphcontract.Delta
	ContractError     = graphcontract.Error
	ContractErrorCode = graphcontract.ErrorCode

	Direction             = graphquery.Direction
	QueryInput            = graphquery.Input
	QueryOptions          = graphquery.Options
	RelationshipPath      = graphquery.RelationshipPath
	QueryTruncation       = graphquery.Truncation
	QueryResult           = graphquery.Result
	ExplainInput          = graphquery.ExplainInput
	ExplanationTruncation = graphquery.ExplanationTruncation
	Explanation           = graphquery.Explanation
	QueryError            = graphquery.Error
	QueryErrorCode        = graphquery.ErrorCode
)

const (
	DirectionOutgoing = graphquery.Outgoing
	DirectionIncoming = graphquery.Incoming
	DirectionBoth     = graphquery.Both
)

const (
	JSONUTF8Invalid   = graphjson.ErrorUTF8Invalid
	JSONBOMForbidden  = graphjson.ErrorBOMForbidden
	JSONSyntaxInvalid = graphjson.ErrorSyntax
	JSONDuplicateKey  = graphjson.ErrorDuplicateKey
	JSONLimitExceeded = graphjson.ErrorLimit

	CanonicalJSONNonFinite   = graphjson.CanonicalNonFinite
	CanonicalJSONUnsupported = graphjson.CanonicalUnsupported
	CanonicalJSONForbidden   = graphjson.CanonicalForbidden
	CanonicalJSONUndefined   = graphjson.CanonicalUndefined
	CanonicalJSONSparseArray = graphjson.CanonicalSparseArray

	ContractSchemaInvalid    = graphcontract.ErrorSchemaInvalid
	ContractBoundExceeded    = graphcontract.ErrorBoundExceeded
	ContractScopeInvalid     = graphcontract.ErrorScopeInvalid
	ContractReferenceInvalid = graphcontract.ErrorReferenceInvalid
	ContractPropertyUnsafe   = graphcontract.ErrorPropertyUnsafe
	ContractIntegrityInvalid = graphcontract.ErrorIntegrityInvalid

	QueryInvalid        = graphquery.ErrorInvalid
	QueryCursorInvalid  = graphquery.ErrorCursorInvalid
	QueryCursorExpired  = graphquery.ErrorCursorExpired
	QueryCursorMismatch = graphquery.ErrorCursorMismatch
	QueryTargetNotFound = graphquery.ErrorTargetNotFound
	QueryPathNotFound   = graphquery.ErrorPathNotFound
)

func ParseCanonicalJSON(input []byte, limits JSONLimits) (Value, error) {
	return graphjson.Parse(input, limits)
}

func DefaultJSONLimits() JSONLimits { return graphjson.DefaultLimits() }

func JSONLimit(value int) *int { return graphjson.Limit(value) }

func CanonicalJSON(value Value) ([]byte, error) { return graphjson.Encode(value) }

func AuthorityProviders() []string { return graphcontract.AuthorityProviders() }

func ParseSnapshot(input []byte) (Snapshot, error) { return graphcontract.ParseSnapshot(input) }
func ParseDelta(input []byte) (Delta, error)       { return graphcontract.ParseDelta(input) }

func SnapshotFromValue(input Value) (Snapshot, error) {
	return graphcontract.SnapshotFromValue(input)
}

func DeltaFromValue(input Value) (Delta, error) {
	return graphcontract.DeltaFromValue(input)
}

func SnapshotValue(value Snapshot) Object { return graphcontract.SnapshotValue(value) }
func DeltaValue(value Delta) Object       { return graphcontract.DeltaValue(value) }

func ValidateSnapshot(value Snapshot) error { return graphcontract.ValidateSnapshot(value) }
func ValidateDelta(value Delta) error       { return graphcontract.ValidateDelta(value) }

func DeriveNodeID(scenarioInstanceID, nodeType string, authority AuthorityRef) (string, error) {
	return graphcontract.DeriveNodeID(scenarioInstanceID, nodeType, authority)
}

func DeriveEdgeID(scenarioInstanceID, edgeType, from, to string, authority *AuthorityRef) (string, error) {
	return graphcontract.DeriveEdgeID(scenarioInstanceID, edgeType, from, to, authority)
}

func CanonicalizeSnapshot(value Snapshot) (Snapshot, error) {
	return graphcontract.CanonicalizeSnapshot(value)
}

func CanonicalizeDelta(value Delta) (Delta, error) {
	return graphcontract.CanonicalizeDelta(value)
}

func CanonicalizeCompleteness(value Completeness) Completeness {
	return graphcontract.CanonicalCompleteness(value)
}

func CalculateSnapshotIntegrity(value Snapshot) (string, error) {
	return graphcontract.CalculateSnapshotIntegrity(value)
}

func CalculateDeltaIntegrity(value Delta) (string, error) {
	return graphcontract.CalculateDeltaIntegrity(value)
}

func SealSnapshot(value Snapshot) (Snapshot, error) { return graphcontract.SealSnapshot(value) }
func SealDelta(value Delta) (Delta, error)          { return graphcontract.SealDelta(value) }

func VerifySnapshotIntegrity(value Snapshot) (bool, error) {
	return graphcontract.VerifySnapshotIntegrity(value)
}

func VerifyDeltaIntegrity(value Delta) (bool, error) {
	return graphcontract.VerifyDeltaIntegrity(value)
}

func AssertSnapshotIntegrity(value Snapshot) (Snapshot, error) {
	return graphcontract.AssertSnapshotIntegrity(value)
}

func AssertDeltaIntegrity(value Delta) (Delta, error) {
	return graphcontract.AssertDeltaIntegrity(value)
}

func SerializeSnapshot(value Snapshot) ([]byte, error) {
	return graphcontract.SerializeSnapshot(value)
}

func SerializeDelta(value Delta) ([]byte, error) {
	return graphcontract.SerializeDelta(value)
}

func Query(snapshot Snapshot, input QueryInput, options QueryOptions) (QueryResult, error) {
	return graphquery.Query(snapshot, input, options)
}

func SerializeQueryResult(value QueryResult) ([]byte, error) {
	return graphjson.Encode(graphquery.ResultValue(value))
}

func QueryResultValue(value QueryResult) Object { return graphquery.ResultValue(value) }

func QueryHash(input QueryInput) (string, error) {
	return graphquery.GraphQueryHash(input)
}

func Explain(snapshot Snapshot, input ExplainInput) (Explanation, error) {
	return graphquery.Explain(snapshot, input)
}

func SerializeExplanation(value Explanation) ([]byte, error) {
	return graphjson.Encode(graphquery.ExplanationValue(value))
}

func ExplanationValue(value Explanation) Object { return graphquery.ExplanationValue(value) }
