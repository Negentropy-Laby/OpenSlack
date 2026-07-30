package main

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/app"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore"
)

type fakeGraphStore struct {
	receipt      graphstore.Receipt
	receiptErr   error
	head         graphstore.Head
	stored       graphstore.StoredSnapshot
	published    graphstore.Receipt
	publishErr   error
	publishInput []graphstore.PublishInput
	currentCalls int
	currentErr   error
	heads        []graphstore.Head
	statistics   graphstore.Statistics
}

func (store *fakeGraphStore) Publish(_ context.Context, input graphstore.PublishInput) (graphstore.Receipt, error) {
	store.publishInput = append(store.publishInput, input)
	return store.published, store.publishErr
}

func (store *fakeGraphStore) Current(context.Context, string) (graphstore.Head, graphstore.StoredSnapshot, error) {
	store.currentCalls++
	return store.head, store.stored, store.currentErr
}

func (store *fakeGraphStore) ReadSnapshot(context.Context, string, string) (graphstore.StoredSnapshot, error) {
	return store.stored, nil
}

func (store *fakeGraphStore) ReadDelta(context.Context, string, string, string) (graphstore.StoredDelta, error) {
	return graphstore.StoredDelta{}, nil
}

func (store *fakeGraphStore) ListSnapshots(context.Context, string, int64, int) ([]graphstore.StoredSnapshot, error) {
	return nil, nil
}

func (store *fakeGraphStore) ListDeltas(context.Context, string, int64, int) ([]graphstore.StoredDelta, error) {
	return nil, nil
}

func (store *fakeGraphStore) ListHeads(context.Context, int) ([]graphstore.Head, error) {
	return append([]graphstore.Head(nil), store.heads...), nil
}

func (store *fakeGraphStore) ReadReceipt(context.Context, string, string) (graphstore.Receipt, error) {
	return store.receipt, store.receiptErr
}

func (store *fakeGraphStore) Statistics(context.Context) (graphstore.Statistics, error) {
	return store.statistics, nil
}

func TestResolveExpectedRevisionAllowsIdempotentReplayToReachStore(t *testing.T) {
	existing := graphstore.Receipt{Revision: 3}
	store := &fakeGraphStore{
		receipt: existing,
		published: graphstore.Receipt{
			Schema:                graphstore.ReceiptSchema,
			Operation:             graphstore.OperationSnapshot,
			Status:                graphstore.ReceiptDuplicate,
			IdempotencyKey:        "key",
			RequestFingerprint:    "sha256:" + strings.Repeat("0", 64),
			ScenarioInstanceID:    "scenario",
			Cursor:                "cursor-3",
			Revision:              3,
			SnapshotIntegrityHash: "sha256:" + strings.Repeat("1", 64),
			CommittedAt:           timePointer(time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC)),
		},
	}
	adapter := &storeAdapter{store: store}
	expected := "cursor-2"
	_, err := adapter.IngestSnapshot(context.Background(), app.SnapshotCommand{
		IdempotencyKey: "key",
		Fingerprint:    "sha256:" + strings.Repeat("0", 64),
		ExpectedCursor: &expected,
		Snapshot: graphstore.Snapshot{
			ScenarioInstanceID: "scenario",
		},
	})
	if err != nil {
		t.Fatalf("IngestSnapshot() error = %v", err)
	}
	if store.currentCalls != 0 {
		t.Fatalf("Current called %d times before replay", store.currentCalls)
	}
	if len(store.publishInput) != 1 || store.publishInput[0].ExpectedRevision != 2 {
		t.Fatalf("Publish input = %#v", store.publishInput)
	}
}

func TestResolveExpectedRevisionUsesZeroForInitialReplay(t *testing.T) {
	store := &fakeGraphStore{receipt: graphstore.Receipt{Revision: 1}}
	adapter := &storeAdapter{store: store}
	revision, err := adapter.resolveExpectedRevision(context.Background(), "scenario", "key", nil)
	if err != nil {
		t.Fatal(err)
	}
	if revision != 0 || store.currentCalls != 0 {
		t.Fatalf("revision/currentCalls = %d/%d", revision, store.currentCalls)
	}
}

func TestResolveExpectedRevisionReadsCurrentOnlyWhenReceiptIsMissing(t *testing.T) {
	cursor := "cursor-7"
	store := &fakeGraphStore{
		receiptErr: graphstore.Failure(graphstore.ErrorNotFound, "missing", errors.New("no rows")),
		head:       graphstore.Head{Cursor: cursor, Revision: 7},
	}
	adapter := &storeAdapter{store: store}
	revision, err := adapter.resolveExpectedRevision(context.Background(), "scenario", "new-key", &cursor)
	if err != nil {
		t.Fatal(err)
	}
	if revision != 7 || store.currentCalls != 1 {
		t.Fatalf("revision/currentCalls = %d/%d", revision, store.currentCalls)
	}
}

func TestIngestSnapshotMapsMissingExpectedHeadToConflict(t *testing.T) {
	store := &fakeGraphStore{
		receiptErr: graphstore.Failure(graphstore.ErrorNotFound, "missing receipt", nil),
		currentErr: graphstore.Failure(graphstore.ErrorNotFound, "missing head", nil),
	}
	adapter := &storeAdapter{store: store}
	expected := "cursor-1"

	_, err := adapter.IngestSnapshot(context.Background(), app.SnapshotCommand{
		IdempotencyKey: "new-key",
		Fingerprint:    "sha256:" + strings.Repeat("0", 64),
		ExpectedCursor: &expected,
		Snapshot: graphstore.Snapshot{
			ScenarioInstanceID: "scenario",
		},
	})

	var storeFailure *app.StoreError
	if !errors.As(err, &storeFailure) || storeFailure.Code != app.StoreConflict {
		t.Fatalf("IngestSnapshot() error = %v, want StoreConflict", err)
	}
	if len(store.publishInput) != 0 {
		t.Fatalf("Publish called %d times after missing expected head", len(store.publishInput))
	}
}

func TestListScenariosChecksCountBeforeBoundedHeadList(t *testing.T) {
	store := &fakeGraphStore{
		statistics: graphstore.Statistics{PublishedScenarios: maxScenarioList + 1},
	}
	adapter := &storeAdapter{store: store}
	_, err := adapter.ListScenarios(context.Background())
	var storeFailure *app.StoreError
	if !errors.As(err, &storeFailure) || storeFailure.Code != app.StoreTooLarge {
		t.Fatalf("ListScenarios() error = %v", err)
	}
}

func TestStartupFailureLoggingNeverIncludesRawCredentialError(t *testing.T) {
	const sentinel = "password-sentinel"
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	_ = errors.New("postgres://graph:" + sentinel + "@db/graph")
	logFailure(logger, "graph_service_database_not_ready", "DATABASE_OR_SCHEMA_NOT_READY")
	if strings.Contains(output.String(), sentinel) || strings.Contains(output.String(), "postgres://") {
		t.Fatalf("log exposed credential-bearing error: %s", output.String())
	}
}

func timePointer(value time.Time) *time.Time { return &value }
