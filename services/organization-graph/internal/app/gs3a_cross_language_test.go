package app

import (
	"context"
	"encoding/json"
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

func TestGS3ARealGoReadMirror(t *testing.T) {
	if os.Getenv("OPENSLACK_GS3A_CROSS_LANGUAGE") != "1" {
		t.Skip("set OPENSLACK_GS3A_CROSS_LANGUAGE=1 in the reviewed cross-language gate")
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Fatal("reviewed cross-language gate requires Bun")
	}
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := testSnapshot(t, "cursor-1", "2026-08-01T00:00:00Z")
	service, err := New(Options{
		Store:        &fakeStore{snapshot: snapshot},
		CursorSecret: []byte("gs3a-real-go-read-mirror-cursor-secret-v1"),
		BuildSHA:     testServiceBuildSHA,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		Clock:        fixedClock{value: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)},
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	snapshotBytes, err := graph.SerializeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshotPath := filepath.Join(t.TempDir(), "snapshot.json")
	if err := os.WriteFile(snapshotPath, snapshotBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(
		repositoryRoot,
		"scripts",
		"organization-graph-contracts",
		"gs3a-read-mirror-client.ts",
	)
	commandContext, cancelCommand := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancelCommand()
	command := exec.CommandContext(
		commandContext,
		bun,
		"run",
		scriptPath,
		"--origin",
		server.URL,
		"--snapshot",
		snapshotPath,
	)
	command.Dir = repositoryRoot
	output, err := command.CombinedOutput()
	if err != nil {
		if commandContext.Err() != nil {
			t.Fatalf("TypeScript mirror client exceeded its qualification deadline: %v", commandContext.Err())
		}
		t.Fatalf("TypeScript mirror client failed: %v\n%s", err, output)
	}
	var receipt struct {
		Schema     string `json:"schema"`
		Status     string `json:"status"`
		Operations []struct {
			Operation string `json:"operation"`
			Outcome   string `json:"outcome"`
			Parity    string `json:"parity"`
		} `json:"operations"`
	}
	if err := json.Unmarshal(output, &receipt); err != nil {
		t.Fatalf("decode TypeScript qualification receipt: %v\n%s", err, output)
	}
	if receipt.Schema != "openslack.gs3a_cross_language_qualification.v1" ||
		receipt.Status != "passed" || len(receipt.Operations) != 2 ||
		receipt.Operations[0].Operation != "query" ||
		receipt.Operations[0].Outcome != "matched" ||
		receipt.Operations[0].Parity != "matched" ||
		receipt.Operations[1].Operation != "explain" ||
		receipt.Operations[1].Outcome != "matched" ||
		receipt.Operations[1].Parity != "matched" {
		t.Fatalf("unexpected TypeScript qualification receipt: %s", output)
	}
}
