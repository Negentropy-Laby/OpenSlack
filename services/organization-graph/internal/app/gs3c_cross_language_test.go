package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type gs3cAuthorityStore struct {
	fakeStore
	mu       sync.Mutex
	receipts map[string]Receipt
	revision int64
}

func (store *gs3cAuthorityStore) IngestSnapshot(_ context.Context, command SnapshotCommand) (Receipt, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if receipt, ok := store.receipts[command.IdempotencyKey]; ok {
		if receipt.RequestFingerprint != command.Fingerprint {
			return Receipt{}, &StoreError{Code: StoreIdempotencyConflict}
		}
		receipt.Status = ReceiptDuplicate
		return receipt, nil
	}
	store.revision++
	store.snapshot = command.Snapshot
	committedAt := "2026-08-02T00:00:00Z"
	receipt := Receipt{
		Operation: OperationSnapshotIngest, Status: ReceiptAccepted,
		IdempotencyKey: command.IdempotencyKey, RequestFingerprint: command.Fingerprint,
		ScenarioInstanceID: command.Snapshot.ScenarioInstanceID, Cursor: command.Snapshot.Cursor,
		Revision: store.revision, SnapshotIntegrityHash: command.Snapshot.IntegrityHash,
		CommittedAt: &committedAt,
	}
	store.receipts[command.IdempotencyKey] = receipt
	return receipt, nil
}

func (store *gs3cAuthorityStore) CurrentSnapshot(_ context.Context, scenario string) (CurrentSnapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.revision == 0 || store.snapshot.ScenarioInstanceID != scenario {
		return CurrentSnapshot{}, &StoreError{Code: StoreNotFound}
	}
	return CurrentSnapshot{Snapshot: store.snapshot, Revision: store.revision}, nil
}

type gs3cReconciliationStore struct{ fakeStore }

func (store *gs3cReconciliationStore) IngestSnapshot(_ context.Context, command SnapshotCommand) (Receipt, error) {
	token := "gs3c-reconcile-001"
	return Receipt{
		Operation: OperationSnapshotIngest, Status: ReceiptReconciliationRequired,
		IdempotencyKey: command.IdempotencyKey, RequestFingerprint: command.Fingerprint,
		ScenarioInstanceID: command.Snapshot.ScenarioInstanceID, Cursor: command.Snapshot.Cursor,
		Revision: 1, SnapshotIntegrityHash: command.Snapshot.IntegrityHash,
		ReconciliationToken: &token,
	}, nil
}

func gs3cService(t *testing.T, store Store, epoch int64) *Service {
	t.Helper()
	service, err := New(Options{
		Store: store, CursorSecret: []byte("gs3c-global-authority-cursor-secret-v1"),
		BuildSHA: testServiceBuildSHA, ReadAuthorityRoutingEpoch: &epoch,
		ReadAuthorityTenantID: "qualification-workspace",
		Logger:                slog.New(slog.NewTextHandler(io.Discard, nil)),
		Clock:                 fixedClock{value: time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)},
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestGS3CRealGoReadAuthority(t *testing.T) {
	if os.Getenv("OPENSLACK_GS3C_CROSS_LANGUAGE") != "1" {
		t.Skip("set OPENSLACK_GS3C_CROSS_LANGUAGE=1 in the reviewed cross-language gate")
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Fatal("reviewed cross-language gate requires Bun")
	}
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	store := &gs3cAuthorityStore{receipts: map[string]Receipt{}}
	epoch := int64(42)
	server := httptest.NewServer(gs3cService(t, store, epoch).Handler())
	defer server.Close()
	laterServer := httptest.NewServer(gs3cService(t, store, epoch+1).Handler())
	defer laterServer.Close()
	reconciliationServer := httptest.NewServer(
		gs3cService(t, &gs3cReconciliationStore{}, epoch).Handler(),
	)
	defer reconciliationServer.Close()

	scriptPath := filepath.Join(repositoryRoot, "scripts", "organization-graph-contracts", "gs3c-read-authority-client.ts")
	sourcePath := filepath.Join(repositoryRoot, "packages", "organization-graph", "src", "fixtures", "contract-to-delivery-source.json")
	commandContext, cancelCommand := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancelCommand()
	command := exec.CommandContext(
		commandContext, bun, "run", scriptPath,
		"--origin", server.URL,
		"--later-origin", laterServer.URL,
		"--reconciliation-origin", reconciliationServer.URL,
		"--source", sourcePath,
		"--tenant", "qualification-workspace",
		"--build-sha", testServiceBuildSHA,
		"--routing-epoch", fmt.Sprintf("%d", epoch),
		"--now", "2026-07-27T02:00:00Z",
	)
	command.Dir = repositoryRoot
	output, err := command.CombinedOutput()
	if err != nil {
		if commandContext.Err() != nil {
			t.Fatalf("TypeScript authority client exceeded its qualification deadline: %v", commandContext.Err())
		}
		t.Fatalf("TypeScript authority client failed: %v\n%s", err, output)
	}
	var receipt struct {
		Schema     string `json:"schema"`
		Status     string `json:"status"`
		Operations []struct {
			Operation string `json:"operation"`
			Status    string `json:"status"`
		} `json:"operations"`
	}
	if err := json.Unmarshal(output, &receipt); err != nil {
		t.Fatalf("decode TypeScript qualification receipt: %v\n%s", err, output)
	}
	if receipt.Schema != "openslack.gs3c_cross_language_qualification.v1" ||
		receipt.Status != "LOCAL_PASS" || len(receipt.Operations) != 9 {
		t.Fatalf("unexpected qualification receipt: %#v", receipt)
	}
	want := map[string]string{
		"durable_ingest": "accepted", "receipt_replay": "duplicate",
		"query_go_head": "passed", "explain_go_head": "passed",
		"epoch_cursor_continue":       "passed",
		"legacy_cursor_rejected":      "GRAPH_QUERY_CURSOR_MISMATCH",
		"cross_epoch_cursor_rejected": "GRAPH_QUERY_CURSOR_MISMATCH",
		"reconciliation_blocked":      "GRAPH_AUTHORITY_RECONCILIATION_REQUIRED",
		"explicit_global_rollback":    "ts-local",
	}
	for _, operation := range receipt.Operations {
		if want[operation.Operation] != operation.Status {
			t.Fatalf("unexpected qualification operation: %#v", operation)
		}
		delete(want, operation.Operation)
	}
	if len(want) != 0 {
		t.Fatalf("missing qualification operations: %v", want)
	}
}
