package graphcontract

import "github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"

func AuthorityValue(value AuthorityRef) graphjson.Object {
	return graphjson.Object{
		"provider": value.Provider, "objectType": value.ObjectType, "objectId": value.ObjectID,
		"version": value.Version, "observedAt": value.ObservedAt,
	}
}

func ActorValue(value ActorRef) graphjson.Object {
	result := graphjson.Object{"id": value.ID, "kind": value.Kind}
	if value.DisplayName != nil {
		result["displayName"] = *value.DisplayName
	}
	return result
}

func NodeValue(value Node) graphjson.Object {
	owners := make(graphjson.Array, len(value.Owners))
	for index, owner := range value.Owners {
		owners[index] = ActorValue(owner)
	}
	result := graphjson.Object{
		"id": value.ID, "type": value.Type, "scenarioDefinitionId": value.ScenarioDefinitionID,
		"scenarioInstanceId": value.ScenarioInstanceID, "title": value.Title,
		"authorityRef": AuthorityValue(value.AuthorityRef), "owners": owners,
		"properties": value.Properties, "sourceEventIds": stringsValue(value.SourceEventIDs),
		"evidenceRefs": stringsValue(value.EvidenceRefs), "projectorVersion": value.ProjectorVersion,
		"validFrom": value.ValidFrom,
	}
	if value.Status != nil {
		result["status"] = *value.Status
	}
	if value.ValidTo != nil {
		result["validTo"] = *value.ValidTo
	}
	return result
}

func EdgeValue(value Edge) graphjson.Object {
	result := graphjson.Object{
		"id": value.ID, "type": value.Type, "from": value.From, "to": value.To,
		"scenarioInstanceId": value.ScenarioInstanceID, "sourceEventIds": stringsValue(value.SourceEventIDs),
		"evidenceRefs": stringsValue(value.EvidenceRefs), "projectorVersion": value.ProjectorVersion,
		"validFrom": value.ValidFrom,
	}
	if value.AuthorityRef != nil {
		result["authorityRef"] = AuthorityValue(*value.AuthorityRef)
	}
	if value.ValidTo != nil {
		result["validTo"] = *value.ValidTo
	}
	return result
}

func CompletenessValue(value Completeness) graphjson.Object {
	return graphjson.Object{
		"sourcesRequested": stringsValue(value.SourcesRequested),
		"sourcesObserved":  stringsValue(value.SourcesObserved),
		"missingSources":   stringsValue(value.MissingSources),
		"warnings":         stringsValue(value.Warnings),
	}
}

func SnapshotValue(value Snapshot) graphjson.Object {
	nodes := make(graphjson.Array, len(value.Nodes))
	for index, node := range value.Nodes {
		nodes[index] = NodeValue(node)
	}
	edges := make(graphjson.Array, len(value.Edges))
	for index, edge := range value.Edges {
		edges[index] = EdgeValue(edge)
	}
	return graphjson.Object{
		"schema": value.Schema, "cursor": value.Cursor, "scenarioInstanceId": value.ScenarioInstanceID,
		"generatedAt": value.GeneratedAt, "projectorVersion": value.ProjectorVersion,
		"nodes": nodes, "edges": edges, "completeness": CompletenessValue(value.Completeness),
		"integrityHash": value.IntegrityHash,
	}
}

func DeltaValue(value Delta) graphjson.Object {
	nodes := make(graphjson.Array, len(value.UpsertNodes))
	for index, node := range value.UpsertNodes {
		nodes[index] = NodeValue(node)
	}
	edges := make(graphjson.Array, len(value.UpsertEdges))
	for index, edge := range value.UpsertEdges {
		edges[index] = EdgeValue(edge)
	}
	return graphjson.Object{
		"schema": value.Schema, "scenarioInstanceId": value.ScenarioInstanceID,
		"fromCursor": value.FromCursor, "toCursor": value.ToCursor, "generatedAt": value.GeneratedAt,
		"upsertNodes": nodes, "closeNodeIds": stringsValue(value.CloseNodeIDs),
		"upsertEdges": edges, "closeEdgeIds": stringsValue(value.CloseEdgeIDs),
		"evidenceRefs": stringsValue(value.EvidenceRefs), "integrityHash": value.IntegrityHash,
	}
}

func stringsValue(values []string) graphjson.Array {
	result := make(graphjson.Array, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}
