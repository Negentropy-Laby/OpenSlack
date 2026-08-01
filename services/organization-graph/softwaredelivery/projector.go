package softwaredelivery

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"unicode/utf16"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

var sourceNames = []string{
	"repository", "actors", "issues", "claims", "worktrees", "commits", "pullRequests", "checks",
	"reviews", "merges", "workflowRuns", "agentRuns", "prmsReports", "handoffs", "decisions",
}

var sourceProviders = map[string]string{
	"repository": "github", "actors": "github", "issues": "github", "claims": "openslack",
	"worktrees": "openslack", "commits": "github", "pullRequests": "github", "checks": "github",
	"reviews": "github", "merges": "github", "workflowRuns": "openslack", "agentRuns": "openslack",
	"prmsReports": "openslack", "handoffs": "openslack", "decisions": "openslack",
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sortUTF16(result)
	return result
}

func observationPointer(value evidence, kind string) (string, error) {
	encoded, err := graph.CanonicalJSON(graph.Object{
		"authorityVersion": value.AuthorityVersion,
		"id":               value.ID,
		"kind":             kind,
		"observationKind":  value.ObservationKind,
		"observedAt":       value.ObservedAt,
	})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return kind + ":sha256:" + hex.EncodeToString(digest[:]), nil
}

func authorityProvider(observationKind, naturalProvider string) string {
	if observationKind == "synthetic" {
		return "demo_fixture"
	}
	if observationKind == "live" {
		return naturalProvider
	}
	return "openslack"
}

func authority(value evidence, naturalProvider, objectType, objectID string) graph.AuthorityRef {
	if objectID == "" {
		objectID = value.ID
	}
	return graph.AuthorityRef{
		Provider: authorityProvider(value.ObservationKind, naturalProvider), ObjectType: objectType,
		ObjectID: objectID, Version: value.AuthorityVersion, ObservedAt: value.ObservedAt,
	}
}

type nodeInput struct {
	source         sourceSnapshot
	typeName       string
	title          string
	status         *string
	authority      graph.AuthorityRef
	owners         []graph.ActorRef
	properties     graph.Object
	sourceEventIDs []string
	evidenceRefs   []string
	validFrom      string
	validTo        *string
}

func nodeFrom(input nodeInput) (graph.Node, error) {
	if input.owners == nil {
		input.owners = []graph.ActorRef{}
	}
	if input.properties == nil {
		input.properties = graph.Object{}
	}
	node := graph.Node{
		Type: input.typeName, ScenarioDefinitionID: input.source.ScenarioDefinitionID,
		ScenarioInstanceID: input.source.ScenarioInstanceID, Title: input.title, Status: input.status,
		AuthorityRef: input.authority, Owners: input.owners, Properties: input.properties,
		SourceEventIDs: uniqueSorted(input.sourceEventIDs), EvidenceRefs: uniqueSorted(input.evidenceRefs),
		ProjectorVersion: input.source.ProjectorVersion, ValidFrom: input.validFrom, ValidTo: input.validTo,
	}
	var err error
	node.ID, err = graph.DeriveNodeID(node.ScenarioInstanceID, node.Type, node.AuthorityRef)
	return node, err
}

func edgeFrom(source sourceSnapshot, typeName, from, to string, value evidence, validFrom string) (graph.Edge, error) {
	sourceEventID, err := observationPointer(value, "source-event")
	if err != nil {
		return graph.Edge{}, err
	}
	evidenceRef, err := observationPointer(value, "evidence")
	if err != nil {
		return graph.Edge{}, err
	}
	edge := graph.Edge{
		Type: typeName, From: from, To: to, ScenarioInstanceID: source.ScenarioInstanceID,
		SourceEventIDs: []string{sourceEventID}, EvidenceRefs: []string{evidenceRef},
		ProjectorVersion: source.ProjectorVersion, ValidFrom: validFrom,
	}
	edge.ID, err = graph.DeriveEdgeID(edge.ScenarioInstanceID, edge.Type, edge.From, edge.To, nil)
	return edge, err
}

func batchSourceToken(name string) string {
	if name == "actors" {
		return "organization.actors"
	}
	return sourceProviders[name] + "." + name
}

func compactActor(value graph.ActorRef) graph.ActorRef {
	return graph.ActorRef{ID: value.ID, Kind: value.Kind}
}

type batchInfo struct {
	status       string
	batchVersion *string
	observedAt   *string
	itemCount    int
	warningCodes []string
	nonCurrent   int
}

func batchInformation(source sourceSnapshot, name string) batchInfo {
	result := batchInfo{}
	switch name {
	case "repository":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Repository.Status, source.Sources.Repository.BatchVersion, source.Sources.Repository.ObservedAt, len(source.Sources.Repository.Items), source.Sources.Repository.WarningCodes
		for _, item := range source.Sources.Repository.Items {
			if item.ObservationKind != "live" {
				result.nonCurrent++
			}
		}
	case "actors":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Actors.Status, source.Sources.Actors.BatchVersion, source.Sources.Actors.ObservedAt, len(source.Sources.Actors.Items), source.Sources.Actors.WarningCodes
		for _, item := range source.Sources.Actors.Items {
			expected := "local_store"
			if item.AuthorityProvider == "github" {
				expected = "live"
			}
			if item.ObservationKind != expected {
				result.nonCurrent++
			}
		}
	case "issues":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Issues.Status, source.Sources.Issues.BatchVersion, source.Sources.Issues.ObservedAt, len(source.Sources.Issues.Items), source.Sources.Issues.WarningCodes
		for _, item := range source.Sources.Issues.Items {
			if item.ObservationKind != "live" {
				result.nonCurrent++
			}
		}
	case "claims":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Claims.Status, source.Sources.Claims.BatchVersion, source.Sources.Claims.ObservedAt, len(source.Sources.Claims.Items), source.Sources.Claims.WarningCodes
		for _, item := range source.Sources.Claims.Items {
			if item.ObservationKind != "local_store" {
				result.nonCurrent++
			}
		}
	case "worktrees":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Worktrees.Status, source.Sources.Worktrees.BatchVersion, source.Sources.Worktrees.ObservedAt, len(source.Sources.Worktrees.Items), source.Sources.Worktrees.WarningCodes
		for _, item := range source.Sources.Worktrees.Items {
			if item.ObservationKind != "local_store" {
				result.nonCurrent++
			}
		}
	case "commits":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Commits.Status, source.Sources.Commits.BatchVersion, source.Sources.Commits.ObservedAt, len(source.Sources.Commits.Items), source.Sources.Commits.WarningCodes
		for _, item := range source.Sources.Commits.Items {
			if item.ObservationKind != "live" {
				result.nonCurrent++
			}
		}
	case "pullRequests":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.PullRequests.Status, source.Sources.PullRequests.BatchVersion, source.Sources.PullRequests.ObservedAt, len(source.Sources.PullRequests.Items), source.Sources.PullRequests.WarningCodes
		for _, item := range source.Sources.PullRequests.Items {
			if item.ObservationKind != "live" {
				result.nonCurrent++
			}
		}
	case "checks":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Checks.Status, source.Sources.Checks.BatchVersion, source.Sources.Checks.ObservedAt, len(source.Sources.Checks.Items), source.Sources.Checks.WarningCodes
		for _, item := range source.Sources.Checks.Items {
			if item.ObservationKind != "live" {
				result.nonCurrent++
			}
		}
	case "reviews":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Reviews.Status, source.Sources.Reviews.BatchVersion, source.Sources.Reviews.ObservedAt, len(source.Sources.Reviews.Items), source.Sources.Reviews.WarningCodes
		for _, item := range source.Sources.Reviews.Items {
			if item.ObservationKind != "live" {
				result.nonCurrent++
			}
		}
	case "merges":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Merges.Status, source.Sources.Merges.BatchVersion, source.Sources.Merges.ObservedAt, len(source.Sources.Merges.Items), source.Sources.Merges.WarningCodes
		for _, item := range source.Sources.Merges.Items {
			if item.ObservationKind != "live" {
				result.nonCurrent++
			}
		}
	case "workflowRuns":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.WorkflowRuns.Status, source.Sources.WorkflowRuns.BatchVersion, source.Sources.WorkflowRuns.ObservedAt, len(source.Sources.WorkflowRuns.Items), source.Sources.WorkflowRuns.WarningCodes
		for _, item := range source.Sources.WorkflowRuns.Items {
			if item.ObservationKind != "local_store" {
				result.nonCurrent++
			}
		}
	case "agentRuns":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.AgentRuns.Status, source.Sources.AgentRuns.BatchVersion, source.Sources.AgentRuns.ObservedAt, len(source.Sources.AgentRuns.Items), source.Sources.AgentRuns.WarningCodes
		for _, item := range source.Sources.AgentRuns.Items {
			if item.ObservationKind != "local_store" {
				result.nonCurrent++
			}
		}
	case "prmsReports":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.PRMSReports.Status, source.Sources.PRMSReports.BatchVersion, source.Sources.PRMSReports.ObservedAt, len(source.Sources.PRMSReports.Items), source.Sources.PRMSReports.WarningCodes
		for _, item := range source.Sources.PRMSReports.Items {
			if item.ObservationKind != "local_store" {
				result.nonCurrent++
			}
		}
	case "handoffs":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Handoffs.Status, source.Sources.Handoffs.BatchVersion, source.Sources.Handoffs.ObservedAt, len(source.Sources.Handoffs.Items), source.Sources.Handoffs.WarningCodes
		for _, item := range source.Sources.Handoffs.Items {
			if item.ObservationKind != "local_store" {
				result.nonCurrent++
			}
		}
	case "decisions":
		result.status, result.batchVersion, result.observedAt, result.itemCount, result.warningCodes = source.Sources.Decisions.Status, source.Sources.Decisions.BatchVersion, source.Sources.Decisions.ObservedAt, len(source.Sources.Decisions.Items), source.Sources.Decisions.WarningCodes
		for _, item := range source.Sources.Decisions.Items {
			if item.ObservationKind != "local_store" {
				result.nonCurrent++
			}
		}
	}
	return result
}

func pointerBytes(value graph.ActorRef) int {
	encoded, err := graph.CanonicalJSON(graph.Object{"id": value.ID, "kind": value.Kind})
	if err != nil {
		return 0
	}
	return len(encoded) + 1
}

func assertProjectionExpansionBudget(source sourceSnapshot) error {
	observationCount, sourceBatchNodes, outcomeNodes, relationCount := 0, 0, 0, 0
	for _, name := range sourceNames {
		info := batchInformation(source, name)
		observationCount += info.itemCount
		if info.status != "missing" && info.batchVersion != nil && info.observedAt != nil {
			sourceBatchNodes++
		}
	}
	for _, item := range source.Sources.Issues.Items {
		if item.State == "closed" && item.ObservationKind == "live" && item.ClosureComplete && item.ClosedAt != nil {
			outcomeNodes++
		}
		relationCount += 1 + len(item.AssigneeIDs)
		if item.State == "closed" {
			relationCount++
		}
	}
	relationCount += len(source.Sources.Claims.Items) * 2
	for _, item := range source.Sources.Worktrees.Items {
		relationCount++
		if item.ClaimID != nil {
			relationCount++
		}
		if item.AgentRunID != nil {
			relationCount++
		}
	}
	for _, item := range source.Sources.Commits.Items {
		relationCount += len(item.IssueIDs)
		if item.WorktreeID != nil {
			relationCount++
		}
	}
	for _, item := range source.Sources.PullRequests.Items {
		relationCount += len(item.IssueIDs) + len(item.CommitSHAs)
	}
	relationCount += len(source.Sources.Checks.Items) + len(source.Sources.Reviews.Items) + len(source.Sources.Merges.Items) + len(source.Sources.PRMSReports.Items)
	for _, item := range source.Sources.WorkflowRuns.Items {
		relationCount += len(item.IssueIDs) + len(item.PullRequestIDs)
	}
	for _, item := range source.Sources.AgentRuns.Items {
		relationCount++
		if item.WorkflowRunID != nil {
			relationCount++
		}
		if item.WorktreeID != nil {
			relationCount++
		}
	}
	for _, item := range source.Sources.Handoffs.Items {
		relationCount += 2
		if item.IssueID != nil {
			relationCount++
		}
		if item.PullRequestID != nil {
			relationCount++
		}
		if item.WorkflowRunID != nil {
			relationCount++
		}
	}
	for _, item := range source.Sources.Decisions.Items {
		if item.IssueID != nil {
			relationCount++
		}
		if item.PullRequestID != nil {
			relationCount++
		}
		if item.WorkflowRunID != nil {
			relationCount++
		}
	}
	actorByID := make(map[string]graph.ActorRef)
	for _, item := range source.Sources.Actors.Items {
		actorByID[item.Actor.ID] = compactActor(item.Actor)
	}
	ownerBytesFor := func(ids []string) int {
		total := 0
		for _, id := range ids {
			if actor, ok := actorByID[id]; ok {
				total += pointerBytes(actor)
			}
		}
		return total
	}
	actorIDs := make([]string, 0, len(source.Sources.Actors.Items))
	for _, item := range source.Sources.Actors.Items {
		actorIDs = append(actorIDs, item.Actor.ID)
	}
	ownerBytes := ownerBytesFor(actorIDs)
	for _, item := range source.Sources.Issues.Items {
		count := 1
		if item.State == "closed" && item.ObservationKind == "live" && item.ClosureComplete && item.ClosedAt != nil {
			count++
		}
		ownerBytes += ownerBytesFor(item.AssigneeIDs) * count
	}
	ids := make([]string, 0)
	for _, item := range source.Sources.Claims.Items {
		ids = append(ids, item.AgentActorID)
	}
	ownerBytes += ownerBytesFor(ids)
	ids = ids[:0]
	for _, item := range source.Sources.PullRequests.Items {
		ids = append(ids, item.AuthorActorID)
	}
	ownerBytes += ownerBytesFor(ids)
	ids = ids[:0]
	for _, item := range source.Sources.Reviews.Items {
		ids = append(ids, item.ActorID)
	}
	ownerBytes += ownerBytesFor(ids)
	ids = ids[:0]
	for _, item := range source.Sources.AgentRuns.Items {
		ids = append(ids, item.AgentActorID)
	}
	ownerBytes += ownerBytesFor(ids)
	ids = ids[:0]
	for _, item := range source.Sources.Decisions.Items {
		ids = append(ids, item.DecidedByActorID)
	}
	ownerBytes += ownerBytesFor(ids)
	nodeCount := observationCount + sourceBatchNodes + outcomeNodes
	scopeNodeBytes := len(source.ScenarioDefinitionID) + len(source.ScenarioInstanceID)
	scopeEdgeBytes := len(source.ScenarioInstanceID)
	upper := source.canonicalBytes*4 + nodeCount*(scopeNodeBytes+1024) + relationCount*(scopeEdgeBytes+1024) + ownerBytes + 64*1024
	if upper > MaxProjectedBytes {
		return failure(graph.ContractBoundExceeded, "$.sources", fmt.Sprintf("projection preflight upper bound %d bytes exceeds %d.", upper, MaxProjectedBytes))
	}
	return nil
}

type projectionBuilder struct {
	source      sourceSnapshot
	nodes       map[string]graph.Node
	edges       map[string]graph.Edge
	nodeOrder   []string
	edgeOrder   []string
	sourceNodes map[string]string
	warnings    map[string]struct{}
	missing     map[string]struct{}
	actorByID   map[string]graph.ActorRef
}

func newProjectionBuilder(source sourceSnapshot) *projectionBuilder {
	result := &projectionBuilder{
		source: source, nodes: map[string]graph.Node{}, edges: map[string]graph.Edge{},
		nodeOrder: []string{}, edgeOrder: []string{}, sourceNodes: map[string]string{},
		warnings: map[string]struct{}{}, missing: map[string]struct{}{}, actorByID: map[string]graph.ActorRef{},
	}
	for _, item := range source.Sources.Actors.Items {
		result.actorByID[item.Actor.ID] = item.Actor
	}
	return result
}

func (builder *projectionBuilder) owners(ids []string) []graph.ActorRef {
	result := make([]graph.ActorRef, 0, len(ids))
	for _, id := range uniqueSorted(ids) {
		if actor, ok := builder.actorByID[id]; ok {
			result = append(result, compactActor(actor))
		}
	}
	return result
}

func (builder *projectionBuilder) addNode(sourceKind, sourceID string, node graph.Node) error {
	if _, ok := builder.nodes[node.ID]; ok {
		return failure(graph.ContractReferenceInvalid, "$.sources", "projection produced duplicate graph identity "+node.ID+".")
	}
	builder.nodes[node.ID] = node
	builder.nodeOrder = append(builder.nodeOrder, node.ID)
	builder.sourceNodes[sourceKind+":"+sourceID] = node.ID
	return nil
}

func (builder *projectionBuilder) find(sourceKind, sourceID string) (string, bool) {
	value, ok := builder.sourceNodes[sourceKind+":"+sourceID]
	return value, ok
}
func (builder *projectionBuilder) warn(code string)       { builder.warnings[code] = struct{}{} }
func (builder *projectionBuilder) incomplete(code string) { builder.missing[code] = struct{}{} }

func (builder *projectionBuilder) addEdge(typeName, from string, fromOK bool, to string, toOK bool, value evidence, relationCode string) error {
	if !fromOK || !toOK {
		builder.warn("dangling." + relationCode + "." + value.ID)
		builder.incomplete("reference." + relationCode + "." + value.ID)
		return nil
	}
	edge, err := edgeFrom(builder.source, typeName, from, to, value, value.ObservedAt)
	if err != nil {
		return err
	}
	if _, ok := builder.edges[edge.ID]; !ok {
		builder.edges[edge.ID] = edge
		builder.edgeOrder = append(builder.edgeOrder, edge.ID)
	}
	return nil
}

func (builder *projectionBuilder) completeness() graph.Completeness {
	requested, observed := make([]string, 0, len(sourceNames)), make([]string, 0, len(sourceNames))
	missing, warnings := make([]string, 0), make([]string, 0)
	for value := range builder.missing {
		missing = append(missing, value)
	}
	for value := range builder.warnings {
		warnings = append(warnings, value)
	}
	for _, name := range sourceNames {
		info, token := batchInformation(builder.source, name), batchSourceToken(name)
		requested = append(requested, token)
		if info.status == "observed" && info.nonCurrent == 0 {
			observed = append(observed, token)
		} else {
			missing = append(missing, token)
		}
		if info.status == "missing" {
			warnings = append(warnings, token+"."+missingReason(builder.source, name))
		} else {
			for _, code := range info.warningCodes {
				warnings = append(warnings, token+"."+code)
			}
			if info.nonCurrent > 0 {
				warnings = append(warnings, token+".non-current-items")
			}
		}
	}
	return graph.Completeness{SourcesRequested: boundCompleteness(requested, "sources-requested"), SourcesObserved: boundCompleteness(observed, "sources-observed"), MissingSources: boundCompleteness(missing, "missing-sources"), Warnings: boundCompleteness(warnings, "warnings")}
}

func boundCompleteness(values []string, suffix string) []string {
	values = uniqueSorted(values)
	if len(values) <= MaxCompletenessEntries {
		return values
	}
	values = append(values[:MaxCompletenessEntries-1], "projection."+suffix+".truncated")
	sortUTF16(values)
	return values
}

func missingReason(source sourceSnapshot, name string) string {
	switch name {
	case "repository":
		return source.Sources.Repository.ReasonCode
	case "actors":
		return source.Sources.Actors.ReasonCode
	case "issues":
		return source.Sources.Issues.ReasonCode
	case "claims":
		return source.Sources.Claims.ReasonCode
	case "worktrees":
		return source.Sources.Worktrees.ReasonCode
	case "commits":
		return source.Sources.Commits.ReasonCode
	case "pullRequests":
		return source.Sources.PullRequests.ReasonCode
	case "checks":
		return source.Sources.Checks.ReasonCode
	case "reviews":
		return source.Sources.Reviews.ReasonCode
	case "merges":
		return source.Sources.Merges.ReasonCode
	case "workflowRuns":
		return source.Sources.WorkflowRuns.ReasonCode
	case "agentRuns":
		return source.Sources.AgentRuns.ReasonCode
	case "prmsReports":
		return source.Sources.PRMSReports.ReasonCode
	case "handoffs":
		return source.Sources.Handoffs.ReasonCode
	default:
		return source.Sources.Decisions.ReasonCode
	}
}

func statusPointer(value string) *string { return &value }

func addSourceBatchNodes(builder *projectionBuilder) error {
	for _, name := range sourceNames {
		info := batchInformation(builder.source, name)
		if info.status == "missing" || info.batchVersion == nil || info.observedAt == nil {
			continue
		}
		authorityRef := graph.AuthorityRef{Provider: "openslack", ObjectType: "source_batch", ObjectID: batchSourceToken(name), Version: *info.batchVersion, ObservedAt: *info.observedAt}
		node, err := nodeFrom(nodeInput{source: builder.source, typeName: "projection.source_batch", title: batchSourceToken(name), status: statusPointer(info.status), authority: authorityRef, properties: graph.Object{"recordCount": float64(info.itemCount), "status": info.status}, validFrom: *info.observedAt})
		if err != nil {
			return err
		}
		if err := builder.addNode("sourceBatch", name, node); err != nil {
			return err
		}
	}
	return nil
}

func addRepositories(builder *projectionBuilder) error {
	items := append([]repositoryObservation(nil), builder.source.Sources.Repository.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := item.ObservationKind == "live"
		typeName, status, objectType := "informational.repository_observation", "informational", "repository_projection_observation"
		if current {
			typeName, status, objectType = "software.repository", "observed", "repository"
		}
		node, err := nodeFrom(nodeInput{source: builder.source, typeName: typeName, title: item.FullName, status: statusPointer(status), authority: authority(item.evidence, "github", objectType, item.RepositoryID), properties: graph.Object{"currentAuthority": current, "defaultBranch": item.DefaultBranch, "observationKind": item.ObservationKind}, sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.ObservedAt})
		if err != nil {
			return err
		}
		if err := builder.addNode("repository", item.RepositoryID, node); err != nil {
			return err
		}
		if !current {
			builder.warn("informational.repository." + item.ID)
		}
	}
	return nil
}

func addActors(builder *projectionBuilder) error {
	items := append([]actorObservation(nil), builder.source.Sources.Actors.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := (item.AuthorityProvider == "github" && item.ObservationKind == "live") || (item.AuthorityProvider == "openslack" && item.ObservationKind == "local_store")
		typeName, status, objectType := "informational.actor_observation", "informational", "actor_projection_observation"
		if current {
			typeName, status, objectType = "organization.actor", "observed", "actor"
		}
		title := item.Actor.ID
		if item.Actor.DisplayName != nil {
			title = *item.Actor.DisplayName
		}
		node, err := nodeFrom(nodeInput{source: builder.source, typeName: typeName, title: title, status: statusPointer(status), authority: authority(item.evidence, item.AuthorityProvider, objectType, item.Actor.ID), owners: []graph.ActorRef{compactActor(item.Actor)}, properties: graph.Object{"actorKind": item.Actor.Kind, "observationKind": item.ObservationKind}, sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.ObservedAt})
		if err != nil {
			return err
		}
		if err := builder.addNode("actor", item.Actor.ID, node); err != nil {
			return err
		}
	}
	return nil
}

func addIssues(builder *projectionBuilder) error {
	items := append([]issueObservation(nil), builder.source.Sources.Issues.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := item.ObservationKind == "live"
		typeName, objectType := "informational.issue_observation", "issue_projection_observation"
		if current {
			typeName, objectType = "core.work_item", "issue"
		}
		labels := make([]string, len(item.Labels))
		for index, label := range item.Labels {
			labels[index] = label.Category + ":" + label.Name
		}
		owners := builder.owners(item.AssigneeIDs)
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: item.Title, status: statusPointer(item.State),
			authority: authority(item.evidence, "github", objectType, ""), owners: owners,
			properties: graph.Object{
				"assigneesComplete": item.AssigneesComplete, "closureComplete": item.ClosureComplete,
				"labels": stringsArray(uniqueSorted(labels)), "number": float64(item.Number),
				"observationKind": item.ObservationKind, "repositoryId": item.RepositoryID,
			},
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.CreatedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("issue", item.ID, node); err != nil {
			return err
		}
		repository, ok := builder.find("repository", item.RepositoryID)
		if err := builder.addEdge("contains", repository, ok, node.ID, true, item.evidence, "repository-issue"); err != nil {
			return err
		}
		for _, actorID := range uniqueSorted(item.AssigneeIDs) {
			actor, ok := builder.find("actor", actorID)
			if err := builder.addEdge("assigned_to", node.ID, true, actor, ok, item.evidence, "issue-assignee"); err != nil {
				return err
			}
		}
		if !item.AssigneesComplete {
			builder.incomplete("github.issues.assignees." + item.ID)
		}
		if !item.ClosureComplete {
			builder.incomplete("github.issues.closure." + item.ID)
		}
		if !current {
			builder.warn("informational.issue." + item.ID)
		}
		if item.State != "closed" {
			continue
		}
		if !current || !item.ClosureComplete || item.ClosedAt == nil {
			builder.incomplete("github.issues.outcome." + item.ID)
			continue
		}
		outcome, err := nodeFrom(nodeInput{
			source: builder.source, typeName: "outcome", title: fmt.Sprintf("Issue %d outcome", item.Number),
			status: statusPointer("completed"), authority: authority(item.evidence, "github", "issue_outcome", ""),
			owners: owners, properties: graph.Object{"closedAt": *item.ClosedAt, "issueId": item.ID, "issueVersion": item.AuthorityVersion},
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: *item.ClosedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("outcome", item.ID, outcome); err != nil {
			return err
		}
		if err := builder.addEdge("closes_as", node.ID, true, outcome.ID, true, item.evidence, "issue-outcome"); err != nil {
			return err
		}
	}
	return nil
}

func stringsArray(values []string) graph.Array {
	result := make(graph.Array, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

// ecmaScriptSlicePrefix implements String.prototype.slice(0, codeUnits).
// A split surrogate is represented as its WTF-8 byte sequence so the shared
// graph validator rejects it at the same downstream seal boundary as JS.
func ecmaScriptSlicePrefix(value string, codeUnits int) string {
	if codeUnits <= 0 {
		return ""
	}
	result := make([]byte, 0, len(value))
	used := 0
	for _, current := range value {
		if used >= codeUnits {
			break
		}
		if current <= 0xffff {
			result = append(result, string(current)...)
			used++
			continue
		}
		if used+2 <= codeUnits {
			result = append(result, string(current)...)
			used += 2
			continue
		}
		high, _ := utf16.EncodeRune(current)
		result = append(result,
			byte(0xe0|(high>>12)),
			byte(0x80|((high>>6)&0x3f)),
			byte(0x80|(high&0x3f)),
		)
		used++
	}
	return string(result)
}

func addClaims(builder *projectionBuilder) error {
	items := append([]claimObservation(nil), builder.source.Sources.Claims.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		fresh := item.Status != "active" || dateMillis(item.ExpiresAt) > dateMillis(builder.source.GeneratedAt)
		current := item.ObservationKind == "local_store" && item.TargetSHA != nil && fresh
		typeName, objectType := "informational.claim_observation", "claim_projection_observation"
		if current {
			typeName, objectType = "execution_lease", "claim_ref"
		}
		properties := graph.Object{"currentAuthority": current, "expiresAt": item.ExpiresAt, "observationKind": item.ObservationKind}
		if item.TargetSHA != nil {
			properties["targetSha"] = *item.TargetSHA
		}
		node, err := nodeFrom(nodeInput{source: builder.source, typeName: typeName, title: "Claim " + item.ClaimRef, status: statusPointer(item.Status), authority: authority(item.evidence, "openslack", objectType, item.ClaimRef), owners: builder.owners([]string{item.AgentActorID}), properties: properties, sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.ClaimedAt})
		if err != nil {
			return err
		}
		if err := builder.addNode("claim", item.ID, node); err != nil {
			return err
		}
		issue, ok := builder.find("issue", item.IssueID)
		if err := builder.addEdge("leased_by", issue, ok, node.ID, true, item.evidence, "issue-claim"); err != nil {
			return err
		}
		actor, ok := builder.find("actor", item.AgentActorID)
		if err := builder.addEdge("owned_by", node.ID, true, actor, ok, item.evidence, "claim-agent"); err != nil {
			return err
		}
		if !current {
			if item.TargetSHA == nil {
				builder.incomplete("openslack.claims.target." + item.ID)
			} else {
				builder.incomplete("openslack.claims.freshness." + item.ID)
			}
		}
	}
	return nil
}

func addWorktrees(builder *projectionBuilder) error {
	items := append([]worktreeObservation(nil), builder.source.Sources.Worktrees.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := item.ObservationKind == "local_store" && item.BaseSHA != nil && (item.Status != "cleaned" || item.ClosedAt != nil)
		typeName, objectType := "informational.worktree_observation", "worktree_projection_observation"
		if current {
			typeName, objectType = "execution_context", "worktree"
		}
		properties := graph.Object{"branchName": item.BranchName, "currentAuthority": current, "observationKind": item.ObservationKind}
		if item.BaseSHA != nil {
			properties["baseSha"] = *item.BaseSHA
		}
		node, err := nodeFrom(nodeInput{source: builder.source, typeName: typeName, title: "Worktree " + item.WorktreeID, status: statusPointer(item.Status), authority: authority(item.evidence, "openslack", objectType, item.WorktreeID), properties: properties, sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.CreatedAt, validTo: item.ClosedAt})
		if err != nil {
			return err
		}
		if err := builder.addNode("worktree", item.WorktreeID, node); err != nil {
			return err
		}
		issue, ok := builder.find("issue", item.IssueID)
		if err := builder.addEdge("executes_in", issue, ok, node.ID, true, item.evidence, "issue-worktree"); err != nil {
			return err
		}
		if item.ClaimID != nil {
			claim, ok := builder.find("claim", *item.ClaimID)
			if err := builder.addEdge("executes_in", claim, ok, node.ID, true, item.evidence, "claim-worktree"); err != nil {
				return err
			}
		}
		if !current {
			builder.incomplete("openslack.worktrees.base." + item.ID)
		}
	}
	return nil
}

func addCommits(builder *projectionBuilder) error {
	items := append([]commitObservation(nil), builder.source.Sources.Commits.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := item.ObservationKind == "live"
		typeName, objectType := "informational.commit_observation", "commit_projection_observation"
		if current {
			typeName, objectType = "artifact_revision", "commit"
		}
		titleSHA := ecmaScriptSlicePrefix(item.SHA, 12)
		node, err := nodeFrom(nodeInput{source: builder.source, typeName: typeName, title: "Commit " + titleSHA, status: statusPointer(map[bool]string{true: "observed", false: "informational"}[current]), authority: authority(item.evidence, "github", objectType, item.SHA), properties: graph.Object{"currentAuthority": current, "observationKind": item.ObservationKind, "repositoryId": item.RepositoryID, "sha": item.SHA}, sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.AuthoredAt})
		if err != nil {
			return err
		}
		if err := builder.addNode("commit", item.SHA, node); err != nil {
			return err
		}
		for _, issueID := range uniqueSorted(item.IssueIDs) {
			issue, ok := builder.find("issue", issueID)
			if err := builder.addEdge("implemented_by", issue, ok, node.ID, true, item.evidence, "issue-commit"); err != nil {
				return err
			}
		}
		if item.WorktreeID != nil {
			worktree, ok := builder.find("worktree", *item.WorktreeID)
			if err := builder.addEdge("produces", worktree, ok, node.ID, true, item.evidence, "worktree-commit"); err != nil {
				return err
			}
		}
		if !current {
			builder.warn("informational.commit." + item.ID)
		}
	}
	return nil
}

func isCurrentPullRequest(value pullRequestObservation) bool {
	return value.ObservationKind == "live" && value.BaseSHA != nil && value.HeadSHA != nil
}

func pullRequestByID(source sourceSnapshot, id string) (pullRequestObservation, bool) {
	for _, candidate := range source.Sources.PullRequests.Items {
		if candidate.ID == id {
			return candidate, true
		}
	}
	return pullRequestObservation{}, false
}

func addPullRequests(builder *projectionBuilder) error {
	items := append([]pullRequestObservation(nil), builder.source.Sources.PullRequests.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := isCurrentPullRequest(item)
		typeName, objectType := "informational.pr_observation", "pr_projection_observation"
		if current {
			typeName, objectType = "reviewable_deliverable", "pull_request"
		}
		owners := []graph.ActorRef{}
		if actor, ok := builder.actorByID[item.AuthorActorID]; ok {
			owners = append(owners, compactActor(actor))
		}
		properties := graph.Object{
			"authorActorId": item.AuthorActorID, "currentHeadBound": current, "draft": item.Draft,
			"number": float64(item.Number), "observationKind": item.ObservationKind, "repositoryId": item.RepositoryID,
		}
		if item.BaseSHA != nil {
			properties["baseSha"] = *item.BaseSHA
		}
		if item.HeadSHA != nil {
			properties["headSha"] = *item.HeadSHA
		}
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: item.Title, status: statusPointer(item.State),
			authority: authority(item.evidence, "github", objectType, ""), owners: owners, properties: properties,
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.OpenedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("pullRequest", item.ID, node); err != nil {
			return err
		}
		for _, issueID := range uniqueSorted(item.IssueIDs) {
			issue, ok := builder.find("issue", issueID)
			if err := builder.addEdge("produces", issue, ok, node.ID, true, item.evidence, "issue-pr"); err != nil {
				return err
			}
		}
		for _, commitSHA := range uniqueSorted(item.CommitSHAs) {
			commit, ok := builder.find("commit", commitSHA)
			if err := builder.addEdge("included_in", commit, ok, node.ID, true, item.evidence, "commit-pr"); err != nil {
				return err
			}
		}
		if _, ok := builder.actorByID[item.AuthorActorID]; !ok {
			builder.incomplete("github.pullRequests.author." + item.ID)
		}
		if !current {
			builder.incomplete("github.pullRequests.currentHead." + item.ID)
			builder.warn("informational.pullRequest." + item.ID)
		}
	}
	return nil
}

func addChecks(builder *projectionBuilder) error {
	items := append([]checkObservation(nil), builder.source.Sources.Checks.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		pullRequest, found := pullRequestByID(builder.source, item.PullRequestID)
		currentHeadBound := item.ObservationKind == "live" && found && isCurrentPullRequest(pullRequest) && item.HeadSHA != nil && *item.HeadSHA == *pullRequest.HeadSHA
		current := currentHeadBound && item.Status == "completed" && item.Conclusion != nil && item.CompletedAt != nil
		typeName, objectType := "informational.check_observation", "check_projection_observation"
		if current {
			typeName, objectType = "verification_evidence", "check_run"
		}
		status := item.Status
		if item.Conclusion != nil {
			status = *item.Conclusion
		}
		properties := graph.Object{"currentHeadBound": currentHeadBound, "observationKind": item.ObservationKind, "status": item.Status}
		if item.Conclusion != nil {
			properties["conclusion"] = *item.Conclusion
		}
		if item.HeadSHA != nil {
			properties["headSha"] = *item.HeadSHA
		}
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: item.Name, status: statusPointer(status),
			authority: authority(item.evidence, "github", objectType, ""), properties: properties,
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.StartedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("check", item.ID, node); err != nil {
			return err
		}
		pullRequestNode, ok := builder.find("pullRequest", item.PullRequestID)
		if err := builder.addEdge("verified_by", pullRequestNode, ok, node.ID, true, item.evidence, "pr-check"); err != nil {
			return err
		}
		if !currentHeadBound {
			builder.incomplete("github.checks.currentHead." + item.ID)
		}
		if !current {
			builder.warn("informational.check." + item.ID)
		}
	}
	return nil
}

func addReviews(builder *projectionBuilder) error {
	latest := make(map[string]string)
	decisive := make([]reviewObservation, 0)
	for _, item := range builder.source.Sources.Reviews.Items {
		if item.ObservationKind == "live" && item.ActorKind == "human" &&
			(item.State == "APPROVED" || item.State == "CHANGES_REQUESTED" || item.State == "DISMISSED") && item.CommitOID != nil {
			decisive = append(decisive, item)
		}
	}
	sort.Slice(decisive, func(i, j int) bool {
		left, right := dateMillis(decisive[i].SubmittedAt), dateMillis(decisive[j].SubmittedAt)
		if left == right {
			return utf16Less(decisive[i].ID, decisive[j].ID)
		}
		return left < right
	})
	for _, item := range decisive {
		latest[item.PullRequestID+":"+item.ActorID+":"+*item.CommitOID] = item.ID
	}
	items := append([]reviewObservation(nil), builder.source.Sources.Reviews.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		pullRequest, found := pullRequestByID(builder.source, item.PullRequestID)
		decisionState := item.State == "APPROVED" || item.State == "CHANGES_REQUESTED"
		selfReview := found && item.ActorID == pullRequest.AuthorActorID
		current := item.ObservationKind == "live" && item.ActorKind == "human" && decisionState && found &&
			isCurrentPullRequest(pullRequest) && item.CommitOID != nil && *item.CommitOID == *pullRequest.HeadSHA &&
			!selfReview && latest[item.PullRequestID+":"+item.ActorID+":"+*item.CommitOID] == item.ID
		typeName, objectType, title := "informational.review_observation", "review_projection_observation", "Review observation "+item.State
		if current {
			typeName, objectType, title = "human_decision", "pull_request_review", "Human review "+item.State
		}
		properties := graph.Object{
			"actorId": item.ActorID, "actorKind": item.ActorKind, "currentHeadBound": current,
			"decisionState": decisionState, "independentReviewer": found && !selfReview, "observationKind": item.ObservationKind,
		}
		if item.CommitOID != nil {
			properties["commitOid"] = *item.CommitOID
		}
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: title, status: statusPointer(item.State),
			authority: authority(item.evidence, "github", objectType, ""), owners: builder.owners([]string{item.ActorID}),
			properties: properties, sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.SubmittedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("review", item.ID, node); err != nil {
			return err
		}
		edgeType := "observed_review"
		if current {
			edgeType = "reviewed_by"
		}
		pullRequestNode, ok := builder.find("pullRequest", item.PullRequestID)
		if err := builder.addEdge(edgeType, pullRequestNode, ok, node.ID, true, item.evidence, "pr-review"); err != nil {
			return err
		}
		if !current {
			builder.warn("informational.review." + item.ID)
			if item.ActorKind == "human" && decisionState && !selfReview {
				builder.incomplete("github.reviews.currentHead." + item.ID)
			}
			if selfReview {
				builder.warn("github.reviews.selfReview." + item.ID)
			}
		}
	}
	return nil
}

func addMerges(builder *projectionBuilder) error {
	items := append([]mergeObservation(nil), builder.source.Sources.Merges.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		pullRequest, found := pullRequestByID(builder.source, item.PullRequestID)
		current := item.ObservationKind == "live" && found && isCurrentPullRequest(pullRequest) && pullRequest.State == "merged" &&
			item.HeadSHA != nil && *item.HeadSHA == *pullRequest.HeadSHA && item.MergeCommitSHA != nil
		typeName, objectType, title, status := "informational.merge_observation", "merge_projection_observation", "Merge observation", "informational"
		if current {
			typeName, objectType, title, status = "accepted_transition", "merge", "Accepted merge transition", "accepted"
		}
		properties := graph.Object{"actorId": item.ActorID, "currentHeadBound": current, "observationKind": item.ObservationKind}
		if item.HeadSHA != nil {
			properties["headSha"] = *item.HeadSHA
		}
		if item.MergeCommitSHA != nil {
			properties["mergeCommitSha"] = *item.MergeCommitSHA
		}
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: title, status: statusPointer(status),
			authority: authority(item.evidence, "github", objectType, ""), properties: properties,
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.MergedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("merge", item.ID, node); err != nil {
			return err
		}
		edgeType := "observed_merge"
		if current {
			edgeType = "accepted_by"
		}
		pullRequestNode, ok := builder.find("pullRequest", item.PullRequestID)
		if err := builder.addEdge(edgeType, pullRequestNode, ok, node.ID, true, item.evidence, "pr-merge"); err != nil {
			return err
		}
		if !current {
			builder.incomplete("github.merges.currentHead." + item.ID)
			builder.warn("informational.merge." + item.ID)
		}
	}
	return nil
}

func terminalStatus(value string) bool {
	return value == "completed" || value == "failed" || value == "cancelled"
}

func addWorkflowRuns(builder *projectionBuilder) error {
	items := append([]workflowRunObservation(nil), builder.source.Sources.WorkflowRuns.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := item.ObservationKind == "local_store" && (!terminalStatus(item.Status) || item.CompletedAt != nil)
		typeName, objectType := "informational.workflow_run_observation", "workflow_projection_observation"
		if current {
			typeName, objectType = "workflow_run", "workflow_run"
		}
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: "Workflow " + item.WorkflowID, status: statusPointer(item.Status),
			authority:      authority(item.evidence, "openslack", objectType, ""),
			properties:     graph.Object{"currentAuthority": current, "observationKind": item.ObservationKind, "workflowId": item.WorkflowID},
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.StartedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("workflowRun", item.ID, node); err != nil {
			return err
		}
		for _, issueID := range uniqueSorted(item.IssueIDs) {
			issue, ok := builder.find("issue", issueID)
			if err := builder.addEdge("decomposes_to", node.ID, true, issue, ok, item.evidence, "workflow-issue"); err != nil {
				return err
			}
		}
		for _, pullRequestID := range uniqueSorted(item.PullRequestIDs) {
			pullRequest, ok := builder.find("pullRequest", pullRequestID)
			if err := builder.addEdge("produces", node.ID, true, pullRequest, ok, item.evidence, "workflow-pr"); err != nil {
				return err
			}
		}
		if !current {
			builder.warn("informational.workflow." + item.ID)
		}
	}
	return nil
}

func addAgentRuns(builder *projectionBuilder) error {
	items := append([]agentRunObservation(nil), builder.source.Sources.AgentRuns.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := item.ObservationKind == "local_store" && (!terminalStatus(item.Status) || item.CompletedAt != nil)
		typeName, objectType := "informational.agent_run_observation", "agent_run_projection_observation"
		if current {
			typeName, objectType = "agent_run", "agent_run"
		}
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: "Agent run " + item.ID, status: statusPointer(item.Status),
			authority: authority(item.evidence, "openslack", objectType, ""), owners: builder.owners([]string{item.AgentActorID}),
			properties:     graph.Object{"agentActorId": item.AgentActorID, "currentAuthority": current, "observationKind": item.ObservationKind},
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.StartedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("agentRun", item.ID, node); err != nil {
			return err
		}
		if item.WorkflowRunID != nil {
			workflow, ok := builder.find("workflowRun", *item.WorkflowRunID)
			if err := builder.addEdge("executed_by", workflow, ok, node.ID, true, item.evidence, "workflow-agentRun"); err != nil {
				return err
			}
		}
		actor, ok := builder.find("actor", item.AgentActorID)
		if err := builder.addEdge("performed_by", node.ID, true, actor, ok, item.evidence, "agentRun-actor"); err != nil {
			return err
		}
		if item.WorktreeID != nil {
			worktree, ok := builder.find("worktree", *item.WorktreeID)
			if err := builder.addEdge("executes_in", node.ID, true, worktree, ok, item.evidence, "agentRun-worktree"); err != nil {
				return err
			}
		}
		if !current {
			builder.warn("informational.agentRun." + item.ID)
		}
	}
	worktrees := append([]worktreeObservation(nil), builder.source.Sources.Worktrees.Items...)
	sort.Slice(worktrees, func(i, j int) bool { return utf16Less(worktrees[i].ID, worktrees[j].ID) })
	for _, item := range worktrees {
		if item.AgentRunID == nil {
			continue
		}
		var agentRun agentRunObservation
		found := false
		for _, candidate := range builder.source.Sources.AgentRuns.Items {
			if candidate.ID == *item.AgentRunID {
				agentRun, found = candidate, true
				break
			}
		}
		if found && (agentRun.WorktreeID == nil || *agentRun.WorktreeID != item.WorktreeID) {
			builder.warn("inconsistent.worktree-agentRun." + item.ID)
			builder.incomplete("reference.worktree-agentRun." + item.ID)
			continue
		}
		worktree, worktreeOK := builder.find("worktree", item.WorktreeID)
		run, runOK := builder.find("agentRun", *item.AgentRunID)
		if err := builder.addEdge("hosts_run", worktree, worktreeOK, run, runOK, item.evidence, "worktree-agentRun"); err != nil {
			return err
		}
	}
	return nil
}

func addPRMSReports(builder *projectionBuilder) error {
	items := append([]prmsReportObservation(nil), builder.source.Sources.PRMSReports.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		pullRequest, found := pullRequestByID(builder.source, item.PullRequestID)
		current := item.ObservationKind == "local_store" && found && isCurrentPullRequest(pullRequest) && item.BaseSHA != nil && item.HeadSHA != nil && *item.BaseSHA == *pullRequest.BaseSHA && *item.HeadSHA == *pullRequest.HeadSHA
		typeName, objectType, title := "informational.prms_observation", "prms_projection_observation", "PRMS observation"
		if current {
			typeName, objectType, title = "prms_report", "prms_report", "PRMS current-head report"
		}
		properties := graph.Object{"blockerCount": float64(item.BlockerCount), "currentHeadBound": current, "observationKind": item.ObservationKind}
		if item.BaseSHA != nil {
			properties["baseSha"] = *item.BaseSHA
		}
		if item.HeadSHA != nil {
			properties["headSha"] = *item.HeadSHA
		}
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: title, status: statusPointer(item.Status),
			authority: authority(item.evidence, "openslack", objectType, ""), properties: properties,
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.ObservedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("prmsReport", item.ID, node); err != nil {
			return err
		}
		edgeType := "observed_assessment"
		if current {
			edgeType = "assessed_by"
		}
		pullRequestNode, ok := builder.find("pullRequest", item.PullRequestID)
		if err := builder.addEdge(edgeType, pullRequestNode, ok, node.ID, true, item.evidence, "pr-prms"); err != nil {
			return err
		}
		if !current {
			builder.incomplete("openslack.prmsReports.currentHead." + item.ID)
			builder.warn("informational.prms." + item.ID)
		}
	}
	return nil
}

func addHandoffs(builder *projectionBuilder) error {
	items := append([]handoffObservation(nil), builder.source.Sources.Handoffs.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := item.ObservationKind == "local_store"
		typeName, objectType := "informational.handoff_observation", "handoff_projection_observation"
		if current {
			typeName, objectType = "coordination.handoff", "handoff"
		}
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: "Handoff " + item.ID, status: statusPointer(item.Status),
			authority:      authority(item.evidence, "openslack", objectType, ""),
			properties:     graph.Object{"currentAuthority": current, "fromActorId": item.FromActorID, "observationKind": item.ObservationKind, "toActorId": item.ToActorID},
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.CreatedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("handoff", item.ID, node); err != nil {
			return err
		}
		from, ok := builder.find("actor", item.FromActorID)
		if err := builder.addEdge("from_actor", node.ID, true, from, ok, item.evidence, "handoff-from"); err != nil {
			return err
		}
		to, ok := builder.find("actor", item.ToActorID)
		if err := builder.addEdge("to_actor", node.ID, true, to, ok, item.evidence, "handoff-to"); err != nil {
			return err
		}
		if item.IssueID != nil {
			target, ok := builder.find("issue", *item.IssueID)
			if err := builder.addEdge("coordinates", node.ID, true, target, ok, item.evidence, "handoff-issue"); err != nil {
				return err
			}
		}
		if item.PullRequestID != nil {
			target, ok := builder.find("pullRequest", *item.PullRequestID)
			if err := builder.addEdge("coordinates", node.ID, true, target, ok, item.evidence, "handoff-pr"); err != nil {
				return err
			}
		}
		if item.WorkflowRunID != nil {
			target, ok := builder.find("workflowRun", *item.WorkflowRunID)
			if err := builder.addEdge("coordinates", node.ID, true, target, ok, item.evidence, "handoff-workflow"); err != nil {
				return err
			}
		}
		if !current {
			builder.warn("informational.handoff." + item.ID)
		}
	}
	return nil
}

func addDecisions(builder *projectionBuilder) error {
	items := append([]decisionObservation(nil), builder.source.Sources.Decisions.Items...)
	sort.Slice(items, func(i, j int) bool { return utf16Less(items[i].ID, items[j].ID) })
	for _, item := range items {
		current := item.ObservationKind == "local_store"
		typeName, objectType := "informational.decision_observation", "decision_projection_observation"
		if current {
			typeName, objectType = "governance.decision", "decision"
		}
		node, err := nodeFrom(nodeInput{
			source: builder.source, typeName: typeName, title: item.Topic, status: statusPointer(item.Status),
			authority: authority(item.evidence, "openslack", objectType, ""), owners: builder.owners([]string{item.DecidedByActorID}),
			properties:     graph.Object{"currentAuthority": current, "decidedByActorId": item.DecidedByActorID, "observationKind": item.ObservationKind},
			sourceEventIDs: item.SourceEventIDs, evidenceRefs: item.EvidenceRefs, validFrom: item.CreatedAt,
		})
		if err != nil {
			return err
		}
		if err := builder.addNode("decision", item.ID, node); err != nil {
			return err
		}
		if item.IssueID != nil {
			target, ok := builder.find("issue", *item.IssueID)
			if err := builder.addEdge("governs", node.ID, true, target, ok, item.evidence, "decision-issue"); err != nil {
				return err
			}
		}
		if item.PullRequestID != nil {
			target, ok := builder.find("pullRequest", *item.PullRequestID)
			if err := builder.addEdge("governs", node.ID, true, target, ok, item.evidence, "decision-pr"); err != nil {
				return err
			}
		}
		if item.WorkflowRunID != nil {
			target, ok := builder.find("workflowRun", *item.WorkflowRunID)
			if err := builder.addEdge("governs", node.ID, true, target, ok, item.evidence, "decision-workflow"); err != nil {
				return err
			}
		}
		if !current {
			builder.warn("informational.decision." + item.ID)
		}
	}
	return nil
}

// Project validates and projects one caller-supplied Software Delivery source
// snapshot. It performs no I/O and reads no ambient process state.
func Project(input []byte) (Result, error) {
	source, err := parseSource(input)
	if err != nil {
		return Result{}, err
	}
	if err := assertProjectionExpansionBudget(source); err != nil {
		return Result{}, err
	}
	builder := newProjectionBuilder(source)
	steps := []func(*projectionBuilder) error{
		addSourceBatchNodes, addRepositories, addActors, addIssues, addClaims, addWorktrees, addCommits,
		addPullRequests, addChecks, addReviews, addMerges, addWorkflowRuns, addAgentRuns, addPRMSReports,
		addHandoffs, addDecisions,
	}
	for _, step := range steps {
		if err := step(builder); err != nil {
			return Result{}, err
		}
	}
	nodes := make([]graph.Node, 0, len(builder.nodeOrder))
	for _, id := range builder.nodeOrder {
		nodes = append(nodes, builder.nodes[id])
	}
	edges := make([]graph.Edge, 0, len(builder.edgeOrder))
	for _, id := range builder.edgeOrder {
		edges = append(edges, builder.edges[id])
	}
	snapshot, err := graph.SealSnapshot(graph.Snapshot{
		Schema: graph.SnapshotSchema, Cursor: source.Cursor, ScenarioInstanceID: source.ScenarioInstanceID,
		GeneratedAt: source.GeneratedAt, ProjectorVersion: source.ProjectorVersion, Nodes: nodes, Edges: edges,
		Completeness: builder.completeness(),
	})
	if err != nil {
		var contractError *graph.ContractError
		if errors.As(err, &contractError) && contractError.Code == graph.ContractSchemaInvalid && contractError.Message == "contains invalid Unicode" {
			return Result{}, failure(
				graph.ContractSchemaInvalid,
				contractError.Path,
				"contains an unsafe control or Unicode character.",
			)
		}
		return Result{}, err
	}
	serialized, err := graph.SerializeSnapshot(snapshot)
	if err != nil {
		return Result{}, err
	}
	if len(serialized) > MaxProjectedBytes {
		return Result{}, failure(graph.ContractBoundExceeded, "$.sources", fmt.Sprintf("projected snapshot contains %d bytes; maximum is %d.", len(serialized), MaxProjectedBytes))
	}
	return Result{ProjectorID: ProjectorID, Snapshot: snapshot}, nil
}
