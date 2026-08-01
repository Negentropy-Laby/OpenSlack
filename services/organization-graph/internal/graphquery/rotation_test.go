package graphquery

import (
	"errors"
	"fmt"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

func rotationSnapshot(t *testing.T) graphcontract.Snapshot {
	t.Helper()
	nodes := make([]graphcontract.Node, 0, 3)
	for index := 1; index <= 3; index++ {
		authority := graphcontract.AuthorityRef{
			Provider:   "github",
			ObjectType: "issue",
			ObjectID:   fmt.Sprintf("%d", index),
			Version:    "v1",
			ObservedAt: "2026-08-01T00:00:00Z",
		}
		id, err := graphcontract.DeriveNodeID("rotation-scenario", "core.work_item", authority)
		if err != nil {
			t.Fatal(err)
		}
		nodes = append(nodes, graphcontract.Node{
			ID: id, Type: "core.work_item", ScenarioDefinitionID: "software-delivery",
			ScenarioInstanceID: "rotation-scenario", Title: fmt.Sprintf("Issue %d", index),
			AuthorityRef: authority, Owners: []graphcontract.ActorRef{}, Properties: graphjson.Object{},
			SourceEventIDs: []string{}, EvidenceRefs: []string{}, ProjectorVersion: "projector-v1",
			ValidFrom: "2026-08-01T00:00:00Z",
		})
	}
	snapshot, err := graphcontract.SealSnapshot(graphcontract.Snapshot{
		Schema: graphcontract.SnapshotSchema, Cursor: "cursor-rotation", ScenarioInstanceID: "rotation-scenario",
		GeneratedAt: "2026-08-01T00:00:00Z", ProjectorVersion: "projector-v1", Nodes: nodes,
		Edges: []graphcontract.Edge{}, Completeness: graphcontract.Completeness{
			SourcesRequested: []string{"github"}, SourcesObserved: []string{"github"},
			MissingSources: []string{}, Warnings: []string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestCursorSecretRotationVerifiesPreviousAndSignsOnlyWithActive(t *testing.T) {
	snapshot := rotationSnapshot(t)
	maximum := 1
	input := Input{ScenarioInstanceID: snapshot.ScenarioInstanceID, MaxNodes: &maximum}
	oldSecret := []byte("old-cursor-secret-0123456789abcdef")
	activeSecret := []byte("active-cursor-secret-0123456789abc")

	first, err := Query(snapshot, input, Options{CursorSecret: oldSecret, NowMS: 1_000})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("old cursor issuance = %#v, %v", first, err)
	}
	oldCursor := *first.NextCursor
	input.Cursor = &oldCursor
	second, err := Query(snapshot, input, Options{
		CursorSecret: activeSecret, PreviousCursorSecret: oldSecret, NowMS: 1_001,
	})
	if err != nil || second.NextCursor == nil {
		t.Fatalf("rotated cursor verification = %#v, %v", second, err)
	}
	activeCursor := *second.NextCursor
	input.Cursor = &activeCursor
	if _, err := Query(snapshot, input, Options{CursorSecret: activeSecret, NowMS: 1_002}); err != nil {
		t.Fatalf("active secret rejected newly issued cursor: %v", err)
	}
	if _, err := Query(snapshot, input, Options{CursorSecret: oldSecret, NowMS: 1_002}); err == nil {
		t.Fatal("previous secret accepted a cursor issued after rotation")
	}
	input.Cursor = &oldCursor
	if _, err := Query(snapshot, input, Options{CursorSecret: activeSecret, NowMS: 1_002}); err == nil {
		t.Fatal("active-only configuration accepted cursor issued by removed previous secret")
	}
}

func TestCursorSecretRotationRejectsUnsafePreviousSecret(t *testing.T) {
	snapshot := rotationSnapshot(t)
	secret := []byte("active-cursor-secret-0123456789abc")
	for _, previous := range [][]byte{[]byte("short"), secret} {
		_, err := Query(snapshot, Input{ScenarioInstanceID: snapshot.ScenarioInstanceID}, Options{
			CursorSecret: secret, PreviousCursorSecret: previous, NowMS: 1_000,
		})
		var queryError *Error
		if err == nil || !errors.As(err, &queryError) || queryError.Code != ErrorInvalid {
			t.Fatalf("unsafe previous secret error = %v", err)
		}
	}
}

func TestRoutingEpochIssuesV2CursorAndRejectsCrossEpochUse(t *testing.T) {
	snapshot := rotationSnapshot(t)
	secret := []byte("active-cursor-secret-0123456789abc")
	maximum := 1
	epoch := int64(41)
	input := Input{ScenarioInstanceID: snapshot.ScenarioInstanceID, MaxNodes: &maximum}
	first, err := Query(snapshot, input, Options{
		CursorSecret: secret, RoutingEpoch: &epoch, NowMS: 1_000,
	})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("epoch cursor issuance = %#v, %v", first, err)
	}
	epochCursor := *first.NextCursor
	input.Cursor = &epochCursor
	if _, err := Query(snapshot, input, Options{
		CursorSecret: secret, RoutingEpoch: &epoch, NowMS: 1_001,
	}); err != nil {
		t.Fatalf("same epoch rejected cursor: %v", err)
	}

	for name, options := range map[string]Options{
		"legacy authority": {CursorSecret: secret, NowMS: 1_001},
		"later epoch": func() Options {
			later := int64(42)
			return Options{CursorSecret: secret, RoutingEpoch: &later, NowMS: 1_001}
		}(),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Query(snapshot, input, options)
			var queryError *Error
			if err == nil || !errors.As(err, &queryError) || queryError.Code != ErrorCursorMismatch {
				t.Fatalf("cross-epoch error = %v", err)
			}
		})
	}
}

func TestRoutingEpochRejectsLegacyCursorAndPreservesExplicitExpiry(t *testing.T) {
	snapshot := rotationSnapshot(t)
	secret := []byte("active-cursor-secret-0123456789abc")
	maximum := 1
	input := Input{ScenarioInstanceID: snapshot.ScenarioInstanceID, MaxNodes: &maximum}
	legacy, err := Query(snapshot, input, Options{CursorSecret: secret, NowMS: 1_000})
	if err != nil || legacy.NextCursor == nil {
		t.Fatalf("legacy cursor issuance = %#v, %v", legacy, err)
	}
	input.Cursor = legacy.NextCursor
	epoch := int64(41)
	_, err = Query(snapshot, input, Options{CursorSecret: secret, RoutingEpoch: &epoch, NowMS: 1_001})
	var queryError *Error
	if err == nil || !errors.As(err, &queryError) || queryError.Code != ErrorCursorMismatch {
		t.Fatalf("legacy cursor at canary epoch error = %v", err)
	}

	ttl := int64(10)
	issued, err := Query(snapshot, Input{
		ScenarioInstanceID: snapshot.ScenarioInstanceID, MaxNodes: &maximum,
	}, Options{CursorSecret: secret, RoutingEpoch: &epoch, CursorTTLMS: &ttl, NowMS: 2_000})
	if err != nil || issued.NextCursor == nil {
		t.Fatalf("expiring epoch cursor issuance = %#v, %v", issued, err)
	}
	input.Cursor = issued.NextCursor
	_, err = Query(snapshot, input, Options{
		CursorSecret: secret, RoutingEpoch: &epoch, CursorTTLMS: &ttl, NowMS: 2_010,
	})
	queryError = nil
	if err == nil || !errors.As(err, &queryError) || queryError.Code != ErrorCursorExpired {
		t.Fatalf("expired epoch cursor error = %v", err)
	}
}

func TestRoutingEpochRejectsUnsafeValues(t *testing.T) {
	snapshot := rotationSnapshot(t)
	secret := []byte("active-cursor-secret-0123456789abc")
	for _, epoch := range []int64{0, -1, maxSafeInteger + 1} {
		_, err := Query(snapshot, Input{ScenarioInstanceID: snapshot.ScenarioInstanceID}, Options{
			CursorSecret: secret, RoutingEpoch: &epoch, NowMS: 1_000,
		})
		var queryError *Error
		if err == nil || !errors.As(err, &queryError) || queryError.Code != ErrorInvalid {
			t.Fatalf("unsafe routing epoch %d error = %v", epoch, err)
		}
	}
}
