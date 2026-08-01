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
	"testing"
	"time"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

func gs3bSnapshot(t *testing.T) graph.Snapshot {
	t.Helper()
	const scenario = "scenario-gs3b-canary"
	nodes := make([]graph.Node, 0, 3)
	for index := 1; index <= 3; index++ {
		authority := graph.AuthorityRef{
			Provider: "github", ObjectType: "issue", ObjectID: fmt.Sprintf("%d", index),
			Version: "v1", ObservedAt: "2026-08-02T00:00:00Z",
		}
		id, err := graph.DeriveNodeID(scenario, "core.work_item", authority)
		if err != nil {
			t.Fatal(err)
		}
		nodes = append(nodes, graph.Node{
			ID: id, Type: "core.work_item", ScenarioDefinitionID: "software-delivery",
			ScenarioInstanceID: scenario, Title: fmt.Sprintf("Issue %d", index),
			AuthorityRef: authority, Owners: []graph.ActorRef{}, Properties: graph.Object{},
			SourceEventIDs: []string{}, EvidenceRefs: []string{}, ProjectorVersion: "projector-v1",
			ValidFrom: "2026-08-02T00:00:00Z",
		})
	}
	snapshot, err := graph.SealSnapshot(graph.Snapshot{
		Schema: graph.SnapshotSchema, Cursor: "cursor-gs3b", ScenarioInstanceID: scenario,
		GeneratedAt: "2026-08-02T00:00:00Z", ProjectorVersion: "projector-v1",
		Nodes: nodes, Edges: []graph.Edge{}, Completeness: graph.Completeness{
			SourcesRequested: []string{"github"}, SourcesObserved: []string{"github"},
			MissingSources: []string{}, Warnings: []string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestGS3BRealGoReadCanary(t *testing.T) {
	if os.Getenv("OPENSLACK_GS3B_CROSS_LANGUAGE") != "1" {
		t.Skip("set OPENSLACK_GS3B_CROSS_LANGUAGE=1 in the reviewed cross-language gate")
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Fatal("reviewed cross-language gate requires Bun")
	}
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := gs3bSnapshot(t)
	epoch := int64(41)
	service, err := New(Options{
		Store:        &fakeStore{snapshot: snapshot},
		CursorSecret: []byte("gs3b-real-go-read-canary-cursor-secret-v1"),
		BuildSHA:     testServiceBuildSHA, CanaryRoutingEpoch: &epoch,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Clock:  fixedClock{value: time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	scriptPath := filepath.Join(
		repositoryRoot,
		"scripts",
		"organization-graph-contracts",
		"gs3b-read-canary-client.ts",
	)
	commandContext, cancelCommand := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelCommand()
	command := exec.CommandContext(
		commandContext,
		bun,
		"run",
		scriptPath,
		"--origin",
		server.URL,
		"--scenario",
		snapshot.ScenarioInstanceID,
		"--target",
		snapshot.Nodes[0].ID,
		"--build-sha",
		testServiceBuildSHA,
		"--routing-epoch",
		fmt.Sprintf("%d", epoch),
	)
	command.Dir = repositoryRoot
	output, err := command.CombinedOutput()
	if err != nil {
		if commandContext.Err() != nil {
			t.Fatalf("TypeScript canary client exceeded its qualification deadline: %v", commandContext.Err())
		}
		t.Fatalf("TypeScript canary client failed: %v\n%s", err, output)
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
	if receipt.Schema != "openslack.gs3b_cross_language_qualification.v1" ||
		receipt.Status != "LOCAL_PASS" || len(receipt.Operations) != 6 {
		t.Fatalf("unexpected qualification receipt: %#v", receipt)
	}
	want := map[string]string{
		"query": "passed", "explain": "passed", "epoch_cursor_continue": "passed",
		"legacy_cursor_rejected": "GRAPH_QUERY_CURSOR_MISMATCH",
		"build_drift_rejected":   "GRAPH_READ_CANARY_ROUTE_MISMATCH",
		"explicit_rollback":      "ts-local",
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
