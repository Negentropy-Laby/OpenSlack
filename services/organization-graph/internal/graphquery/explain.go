package graphquery

import (
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

func findPath(snapshot graphcontract.Snapshot, rootNodeID, targetID, targetKind string, direction Direction, depth int) (*RelationshipPath, error) {
	nodes := map[string]struct{}{}
	for _, node := range snapshot.Nodes {
		nodes[node.ID] = struct{}{}
	}
	if _, exists := nodes[rootNodeID]; !exists {
		return nil, nil
	}
	queue := []RelationshipPath{{NodeID: rootNodeID, NodeIDs: []string{rootNodeID}, EdgeIDs: []string{}}}
	visited := map[string]struct{}{rootNodeID: {}}
	adjacency := buildAdjacency(snapshot.Edges, direction)
	steps := 0
	for len(queue) > 0 {
		path := queue[0]
		queue = queue[1:]
		current := path.NodeIDs[len(path.NodeIDs)-1]
		if targetKind == "node" && current == targetID {
			path.NodeID = targetID
			return &path, nil
		}
		if len(path.EdgeIDs) >= depth {
			continue
		}
		for _, step := range adjacency[current] {
			steps++
			if steps > graphcontract.MaxTraversalSteps {
				return nil, failure(ErrorInvalid, "Graph traversal exceeds its bounded adjacency steps.")
			}
			if _, exists := nodes[step.next]; !exists {
				continue
			}
			nextPath := RelationshipPath{
				NodeID:  step.next,
				NodeIDs: append(append([]string{}, path.NodeIDs...), step.next),
				EdgeIDs: append(append([]string{}, path.EdgeIDs...), step.edge.ID),
			}
			if targetKind == "edge" && step.edge.ID == targetID {
				return &nextPath, nil
			}
			if _, exists := visited[step.next]; !exists {
				visited[step.next] = struct{}{}
				queue = append(queue, nextPath)
			}
		}
	}
	return nil, nil
}

func Explain(snapshotValue graphcontract.Snapshot, input ExplainInput) (Explanation, error) {
	snapshot, err := graphcontract.AssertSnapshotIntegrity(snapshotValue)
	if err != nil {
		return Explanation{}, err
	}
	scenario, err := boundedString(input.ScenarioInstanceID, "scenarioInstanceId")
	if err != nil {
		return Explanation{}, err
	}
	if snapshot.ScenarioInstanceID != scenario {
		return Explanation{}, failure(ErrorInvalid, "Explanation scenario does not match the graph snapshot scope.")
	}
	targetID, err := boundedString(input.TargetID, "targetId")
	if err != nil {
		return Explanation{}, err
	}
	var node *graphcontract.Node
	var edge *graphcontract.Edge
	for index := range snapshot.Nodes {
		if snapshot.Nodes[index].ID == targetID {
			node = &snapshot.Nodes[index]
			break
		}
	}
	for index := range snapshot.Edges {
		if snapshot.Edges[index].ID == targetID {
			edge = &snapshot.Edges[index]
			break
		}
	}
	if node == nil && edge == nil {
		return Explanation{}, failure(ErrorTargetNotFound, "Graph explanation target "+targetID+" does not exist.")
	}
	direction := input.Direction
	if direction == "" {
		direction = Outgoing
	}
	if direction != Outgoing && direction != Incoming && direction != Both {
		return Explanation{}, failure(ErrorInvalid, "direction must be outgoing, incoming, or both.")
	}
	depth, err := integer(input.Depth, graphcontract.MaxDepth, 0, graphcontract.MaxDepth, "depth")
	if err != nil {
		return Explanation{}, err
	}
	root := ""
	if input.RootNodeID != nil {
		root, err = boundedString(*input.RootNodeID, "rootNodeId")
		if err != nil {
			return Explanation{}, err
		}
	} else if node != nil {
		root = node.ID
	} else {
		root = edge.From
	}
	targetKind := "edge"
	if node != nil {
		targetKind = "node"
	}
	path, err := findPath(snapshot, root, targetID, targetKind, direction, depth)
	if err != nil {
		return Explanation{}, err
	}
	if path == nil {
		return Explanation{}, failure(ErrorPathNotFound, "No relationship path reaches "+targetID+" within the requested depth.")
	}
	result := Explanation{
		ScenarioInstanceID: scenario, TargetKind: targetKind, TargetID: targetID,
		Completeness: snapshot.Completeness, Path: *path,
	}
	if node != nil {
		authority := node.AuthorityRef
		result.AuthorityRef = &authority
		result.SourceEventIDs = append([]string{}, node.SourceEventIDs...)
		result.EvidenceRefs = append([]string{}, node.EvidenceRefs...)
		result.ProjectorVersion = node.ProjectorVersion
		result.ValidFrom = node.ValidFrom
		result.ValidTo = node.ValidTo
	} else {
		result.AuthorityRef = edge.AuthorityRef
		result.SourceEventIDs = append([]string{}, edge.SourceEventIDs...)
		result.EvidenceRefs = append([]string{}, edge.EvidenceRefs...)
		result.ProjectorVersion = edge.ProjectorVersion
		result.ValidFrom = edge.ValidFrom
		result.ValidTo = edge.ValidTo
	}
	encoded, err := graphjson.Encode(ExplanationValue(result))
	if err != nil {
		return Explanation{}, err
	}
	if len(encoded) > graphcontract.MaxResponseBytes {
		return Explanation{}, failure(ErrorInvalid, "Graph explanation exceeds its response byte limit.")
	}
	return result, nil
}
