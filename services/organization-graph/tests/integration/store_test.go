package integration_test

import (
	"bytes"
	"context"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore"
	graphpostgres "github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/testsupport"
)

func TestPublishPersistsCanonicalBytesAndDurableIdempotencyReceipt(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	store := graphpostgres.New(pool)
	snapshot := emptySnapshot(t, "cursor-001", generatedOne)
	input := snapshotPublishInput(t, "publish-empty-001", nil, 0, snapshot)

	accepted, err := store.Publish(context.Background(), input)
	if err != nil {
		t.Fatalf("publish initial snapshot: %v", err)
	}
	if accepted.Status != graphstore.ReceiptAccepted ||
		accepted.Schema != graphstore.ReceiptSchema ||
		accepted.Operation != graphstore.OperationSnapshot ||
		accepted.Revision != 1 ||
		accepted.CommittedAt == nil ||
		accepted.ReconciliationToken != nil {
		t.Fatalf("unexpected accepted receipt: %+v", accepted)
	}

	duplicate, err := store.Publish(context.Background(), input)
	if err != nil {
		t.Fatalf("replay initial snapshot: %v", err)
	}
	if duplicate.Status != graphstore.ReceiptDuplicate ||
		duplicate.ReceiptID != accepted.ReceiptID ||
		duplicate.RequestFingerprint != accepted.RequestFingerprint {
		t.Fatalf("unexpected duplicate receipt: %+v", duplicate)
	}

	changedInput := input
	changedInput.Snapshot = emptySnapshot(t, "cursor-other", generatedTwo)
	changedInput.RequestFingerprint = snapshotRequestFingerprint(
		t,
		changedInput.ExpectedCursor,
		changedInput.Snapshot,
	)
	if _, err := store.Publish(context.Background(), changedInput); !graphstore.IsCode(
		err,
		graphstore.ErrorIdempotencyConflict,
	) {
		t.Fatalf("same key with changed canonical request got %v", err)
	}

	persisted, err := store.ReadReceipt(context.Background(), testScenario, input.IdempotencyKey)
	if err != nil {
		t.Fatalf("read durable receipt: %v", err)
	}
	if persisted.Status != graphstore.ReceiptAccepted ||
		persisted.ReceiptID != accepted.ReceiptID {
		t.Fatalf("stored receipt changed: %+v", persisted)
	}

	head, current, err := store.Current(context.Background(), testScenario)
	if err != nil {
		t.Fatalf("read current snapshot: %v", err)
	}
	wantBytes, err := graphcontract.SerializeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if head.Cursor != snapshot.Cursor ||
		head.Revision != 1 ||
		head.GeneratedAt != snapshot.GeneratedAt ||
		current.Revision != 1 ||
		!bytes.Equal(current.CanonicalBytes, wantBytes) {
		t.Fatalf("current snapshot does not preserve canonical bytes: head=%+v", head)
	}

	listed, err := store.ListSnapshots(context.Background(), testScenario, 0, 10)
	if err != nil {
		t.Fatalf("list snapshots: %v", err)
	}
	if len(listed) != 1 || listed[0].Snapshot.Cursor != snapshot.Cursor {
		t.Fatalf("unexpected snapshot list: %+v", listed)
	}
	statistics, err := store.Statistics(context.Background())
	if err != nil {
		t.Fatalf("read statistics: %v", err)
	}
	if statistics.PublishedScenarios != 1 ||
		statistics.PublishedHeadRevisionMax != 1 ||
		statistics.ReconciliationPending != 0 {
		t.Fatalf("unexpected store statistics: %+v", statistics)
	}
}

func TestDeltaUsesDatabaseCurrentParentAndReconstructsTargetExactly(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	store := graphpostgres.New(pool)
	parent := emptySnapshot(t, "cursor-001", generatedOne)
	if _, err := store.Publish(
		context.Background(),
		snapshotPublishInput(t, "publish-parent", nil, 0, parent),
	); err != nil {
		t.Fatalf("publish parent: %v", err)
	}

	target := snapshotWithNodes(t, "cursor-002", generatedTwo, "work-1")
	delta := deltaToTarget(t, parent, target, target.Nodes)
	if _, err := store.Publish(
		context.Background(),
		deltaPublishInput(t, "publish-target", parent.Cursor, 1, target, delta),
	); err != nil {
		t.Fatalf("publish delta target: %v", err)
	}

	storedDelta, err := store.ReadDelta(
		context.Background(),
		testScenario,
		parent.Cursor,
		target.Cursor,
	)
	if err != nil {
		t.Fatalf("read delta: %v", err)
	}
	wantDeltaBytes, err := graphcontract.SerializeDelta(delta)
	if err != nil {
		t.Fatal(err)
	}
	if storedDelta.Revision != 2 ||
		!bytes.Equal(storedDelta.CanonicalBytes, wantDeltaBytes) {
		t.Fatalf("stored delta is not the canonical authority: %+v", storedDelta)
	}

	deltas, err := store.ListDeltas(context.Background(), testScenario, 0, 10)
	if err != nil {
		t.Fatalf("list deltas: %v", err)
	}
	if len(deltas) != 1 || deltas[0].Delta.ToCursor != target.Cursor {
		t.Fatalf("unexpected delta list: %+v", deltas)
	}

	invalidTarget := snapshotWithNodes(t, "cursor-003", "2026-07-30T01:02:00.000Z", "work-1", "work-2")
	invalidDelta := deltaToTarget(t, target, invalidTarget, []graphcontract.Node{})
	if _, err := store.Publish(
		context.Background(),
		deltaPublishInput(
			t,
			"publish-invalid-target",
			target.Cursor,
			2,
			invalidTarget,
			invalidDelta,
		),
	); !graphstore.IsCode(err, graphstore.ErrorContentInvalid) {
		t.Fatalf("non-reconstructing delta got %v", err)
	}
	head, _, err := store.Current(context.Background(), testScenario)
	if err != nil {
		t.Fatal(err)
	}
	if head.Cursor != target.Cursor || head.Revision != 2 {
		t.Fatalf("invalid delta advanced head: %+v", head)
	}
	if _, err := store.ReadSnapshot(
		context.Background(),
		testScenario,
		invalidTarget.Cursor,
	); !graphstore.IsCode(err, graphstore.ErrorNotFound) {
		t.Fatalf("invalid delta left a target snapshot: %v", err)
	}
}

func TestExpectedCursorAndRevisionCASAllowsOneConcurrentWriter(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	store := graphpostgres.New(pool)
	parent := emptySnapshot(t, "cursor-001", generatedOne)
	if _, err := store.Publish(
		context.Background(),
		snapshotPublishInput(t, "cas-parent", nil, 0, parent),
	); err != nil {
		t.Fatal(err)
	}

	inputs := []graphstore.PublishInput{
		snapshotPublishInput(
			t,
			"cas-writer-a",
			stringPointer(parent.Cursor),
			1,
			emptySnapshot(t, "cursor-writer-a", generatedTwo),
		),
		snapshotPublishInput(
			t,
			"cas-writer-b",
			stringPointer(parent.Cursor),
			1,
			emptySnapshot(t, "cursor-writer-b", generatedTwo),
		),
	}
	var wait sync.WaitGroup
	wait.Add(len(inputs))
	results := make(chan error, len(inputs))
	for _, input := range inputs {
		input := input
		go func() {
			defer wait.Done()
			_, err := store.Publish(context.Background(), input)
			results <- err
		}()
	}
	wait.Wait()
	close(results)

	accepted := 0
	conflicted := 0
	for err := range results {
		switch {
		case err == nil:
			accepted++
		case graphstore.IsCode(err, graphstore.ErrorCursorConflict):
			conflicted++
		default:
			t.Fatalf("unexpected concurrent publish result: %v", err)
		}
	}
	if accepted != 1 || conflicted != 1 {
		t.Fatalf("accepted=%d conflicted=%d, want 1/1", accepted, conflicted)
	}
	head, _, err := store.Current(context.Background(), testScenario)
	if err != nil {
		t.Fatal(err)
	}
	if head.Revision != 2 ||
		(head.Cursor != "cursor-writer-a" && head.Cursor != "cursor-writer-b") {
		t.Fatalf("unexpected CAS head: %+v", head)
	}
	snapshots, err := store.ListSnapshots(context.Background(), testScenario, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("lost CAS writer left immutable state: %d snapshots", len(snapshots))
	}
}

func TestReceiptFailureRollsBackSnapshotAndHead(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	if _, err := pool.Exec(context.Background(), `
CREATE FUNCTION reject_graph_receipt_for_test()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'injected receipt failure';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER reject_graph_receipt_insert_for_test
BEFORE INSERT ON graph_ingest_receipts
FOR EACH ROW EXECUTE FUNCTION reject_graph_receipt_for_test()`); err != nil {
		t.Fatalf("install receipt fault: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `
DROP TRIGGER IF EXISTS reject_graph_receipt_insert_for_test ON graph_ingest_receipts;
DROP FUNCTION IF EXISTS reject_graph_receipt_for_test()`)
	})

	store := graphpostgres.New(pool)
	snapshot := emptySnapshot(t, "cursor-rollback", generatedOne)
	if _, err := store.Publish(
		context.Background(),
		snapshotPublishInput(t, "receipt-failure", nil, 0, snapshot),
	); err == nil {
		t.Fatal("receipt failure unexpectedly committed")
	}
	if _, _, err := store.Current(
		context.Background(),
		testScenario,
	); !graphstore.IsCode(err, graphstore.ErrorNotFound) {
		t.Fatalf("receipt failure left a head: %v", err)
	}
	if _, err := store.ReadSnapshot(
		context.Background(),
		testScenario,
		snapshot.Cursor,
	); !graphstore.IsCode(err, graphstore.ErrorNotFound) {
		t.Fatalf("receipt failure left a snapshot: %v", err)
	}
}

func TestImmutableTablesRejectUpdateAndDelete(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	store := graphpostgres.New(pool)
	snapshot := emptySnapshot(t, "cursor-immutable", generatedOne)
	receipt, err := store.Publish(
		context.Background(),
		snapshotPublishInput(t, "immutable-receipt", nil, 0, snapshot),
	)
	if err != nil {
		t.Fatal(err)
	}
	for name, statement := range map[string]string{
		"snapshot update": `UPDATE graph_snapshots SET canonical_bytes = canonical_bytes
			WHERE scenario_instance_id = 'scenario-gs1b'`,
		"snapshot delete": `DELETE FROM graph_snapshots
			WHERE scenario_instance_id = 'scenario-gs1b'`,
		"receipt delete": `DELETE FROM graph_ingest_receipts
			WHERE receipt_id = '` + receipt.ReceiptID + `'`,
	} {
		if _, err := pool.Exec(context.Background(), statement); err == nil {
			t.Fatalf("%s unexpectedly succeeded", name)
		}
	}
}

func TestMissingReadsReturnStableNotFound(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	store := graphpostgres.New(pool)
	if _, _, err := store.Current(
		context.Background(),
		"missing-scenario",
	); !graphstore.IsCode(err, graphstore.ErrorNotFound) {
		t.Fatalf("missing current got %v", err)
	}
	if _, err := store.ReadReceipt(
		context.Background(),
		"missing-scenario",
		"missing-key",
	); !graphstore.IsCode(err, graphstore.ErrorNotFound) {
		t.Fatalf("missing receipt got %v", err)
	}
	if _, err := store.ListSnapshots(
		context.Background(),
		"missing-scenario",
		0,
		10,
	); err != nil {
		t.Fatalf("empty list failed: %v", err)
	}
}

func TestListHeadsReturnsOnlyPublishedHeadsInStableOrder(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	store := graphpostgres.New(pool)

	scenarios := []string{"scenario-z", "scenario-a", "scenario-m"}
	for index, scenario := range scenarios {
		sealed := emptySnapshotForScenario(
			t,
			scenario,
			"cursor-list-head",
			generatedOne,
		)
		key := "list-head-" + scenario
		if _, err := store.Publish(
			context.Background(),
			snapshotPublishInput(t, key, nil, 0, sealed),
		); err != nil {
			t.Fatalf("publish scenario %d: %v", index, err)
		}
	}
	orphan := emptySnapshotForScenario(
		t,
		"scenario-orphan",
		"cursor-unpublished",
		generatedOne,
	)
	orphanBytes, err := graphcontract.SerializeSnapshot(orphan)
	if err != nil {
		t.Fatal(err)
	}
	orphanGeneratedAt, err := time.Parse(time.RFC3339Nano, orphan.GeneratedAt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		context.Background(),
		`INSERT INTO graph_snapshots (
			scenario_instance_id, cursor, revision, canonical_bytes,
			integrity_hash, projector_version, generated_at
		) VALUES ($1, $2, 1, $3, $4, $5, $6)`,
		orphan.ScenarioInstanceID,
		orphan.Cursor,
		orphanBytes,
		orphan.IntegrityHash,
		orphan.ProjectorVersion,
		orphanGeneratedAt,
	); err != nil {
		t.Fatalf("insert unpublished snapshot: %v", err)
	}

	heads, err := store.ListHeads(context.Background(), 2)
	if err != nil {
		t.Fatalf("list bounded heads: %v", err)
	}
	if len(heads) != 2 {
		t.Fatalf("got %d heads, want 2", len(heads))
	}
	gotIDs := []string{heads[0].ScenarioInstanceID, heads[1].ScenarioInstanceID}
	wantIDs := append([]string(nil), scenarios...)
	sort.Strings(wantIDs)
	wantIDs = wantIDs[:2]
	if gotIDs[0] != wantIDs[0] || gotIDs[1] != wantIDs[1] {
		t.Fatalf("head order = %v, want %v", gotIDs, wantIDs)
	}
	for _, head := range heads {
		if head.GeneratedAt != generatedOne ||
			head.Cursor != "cursor-list-head" ||
			head.Revision != 1 {
			t.Fatalf("unexpected listed head: %+v", head)
		}
	}
	allHeads, err := store.ListHeads(context.Background(), 10)
	if err != nil {
		t.Fatalf("list all heads: %v", err)
	}
	if len(allHeads) != len(scenarios) {
		t.Fatalf("unpublished snapshots leaked into heads: %+v", allHeads)
	}
	if _, err := store.ListHeads(context.Background(), 0); !graphstore.IsCode(
		err,
		graphstore.ErrorInvalidInput,
	) {
		t.Fatalf("zero head limit got %v", err)
	}
	if _, err := store.ListHeads(
		context.Background(),
		graphstore.MaxScenarioList+1,
	); !graphstore.IsCode(err, graphstore.ErrorInvalidInput) {
		t.Fatalf("oversized head limit got %v", err)
	}
}
