package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/testsupport"
)

func reconciliationSnapshot(
	t *testing.T,
	scenarioInstanceID string,
	cursor string,
) graphstore.Snapshot {
	t.Helper()
	value, err := graphcontract.SealSnapshot(graphcontract.Snapshot{
		Schema:             graphcontract.SnapshotSchema,
		Cursor:             cursor,
		ScenarioInstanceID: scenarioInstanceID,
		GeneratedAt:        "2026-07-30T12:34:56.123456789Z",
		ProjectorVersion:   "reconciliation-test",
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
		t.Fatal(err)
	}
	return value
}

func reconciliationInput(
	t *testing.T,
	key string,
	snapshot graphstore.Snapshot,
) graphstore.PublishInput {
	t.Helper()
	body, err := graphjson.Encode(graphjson.Object{
		"expectedCursor": graphjson.Value(nil),
		"snapshot":       graphcontract.SnapshotValue(snapshot),
	})
	if err != nil {
		t.Fatal(err)
	}
	return graphstore.PublishInput{
		IdempotencyKey:     key,
		RequestFingerprint: graphstore.ComputeSnapshotRequestFingerprint(body),
		ExpectedRevision:   0,
		Snapshot:           snapshot,
	}
}

func TestResolveCommitOutcomeReadsAcceptedReceiptAndPersistsUnknownOutcome(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := &Repository{pool: pool}
	commitErr := errors.New("injected commit response loss")

	acceptedInput := reconciliationInput(
		t,
		"reconcile-accepted",
		reconciliationSnapshot(t, "scenario-reconcile-accepted", "cursor-accepted"),
	)
	accepted, err := repository.Publish(context.Background(), acceptedInput)
	if err != nil {
		t.Fatal(err)
	}
	preparedAccepted, err := graphstore.PreparePublish(acceptedInput)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := repository.resolveCommitOutcome(preparedAccepted, commitErr)
	if err != nil {
		t.Fatalf("read accepted commit outcome: %v", err)
	}
	if recovered.Status != graphstore.ReceiptAccepted ||
		recovered.ReceiptID != accepted.ReceiptID {
		t.Fatalf("unexpected recovered accepted receipt: %+v", recovered)
	}

	pendingInput := reconciliationInput(
		t,
		"reconcile-pending",
		reconciliationSnapshot(t, "scenario-reconcile-pending", "cursor-pending"),
	)
	preparedPending, err := graphstore.PreparePublish(pendingInput)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := repository.resolveCommitOutcome(preparedPending, commitErr)
	if err != nil {
		t.Fatalf("persist reconciliation-required outcome: %v", err)
	}
	if pending.Status != graphstore.ReceiptReconciliationRequired ||
		pending.ReconciliationToken == nil ||
		pending.CommittedAt != nil {
		t.Fatalf("unexpected reconciliation-required receipt: %+v", pending)
	}
	stored, err := repository.ReadReceipt(
		context.Background(),
		pendingInput.Snapshot.ScenarioInstanceID,
		pendingInput.IdempotencyKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != graphstore.ReceiptReconciliationRequired ||
		stored.ReceiptID != pending.ReceiptID {
		t.Fatalf("reconciliation receipt was not durable: %+v", stored)
	}
	if _, _, err := repository.Current(
		context.Background(),
		pendingInput.Snapshot.ScenarioInstanceID,
	); !graphstore.IsCode(err, graphstore.ErrorNotFound) {
		t.Fatalf("reconciliation-only outcome created a graph head: %v", err)
	}
}

func TestPublishRecoversExactReceiptWhenCommitSucceedsButResponseIsLost(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	commitErr := errors.New("injected commit response loss")
	repository := &Repository{
		pool: pool,
		commitTransaction: func(ctx context.Context, transaction pgx.Tx) error {
			if err := transaction.Commit(ctx); err != nil {
				return err
			}
			return commitErr
		},
	}
	input := reconciliationInput(
		t,
		"publish-response-lost",
		reconciliationSnapshot(t, "scenario-response-lost", "cursor-response-lost"),
	)

	recovered, err := repository.Publish(context.Background(), input)
	if err != nil {
		t.Fatalf("Publish() did not reconcile committed receipt: %v", err)
	}
	if recovered.Status != graphstore.ReceiptAccepted || recovered.CommittedAt == nil {
		t.Fatalf("recovered receipt = %+v", recovered)
	}
	if _, _, err := repository.Current(context.Background(), input.Snapshot.ScenarioInstanceID); err != nil {
		t.Fatalf("committed head is not durable: %v", err)
	}
	replay, err := repository.Publish(context.Background(), input)
	if err != nil {
		t.Fatalf("replay committed request: %v", err)
	}
	if replay.Status != graphstore.ReceiptDuplicate || replay.ReceiptID != recovered.ReceiptID {
		t.Fatalf("replay receipt = %+v; recovered = %+v", replay, recovered)
	}
}
