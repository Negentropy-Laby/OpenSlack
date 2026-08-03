package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/app"
	shadowpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

const qualificationBuildSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestGS7BCrossLanguageShadowObservation(t *testing.T) {
	if os.Getenv("OPENSLACK_GS7B_CROSS_LANGUAGE") != "1" {
		t.Skip("GS7-B cross-language qualification is not enabled")
	}
	pool := testsupport.OpenPostgres(t)
	repository := shadowpostgres.New(pool)
	service, err := app.New(app.Options{Store: repository, BuildSHA: qualificationBuildSHA})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve GS7-B qualification path")
	}
	repositoryRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", "..", ".."))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "bun", "scripts/workflow-control-shadow-contracts/gs7b-http-client.ts")
	command.Dir = repositoryRoot
	command.Env = append(os.Environ(), "OPENSLACK_GS7B_SHADOW_ORIGIN="+server.URL)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		t.Fatalf("GS7-B TypeScript HTTP client: %v\nstderr:\n%s\nstdout:\n%s", err, stderr.String(), stdout.String())
	}
	if ctx.Err() != nil {
		t.Fatalf("GS7-B TypeScript HTTP client deadline: %v", ctx.Err())
	}
	var receipt struct {
		Schema          string `json:"schema"`
		Status          string `json:"status"`
		ReceiptStatus   string `json:"receiptStatus"`
		Parity          string `json:"parity"`
		WorkspaceID     string `json:"workspaceId"`
		RunID           string `json:"runId"`
		SourceSequence  int64  `json:"sourceSequence"`
		ObservationHash string `json:"observationHash"`
	}
	decoder := json.NewDecoder(&stdout)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		t.Fatalf("decode GS7-B TypeScript receipt: %v\n%s", err, stdout.String())
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("GS7-B TypeScript receipt has trailing output: %v\n%s", err, stdout.String())
	}
	if receipt.Schema != "openslack.gs7b_cross_language_qualification.v1" || receipt.Status != "passed" ||
		receipt.ReceiptStatus != "accepted" || receipt.Parity != "matched" ||
		receipt.WorkspaceID != "workspace.demo" || receipt.RunID != "run-gs7b-shadow" ||
		receipt.SourceSequence != 1 || len(receipt.ObservationHash) != 64 {
		t.Fatalf("GS7-B cross-language receipt drift: %+v", receipt)
	}
	projection, err := repository.Projection(context.Background(), receipt.WorkspaceID, receipt.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if projection.SourceSequence != 1 || projection.MatchedSourceSequence != 1 ||
		projection.Parity != "matched" || projection.ReadModel.Status != workflowcontrol.RunPausedWaitingApproval ||
		projection.MatchedObservationHash != receipt.ObservationHash || projection.AuthorityEligible {
		t.Fatalf("GS7-B durable projection drift: %+v", projection)
	}
}
