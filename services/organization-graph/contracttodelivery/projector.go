package contracttodelivery

import (
	"errors"
	"fmt"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/softwaredelivery"
)

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sortUTF16(result)
	return result
}

func boundedCompleteness(values []string, suffix string) []string {
	result := uniqueSorted(values)
	if len(result) <= MaxCompletenessEntries {
		return result
	}
	result = append(result[:MaxCompletenessEntries-1], "contract-to-delivery."+suffix+".truncated")
	sortUTF16(result)
	return result
}

func authorityEqual(left, right graph.AuthorityRef) bool {
	return left.Provider == right.Provider && left.ObjectType == right.ObjectType &&
		left.ObjectID == right.ObjectID && left.Version == right.Version && left.ObservedAt == right.ObservedAt
}

func statusPointer(value string) *string { return &value }

func nodeFrom(source sourceSnapshot, observation businessEvidence, typeName, status string, properties graph.Object) (graph.Node, error) {
	if status == "" {
		status = observation.Status
	}
	node := graph.Node{
		Type:                 typeName,
		ScenarioDefinitionID: source.ScenarioDefinitionID,
		ScenarioInstanceID:   source.ScenarioInstanceID,
		Title:                observation.Title,
		Status:               statusPointer(status),
		AuthorityRef:         observation.AuthorityRef,
		Owners:               []graph.ActorRef{},
		Properties:           properties,
		SourceEventIDs:       uniqueSorted(observation.SourceEventIDs),
		EvidenceRefs:         uniqueSorted(observation.EvidenceRefs),
		ProjectorVersion:     ProjectorID,
		ValidFrom:            observation.AuthorityRef.ObservedAt,
	}
	var err error
	node.ID, err = graph.DeriveNodeID(node.ScenarioInstanceID, node.Type, node.AuthorityRef)
	return node, err
}

func edgeFrom(source sourceSnapshot, observation businessEvidence, typeName, from, to string) (graph.Edge, error) {
	authority := observation.AuthorityRef
	edge := graph.Edge{
		Type:               typeName,
		From:               from,
		To:                 to,
		ScenarioInstanceID: source.ScenarioInstanceID,
		AuthorityRef:       &authority,
		SourceEventIDs:     uniqueSorted(observation.SourceEventIDs),
		EvidenceRefs:       uniqueSorted(observation.EvidenceRefs),
		ProjectorVersion:   ProjectorID,
		ValidFrom:          observation.AuthorityRef.ObservedAt,
	}
	var err error
	edge.ID, err = graph.DeriveEdgeID(edge.ScenarioInstanceID, edge.Type, edge.From, edge.To, edge.AuthorityRef)
	return edge, err
}

type compositeBuilder struct {
	source               sourceSnapshot
	nodes                map[string]graph.Node
	edges                map[string]graph.Edge
	businessNodes        map[string]string
	missing              map[string]struct{}
	warnings             map[string]struct{}
	promotedAcceptances  map[string]struct{}
	softwareCompleteness graph.Completeness
}

func newCompositeBuilder(source sourceSnapshot, software graph.Snapshot) (*compositeBuilder, error) {
	builder := &compositeBuilder{
		source:               source,
		nodes:                make(map[string]graph.Node, len(software.Nodes)),
		edges:                make(map[string]graph.Edge, len(software.Edges)),
		businessNodes:        make(map[string]string),
		missing:              make(map[string]struct{}),
		warnings:             make(map[string]struct{}),
		promotedAcceptances:  make(map[string]struct{}),
		softwareCompleteness: software.Completeness,
	}
	for _, node := range software.Nodes {
		if node.ScenarioDefinitionID != source.ScenarioDefinitionID || node.ScenarioInstanceID != source.ScenarioInstanceID {
			return nil, failure(graph.ContractScopeInvalid, "$.softwareDelivery", "projected Software Delivery nodes escaped the composite scenario scope.")
		}
		builder.nodes[node.ID] = node
	}
	for _, edge := range software.Edges {
		if edge.ScenarioInstanceID != source.ScenarioInstanceID {
			return nil, failure(graph.ContractScopeInvalid, "$.softwareDelivery", "projected Software Delivery edges escaped the composite scenario instance.")
		}
		builder.edges[edge.ID] = edge
	}
	return builder, nil
}

func (builder *compositeBuilder) addNode(kind string, observation businessEvidence, node graph.Node) error {
	if _, exists := builder.nodes[node.ID]; exists {
		return failure(graph.ContractReferenceInvalid, "$.business", "composite projection produced duplicate graph identity "+node.ID+".")
	}
	builder.nodes[node.ID] = node
	builder.businessNodes[kind+":"+observation.ID] = node.ID
	return nil
}

func (builder *compositeBuilder) findBusiness(kind, id string) string {
	return builder.businessNodes[kind+":"+id]
}

func (builder *compositeBuilder) findBridge(bridge bridgeRef, code string) (*graph.Node, error) {
	nodeID, err := graph.DeriveNodeID(builder.source.ScenarioInstanceID, bridge.TargetType, bridge.AuthorityRef)
	if err != nil {
		return nil, err
	}
	node, exists := builder.nodes[nodeID]
	if !exists || node.Type != bridge.TargetType || !authorityEqual(node.AuthorityRef, bridge.AuthorityRef) {
		builder.incomplete("bridge." + code)
		builder.warn("bridge." + code + ".unresolved")
		return nil, nil
	}
	return &node, nil
}

func (builder *compositeBuilder) addEdge(typeName, from, to string, observation businessEvidence, code string) error {
	if from == "" || to == "" {
		builder.incomplete("reference." + code)
		builder.warn("reference." + code + ".unresolved")
		return nil
	}
	edge, err := edgeFrom(builder.source, observation, typeName, from, to)
	if err != nil {
		return err
	}
	if _, exists := builder.edges[edge.ID]; exists {
		return failure(graph.ContractReferenceInvalid, "$.business", "composite projection produced duplicate edge identity "+edge.ID+".")
	}
	builder.edges[edge.ID] = edge
	return nil
}

func (builder *compositeBuilder) hasEdge(typeName, from, to string) bool {
	for _, edge := range builder.edges {
		if edge.Type == typeName && edge.From == from && edge.To == to {
			return true
		}
	}
	return false
}

func (builder *compositeBuilder) warn(code string) {
	builder.warnings["contract-to-delivery."+code] = struct{}{}
}

func (builder *compositeBuilder) incomplete(code string) {
	builder.missing["contract-to-delivery."+code] = struct{}{}
}

func setValues(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	return result
}

func addBatchCompleteness[T any](
	name string,
	batch sourceBatch[T],
	observed, missing, warnings *[]string,
) {
	token := "demo_fixture." + name
	if batch.Status == "observed" {
		*observed = append(*observed, token)
	} else {
		*missing = append(*missing, token)
	}
	if batch.Status == "missing" {
		*warnings = append(*warnings, token+"."+batch.ReasonCode)
	} else {
		for _, code := range batch.WarningCodes {
			*warnings = append(*warnings, token+"."+code)
		}
	}
}

func (builder *compositeBuilder) completeness() graph.Completeness {
	requested := append([]string{}, builder.softwareCompleteness.SourcesRequested...)
	for _, name := range businessSourceNames {
		requested = append(requested, "demo_fixture."+name)
	}
	observed := append([]string{}, builder.softwareCompleteness.SourcesObserved...)
	missing := append(append([]string{}, builder.softwareCompleteness.MissingSources...), setValues(builder.missing)...)
	warnings := append(append([]string{}, builder.softwareCompleteness.Warnings...), setValues(builder.warnings)...)
	addBatchCompleteness("customers", builder.source.Business.Customers, &observed, &missing, &warnings)
	addBatchCompleteness("contracts", builder.source.Business.Contracts, &observed, &missing, &warnings)
	addBatchCompleteness("projects", builder.source.Business.Projects, &observed, &missing, &warnings)
	addBatchCompleteness("milestones", builder.source.Business.Milestones, &observed, &missing, &warnings)
	addBatchCompleteness("acceptances", builder.source.Business.Acceptances, &observed, &missing, &warnings)
	addBatchCompleteness("outcomes", builder.source.Business.Outcomes, &observed, &missing, &warnings)
	return graph.Completeness{
		SourcesRequested: boundedCompleteness(requested, "sources-requested"),
		SourcesObserved:  boundedCompleteness(observed, "sources-observed"),
		MissingSources:   boundedCompleteness(missing, "missing-sources"),
		Warnings:         boundedCompleteness(warnings, "warnings"),
	}
}

func addBaseBusinessNodes(builder *compositeBuilder) error {
	for _, observation := range builder.source.Business.Customers.Items {
		node, err := nodeFrom(builder.source, observation.businessEvidence, "business.customer", "", graph.Object{"observationId": observation.ID})
		if err != nil {
			return err
		}
		if err := builder.addNode("customer", observation.businessEvidence, node); err != nil {
			return err
		}
	}
	for _, observation := range builder.source.Business.Contracts.Items {
		node, err := nodeFrom(builder.source, observation.businessEvidence, "business.contract", "", graph.Object{
			"customerObservationId": observation.CustomerID,
			"observationId":         observation.ID,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("contract", observation.businessEvidence, node); err != nil {
			return err
		}
	}
	for _, observation := range builder.source.Business.Projects.Items {
		node, err := nodeFrom(builder.source, observation.businessEvidence, "business.project", "", graph.Object{
			"contractObservationId": observation.ContractID,
			"observationId":         observation.ID,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("project", observation.businessEvidence, node); err != nil {
			return err
		}
	}
	for _, observation := range builder.source.Business.Milestones.Items {
		node, err := nodeFrom(builder.source, observation.businessEvidence, "business.milestone", "", graph.Object{
			"observationId":        observation.ID,
			"projectObservationId": observation.ProjectID,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("milestone", observation.businessEvidence, node); err != nil {
			return err
		}
	}
	return nil
}

func bridgeID(node *graph.Node) string {
	if node == nil {
		return ""
	}
	return node.ID
}

func addBaseBusinessEdges(builder *compositeBuilder) error {
	for _, observation := range builder.source.Business.Contracts.Items {
		contractID := builder.findBusiness("contract", observation.ID)
		if err := builder.addEdge("contracts_for", builder.findBusiness("customer", observation.CustomerID), contractID, observation.businessEvidence, "contract.customer."+observation.ID); err != nil {
			return err
		}
		deliverable, err := builder.findBridge(observation.Deliverable, "contract.deliverable."+observation.ID)
		if err != nil {
			return err
		}
		if err := builder.addEdge("contract_delivered_by", contractID, bridgeID(deliverable), observation.businessEvidence, "contract.deliverable."+observation.ID); err != nil {
			return err
		}
	}
	for _, observation := range builder.source.Business.Projects.Items {
		projectID := builder.findBusiness("project", observation.ID)
		if err := builder.addEdge("delivers_project", builder.findBusiness("contract", observation.ContractID), projectID, observation.businessEvidence, "project.contract."+observation.ID); err != nil {
			return err
		}
		workItem, err := builder.findBridge(observation.WorkItem, "project.workItem."+observation.ID)
		if err != nil {
			return err
		}
		if err := builder.addEdge("scoped_to", projectID, bridgeID(workItem), observation.businessEvidence, "project.workItem."+observation.ID); err != nil {
			return err
		}
	}
	for _, observation := range builder.source.Business.Milestones.Items {
		milestoneID := builder.findBusiness("milestone", observation.ID)
		if err := builder.addEdge("tracks_milestone", builder.findBusiness("project", observation.ProjectID), milestoneID, observation.businessEvidence, "milestone.project."+observation.ID); err != nil {
			return err
		}
		workItem, err := builder.findBridge(observation.WorkItem, "milestone.workItem."+observation.ID)
		if err != nil {
			return err
		}
		if err := builder.addEdge("milestone_contains", milestoneID, bridgeID(workItem), observation.businessEvidence, "milestone.workItem."+observation.ID); err != nil {
			return err
		}
	}
	return nil
}

func propertyBool(node graph.Node, key string) bool {
	value, ok := node.Properties[key].(bool)
	return ok && value
}

func deliverableIsCurrent(node graph.Node) bool {
	return node.Type == "reviewable_deliverable" && node.Status != nil && *node.Status == "merged" &&
		propertyBool(node, "currentHeadBound") && !propertyBool(node, "draft")
}

func decisionIsCurrentApproval(node graph.Node) bool {
	actorKind, _ := node.Properties["actorKind"].(string)
	return node.Type == "human_decision" && node.Status != nil && *node.Status == "APPROVED" &&
		actorKind == "human" && propertyBool(node, "currentHeadBound") && propertyBool(node, "independentReviewer")
}

func transitionIsCurrent(node graph.Node) bool {
	return node.Type == "accepted_transition" && node.Status != nil && *node.Status == "accepted" && propertyBool(node, "currentHeadBound")
}

func addAcceptances(builder *compositeBuilder) error {
	for _, observation := range builder.source.Business.Acceptances.Items {
		deliverable, err := builder.findBridge(observation.Deliverable, "acceptance.deliverable."+observation.ID)
		if err != nil {
			return err
		}
		decision, err := builder.findBridge(observation.HumanDecision, "acceptance.humanDecision."+observation.ID)
		if err != nil {
			return err
		}
		transition, err := builder.findBridge(observation.AcceptedTransition, "acceptance.acceptedTransition."+observation.ID)
		if err != nil {
			return err
		}
		promoted := deliverable != nil && decision != nil && transition != nil && deliverableIsCurrent(*deliverable) &&
			decisionIsCurrentApproval(*decision) && transitionIsCurrent(*transition) &&
			builder.hasEdge("reviewed_by", deliverable.ID, decision.ID) && builder.hasEdge("accepted_by", deliverable.ID, transition.ID)
		properties := graph.Object{"observationId": observation.ID, "promoted": promoted}
		if deliverable != nil {
			properties["deliverableNodeId"] = deliverable.ID
		}
		if decision != nil {
			properties["humanDecisionNodeId"] = decision.ID
		}
		if transition != nil {
			properties["acceptedTransitionNodeId"] = transition.ID
		}
		typeName, status := "informational.acceptance_observation", "pending"
		if promoted {
			typeName, status = "business.acceptance", "accepted"
		}
		node, err := nodeFrom(builder.source, observation.businessEvidence, typeName, status, properties)
		if err != nil {
			return err
		}
		if err := builder.addNode("acceptance", observation.businessEvidence, node); err != nil {
			return err
		}
		if !promoted {
			builder.incomplete("acceptance.promotion." + observation.ID)
			builder.warn("acceptance.informational." + observation.ID)
			continue
		}
		builder.promotedAcceptances[observation.ID] = struct{}{}
		if err := builder.addEdge("accepted_as", deliverable.ID, node.ID, observation.businessEvidence, "acceptance.deliverable."+observation.ID); err != nil {
			return err
		}
		if err := builder.addEdge("approved_by", node.ID, decision.ID, observation.businessEvidence, "acceptance.humanDecision."+observation.ID); err != nil {
			return err
		}
		if err := builder.addEdge("transitioned_by", node.ID, transition.ID, observation.businessEvidence, "acceptance.acceptedTransition."+observation.ID); err != nil {
			return err
		}
	}
	return nil
}

func workItemIsClosed(node graph.Node) bool {
	observationKind, _ := node.Properties["observationKind"].(string)
	return node.Type == "core.work_item" && node.Status != nil && *node.Status == "closed" &&
		propertyBool(node, "closureComplete") && observationKind == "live"
}

func addOutcomes(builder *compositeBuilder) error {
	for _, observation := range builder.source.Business.Outcomes.Items {
		acceptanceID := builder.findBusiness("acceptance", observation.AcceptanceID)
		workItem, err := builder.findBridge(observation.WorkItem, "outcome.workItem."+observation.ID)
		if err != nil {
			return err
		}
		softwareOutcome, err := builder.findBridge(observation.SoftwareOutcome, "outcome.softwareOutcome."+observation.ID)
		if err != nil {
			return err
		}
		_, acceptancePromoted := builder.promotedAcceptances[observation.AcceptanceID]
		promoted := acceptanceID != "" && acceptancePromoted && workItem != nil && softwareOutcome != nil &&
			workItemIsClosed(*workItem) && softwareOutcome.Type == "outcome" && builder.hasEdge("closes_as", workItem.ID, softwareOutcome.ID)
		properties := graph.Object{
			"acceptanceObservationId": observation.AcceptanceID,
			"observationId":           observation.ID,
			"promoted":                promoted,
		}
		if workItem != nil {
			properties["workItemNodeId"] = workItem.ID
		}
		if softwareOutcome != nil {
			properties["softwareOutcomeNodeId"] = softwareOutcome.ID
		}
		typeName, status := "informational.outcome_observation", "pending"
		if promoted {
			typeName, status = "business.outcome", "realized"
		}
		node, err := nodeFrom(builder.source, observation.businessEvidence, typeName, status, properties)
		if err != nil {
			return err
		}
		if err := builder.addNode("outcome", observation.businessEvidence, node); err != nil {
			return err
		}
		if !promoted {
			builder.incomplete("outcome.promotion." + observation.ID)
			builder.warn("outcome.informational." + observation.ID)
			continue
		}
		if err := builder.addEdge("realizes", acceptanceID, node.ID, observation.businessEvidence, "outcome.acceptance."+observation.ID); err != nil {
			return err
		}
		if err := builder.addEdge("closes_work_item", node.ID, workItem.ID, observation.businessEvidence, "outcome.workItem."+observation.ID); err != nil {
			return err
		}
		if err := builder.addEdge("substantiated_by", node.ID, softwareOutcome.ID, observation.businessEvidence, "outcome.softwareOutcome."+observation.ID); err != nil {
			return err
		}
	}
	return nil
}

// Project validates and projects one caller-supplied composite source. The
// TypeScript projector remains the sole calculation and user-visible authority.
func Project(input []byte) (Result, error) {
	source, err := parseSource(input)
	if err != nil {
		return Result{}, err
	}
	software, err := softwaredelivery.Project(source.SoftwareDeliveryJSON)
	if err != nil {
		return Result{}, err
	}
	builder, err := newCompositeBuilder(source, software.Snapshot)
	if err != nil {
		return Result{}, err
	}
	for _, step := range []func(*compositeBuilder) error{addBaseBusinessNodes, addBaseBusinessEdges, addAcceptances, addOutcomes} {
		if err := step(builder); err != nil {
			return Result{}, err
		}
	}
	nodes := make([]graph.Node, 0, len(builder.nodes))
	for _, node := range builder.nodes {
		nodes = append(nodes, node)
	}
	edges := make([]graph.Edge, 0, len(builder.edges))
	for _, edge := range builder.edges {
		edges = append(edges, edge)
	}
	snapshot, err := graph.SealSnapshot(graph.Snapshot{
		Schema:             graph.SnapshotSchema,
		Cursor:             source.Cursor,
		ScenarioInstanceID: source.ScenarioInstanceID,
		GeneratedAt:        source.GeneratedAt,
		ProjectorVersion:   ProjectorID,
		Nodes:              nodes,
		Edges:              edges,
		Completeness:       builder.completeness(),
	})
	if err != nil {
		var contractError *graph.ContractError
		if errors.As(err, &contractError) && contractError.Code == graph.ContractSchemaInvalid && contractError.Message == "contains invalid Unicode" {
			return Result{}, failure(graph.ContractSchemaInvalid, contractError.Path, "contains an unsafe control or Unicode character.")
		}
		return Result{}, err
	}
	serialized, err := graph.SerializeSnapshot(snapshot)
	if err != nil {
		return Result{}, err
	}
	if len(serialized) > MaxProjectedBytes {
		return Result{}, failure(graph.ContractBoundExceeded, "$.business", fmt.Sprintf("projected snapshot contains %d bytes; maximum is %d.", len(serialized), MaxProjectedBytes))
	}
	return Result{ProjectorID: ProjectorID, Snapshot: snapshot}, nil
}
