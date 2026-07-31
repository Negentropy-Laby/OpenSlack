package integration_test

import (
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore"
)

const (
	testScenario = "scenario-gs1b"
	generatedOne = "2026-07-30T01:00:00.000Z"
	generatedTwo = "2026-07-30T01:01:00.000Z"
)

func emptySnapshot(t testing.TB, cursor, generatedAt string) graphstore.Snapshot {
	return emptySnapshotForScenario(t, testScenario, cursor, generatedAt)
}

func emptySnapshotForScenario(
	t testing.TB,
	scenarioInstanceID string,
	cursor string,
	generatedAt string,
) graphstore.Snapshot {
	t.Helper()
	value, err := graphcontract.SealSnapshot(graphcontract.Snapshot{
		Schema:             graphcontract.SnapshotSchema,
		Cursor:             cursor,
		ScenarioInstanceID: scenarioInstanceID,
		GeneratedAt:        generatedAt,
		ProjectorVersion:   "go-shadow-gs1b",
		Nodes:              []graphcontract.Node{},
		Edges:              []graphcontract.Edge{},
		Completeness: graphcontract.Completeness{
			SourcesRequested: []string{},
			SourcesObserved:  []string{},
			MissingSources:   []string{},
			Warnings:         []string{},
		},
	})
	if err != nil {
		t.Fatalf("seal empty snapshot: %v", err)
	}
	return value
}

func snapshotWithNodes(
	t testing.TB,
	cursor string,
	generatedAt string,
	objectIDs ...string,
) graphstore.Snapshot {
	t.Helper()
	nodes := make([]graphcontract.Node, 0, len(objectIDs))
	for _, objectID := range objectIDs {
		authority := graphcontract.AuthorityRef{
			Provider:   "openslack",
			ObjectType: "test-work-item",
			ObjectID:   objectID,
			Version:    "v1",
			ObservedAt: generatedAt,
		}
		nodeID, err := graphcontract.DeriveNodeID(testScenario, "WorkItem", authority)
		if err != nil {
			t.Fatalf("derive node id: %v", err)
		}
		nodes = append(nodes, graphcontract.Node{
			ID:                   nodeID,
			Type:                 "WorkItem",
			ScenarioDefinitionID: "scenario-definition-gs1b",
			ScenarioInstanceID:   testScenario,
			Title:                "Work item " + objectID,
			AuthorityRef:         authority,
			Owners:               []graphcontract.ActorRef{},
			Properties:           graphjson.Object{"source": "integration-test"},
			SourceEventIDs:       []string{"event-" + objectID},
			EvidenceRefs:         []string{"evidence-" + objectID},
			ProjectorVersion:     "go-shadow-gs1b",
			ValidFrom:            generatedAt,
		})
	}
	value, err := graphcontract.SealSnapshot(graphcontract.Snapshot{
		Schema:             graphcontract.SnapshotSchema,
		Cursor:             cursor,
		ScenarioInstanceID: testScenario,
		GeneratedAt:        generatedAt,
		ProjectorVersion:   "go-shadow-gs1b",
		Nodes:              nodes,
		Edges:              []graphcontract.Edge{},
		Completeness: graphcontract.Completeness{
			SourcesRequested: []string{"openslack"},
			SourcesObserved:  []string{"openslack"},
			MissingSources:   []string{},
			Warnings:         []string{},
		},
	})
	if err != nil {
		t.Fatalf("seal snapshot with nodes: %v", err)
	}
	return value
}

func deltaToTarget(
	t testing.TB,
	parent graphstore.Snapshot,
	target graphstore.Snapshot,
	upsertNodes []graphcontract.Node,
) graphstore.Delta {
	t.Helper()
	value, err := graphcontract.SealDelta(graphcontract.Delta{
		Schema:             graphcontract.DeltaSchema,
		ScenarioInstanceID: testScenario,
		FromCursor:         parent.Cursor,
		ToCursor:           target.Cursor,
		GeneratedAt:        target.GeneratedAt,
		UpsertNodes:        upsertNodes,
		CloseNodeIDs:       []string{},
		UpsertEdges:        []graphcontract.Edge{},
		CloseEdgeIDs:       []string{},
		EvidenceRefs:       []string{"delta-evidence"},
	})
	if err != nil {
		t.Fatalf("seal delta: %v", err)
	}
	return value
}

func stringPointer(value string) *string { return &value }

func snapshotRequestFingerprint(
	t testing.TB,
	expectedCursor *string,
	snapshot graphstore.Snapshot,
) string {
	t.Helper()
	var expectedValue graphjson.Value
	if expectedCursor != nil {
		expectedValue = *expectedCursor
	}
	body, err := graphjson.Encode(graphjson.Object{
		"expectedCursor": expectedValue,
		"snapshot":       graphcontract.SnapshotValue(snapshot),
	})
	if err != nil {
		t.Fatalf("encode canonical snapshot request: %v", err)
	}
	return graphstore.ComputeSnapshotRequestFingerprint(body)
}

func deltaRequestFingerprint(
	t testing.TB,
	expectedCursor string,
	target graphstore.Snapshot,
	delta graphstore.Delta,
) string {
	t.Helper()
	body, err := graphjson.Encode(graphjson.Object{
		"expectedCursor": expectedCursor,
		"targetSnapshot": graphcontract.SnapshotValue(target),
		"delta":          graphcontract.DeltaValue(delta),
	})
	if err != nil {
		t.Fatalf("encode canonical delta request: %v", err)
	}
	return graphstore.ComputeDeltaRequestFingerprint(body)
}

func snapshotPublishInput(
	t testing.TB,
	key string,
	expectedCursor *string,
	expectedRevision int64,
	snapshot graphstore.Snapshot,
) graphstore.PublishInput {
	t.Helper()
	return graphstore.PublishInput{
		IdempotencyKey:     key,
		RequestFingerprint: snapshotRequestFingerprint(t, expectedCursor, snapshot),
		ExpectedCursor:     expectedCursor,
		ExpectedRevision:   expectedRevision,
		Snapshot:           snapshot,
	}
}

func deltaPublishInput(
	t testing.TB,
	key string,
	expectedCursor string,
	expectedRevision int64,
	target graphstore.Snapshot,
	delta graphstore.Delta,
) graphstore.PublishInput {
	t.Helper()
	return graphstore.PublishInput{
		IdempotencyKey:     key,
		RequestFingerprint: deltaRequestFingerprint(t, expectedCursor, target, delta),
		ExpectedCursor:     stringPointer(expectedCursor),
		ExpectedRevision:   expectedRevision,
		Snapshot:           target,
		Delta:              &delta,
	}
}
