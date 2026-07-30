package graphcontract

import (
	"sort"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

func less(left, right string) bool {
	return graphjson.UTF16Less(left, right)
}

func sortedUnique(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Slice(result, func(left, right int) bool { return less(result[left], result[right]) })
	return result
}

func canonicalProperties(value graphjson.Value) graphjson.Value {
	switch current := value.(type) {
	case graphjson.Array:
		result := make(graphjson.Array, len(current))
		for index, item := range current {
			result[index] = canonicalProperties(item)
		}
		return result
	case graphjson.Object:
		result := make(graphjson.Object, len(current))
		for key, item := range current {
			result[key] = canonicalProperties(item)
		}
		return result
	default:
		return current
	}
}

func cloneOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func cloneOptionalAuthority(value *AuthorityRef) *AuthorityRef {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func canonicalOwners(values []ActorRef) ([]ActorRef, error) {
	keyed := make(map[string]ActorRef, len(values))
	for _, value := range values {
		value.DisplayName = cloneOptionalString(value.DisplayName)
		encoded, err := graphjson.Encode(ActorValue(value))
		if err != nil {
			return nil, err
		}
		keyed[string(encoded)] = value
	}
	result := make([]ActorRef, 0, len(keyed))
	for _, value := range keyed {
		result = append(result, value)
	}
	sort.Slice(result, func(left, right int) bool {
		leftName, rightName := "", ""
		if result[left].DisplayName != nil {
			leftName = *result[left].DisplayName
		}
		if result[right].DisplayName != nil {
			rightName = *result[right].DisplayName
		}
		return less(
			result[left].Kind+"\x00"+result[left].ID+"\x00"+leftName,
			result[right].Kind+"\x00"+result[right].ID+"\x00"+rightName,
		)
	})
	return result, nil
}

func canonicalNode(value Node) (Node, error) {
	owners, err := canonicalOwners(value.Owners)
	if err != nil {
		return Node{}, err
	}
	value.Owners = owners
	value.Status = cloneOptionalString(value.Status)
	value.ValidTo = cloneOptionalString(value.ValidTo)
	value.Properties = canonicalProperties(value.Properties).(graphjson.Object)
	value.SourceEventIDs = sortedUnique(value.SourceEventIDs)
	value.EvidenceRefs = sortedUnique(value.EvidenceRefs)
	return value, nil
}

func canonicalEdge(value Edge) Edge {
	value.AuthorityRef = cloneOptionalAuthority(value.AuthorityRef)
	value.ValidTo = cloneOptionalString(value.ValidTo)
	value.SourceEventIDs = sortedUnique(value.SourceEventIDs)
	value.EvidenceRefs = sortedUnique(value.EvidenceRefs)
	return value
}

func CanonicalCompleteness(value Completeness) Completeness {
	value.SourcesRequested = sortedUnique(value.SourcesRequested)
	value.SourcesObserved = sortedUnique(value.SourcesObserved)
	value.MissingSources = sortedUnique(value.MissingSources)
	value.Warnings = sortedUnique(value.Warnings)
	return value
}

func CanonicalizeSnapshot(value Snapshot) (Snapshot, error) {
	if err := ValidateSnapshot(value); err != nil {
		return Snapshot{}, err
	}
	result := value
	result.Nodes = make([]Node, len(value.Nodes))
	for index, node := range value.Nodes {
		canonical, err := canonicalNode(node)
		if err != nil {
			return Snapshot{}, err
		}
		result.Nodes[index] = canonical
	}
	sort.Slice(result.Nodes, func(left, right int) bool { return less(result.Nodes[left].ID, result.Nodes[right].ID) })
	result.Edges = make([]Edge, len(value.Edges))
	for index, edge := range value.Edges {
		result.Edges[index] = canonicalEdge(edge)
	}
	sort.Slice(result.Edges, func(left, right int) bool { return less(result.Edges[left].ID, result.Edges[right].ID) })
	result.Completeness = CanonicalCompleteness(value.Completeness)
	return result, nil
}

func CanonicalizeDelta(value Delta) (Delta, error) {
	if err := ValidateDelta(value); err != nil {
		return Delta{}, err
	}
	result := value
	result.UpsertNodes = make([]Node, len(value.UpsertNodes))
	for index, node := range value.UpsertNodes {
		canonical, err := canonicalNode(node)
		if err != nil {
			return Delta{}, err
		}
		result.UpsertNodes[index] = canonical
	}
	sort.Slice(result.UpsertNodes, func(left, right int) bool {
		return less(result.UpsertNodes[left].ID, result.UpsertNodes[right].ID)
	})
	result.CloseNodeIDs = sortedUnique(value.CloseNodeIDs)
	result.UpsertEdges = make([]Edge, len(value.UpsertEdges))
	for index, edge := range value.UpsertEdges {
		result.UpsertEdges[index] = canonicalEdge(edge)
	}
	sort.Slice(result.UpsertEdges, func(left, right int) bool {
		return less(result.UpsertEdges[left].ID, result.UpsertEdges[right].ID)
	})
	result.CloseEdgeIDs = sortedUnique(value.CloseEdgeIDs)
	result.EvidenceRefs = sortedUnique(value.EvidenceRefs)
	return result, nil
}
