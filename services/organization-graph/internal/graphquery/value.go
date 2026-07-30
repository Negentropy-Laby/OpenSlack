package graphquery

import (
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

func pathValue(value RelationshipPath) graphjson.Object {
	return graphjson.Object{"nodeId": value.NodeID, "nodeIds": stringsValue(value.NodeIDs), "edgeIds": stringsValue(value.EdgeIDs)}
}

func ResultValue(value Result) graphjson.Object {
	nodes := make(graphjson.Array, len(value.Nodes))
	for index, node := range value.Nodes {
		nodes[index] = graphcontract.NodeValue(node)
	}
	edges := make(graphjson.Array, len(value.Edges))
	for index, edge := range value.Edges {
		edges[index] = graphcontract.EdgeValue(edge)
	}
	paths := make(graphjson.Array, len(value.Paths))
	for index, path := range value.Paths {
		paths[index] = pathValue(path)
	}
	result := graphjson.Object{
		"scenarioInstanceId": value.ScenarioInstanceID, "snapshotCursor": value.SnapshotCursor,
		"queryHash": value.QueryHash, "nodes": nodes, "edges": edges, "paths": paths,
		"completeness": graphcontract.CompletenessValue(value.Completeness),
		"truncation": graphjson.Object{
			"truncated": value.Truncation.Truncated, "nodeLimit": value.Truncation.NodeLimit,
			"edgeLimit": value.Truncation.EdgeLimit, "byteLimit": value.Truncation.ByteLimit,
			"paginated": value.Truncation.Paginated, "responseBytes": float64(value.Truncation.ResponseBytes),
		},
	}
	if value.NextCursor != nil {
		result["nextCursor"] = *value.NextCursor
	}
	return result
}

func ExplanationValue(value Explanation) graphjson.Object {
	result := graphjson.Object{
		"scenarioInstanceId": value.ScenarioInstanceID, "targetKind": value.TargetKind,
		"targetId": value.TargetID, "sourceEventIds": stringsValue(value.SourceEventIDs),
		"evidenceRefs": stringsValue(value.EvidenceRefs), "projectorVersion": value.ProjectorVersion,
		"validFrom": value.ValidFrom, "completeness": graphcontract.CompletenessValue(value.Completeness),
		"path": pathValue(value.Path), "truncation": graphjson.Object{
			"sourceEventIds": value.Truncation.SourceEventIDs, "evidenceRefs": value.Truncation.EvidenceRefs,
			"path": value.Truncation.Path,
		},
	}
	if value.AuthorityRef != nil {
		result["authorityRef"] = graphcontract.AuthorityValue(*value.AuthorityRef)
	}
	if value.ValidTo != nil {
		result["validTo"] = *value.ValidTo
	}
	return result
}

func stringsValue(values []string) graphjson.Array {
	result := make(graphjson.Array, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}
