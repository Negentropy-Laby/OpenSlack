package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/app"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore"
	shadowpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

const qualificationBuildSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestShadowServerRequiresSchemaVersionThree(t *testing.T) {
	if requiredSchemaVersion != 3 {
		t.Fatalf("schema version=%d", requiredSchemaVersion)
	}
}

func TestGS7BQualification(t *testing.T) {
	if os.Getenv("WORKFLOW_CONTROL_GS7B_QUALIFICATION") != "1" {
		t.Skip("GS7-B PostgreSQL qualification is not enabled")
	}
	pool := testsupport.OpenPostgres(t)
	repository := shadowpostgres.New(pool)
	service, err := app.New(app.Options{Store: repository, BuildSHA: qualificationBuildSHA})
	if err != nil {
		t.Fatal(err)
	}
	handler := service.Handler()
	input := testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))
	accepted := qualificationHandlerRequest(t, handler, http.MethodPost, app.RouteObservation, input.IdempotencyKey, input.ExactBody, nil)
	duplicate := qualificationHandlerRequest(t, handler, http.MethodPost, app.RouteObservation, input.IdempotencyKey, input.ExactBody, nil)
	projection := qualificationHandlerRequest(t, handler, http.MethodGet, "/v1/shadow/workflow-control/runs/"+testsupport.RunID+"/projection", "", nil, map[string]string{app.HeaderWorkspaceID: testsupport.WorkspaceID})
	if accepted.Code != http.StatusCreated || !strings.Contains(accepted.Body.String(), `"status":"accepted"`) ||
		duplicate.Code != http.StatusOK || !strings.Contains(duplicate.Body.String(), `"status":"duplicate"`) ||
		projection.Code != http.StatusOK || !strings.Contains(projection.Body.String(), `"matchedSourceSequence":1`) {
		t.Fatalf("GS7-B qualification drift: accepted=%d %s duplicate=%d %s projection=%d %s", accepted.Code, accepted.Body.String(), duplicate.Code, duplicate.Body.String(), projection.Code, projection.Body.String())
	}
}

func TestGS7BRestartQualification(t *testing.T) {
	phase := os.Getenv("WORKFLOW_CONTROL_GS7B_RESTART_PHASE")
	if phase == "" {
		t.Skip("GS7-B restart qualification is not enabled")
	}
	schema := os.Getenv("WORKFLOW_CONTROL_GS7B_RESTART_SCHEMA")
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		receipt, err := shadowpostgres.New(pool).Observe(context.Background(), testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning)))
		if err != nil || receipt.Status != shadowstore.ReceiptAccepted {
			t.Fatalf("restart seed receipt=%+v err=%v", receipt, err)
		}
		pool.Close()
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		repository := shadowpostgres.New(pool)
		receipt, err := repository.Observe(context.Background(), testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning)))
		if err != nil || receipt.Status != shadowstore.ReceiptDuplicate {
			t.Fatalf("restart replay receipt=%+v err=%v", receipt, err)
		}
		projection, err := repository.Projection(context.Background(), testsupport.WorkspaceID, testsupport.RunID)
		if err != nil || projection.SourceSequence != 1 || projection.MatchedSourceSequence != 1 {
			t.Fatalf("restart projection=%+v err=%v", projection, err)
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown GS7-B restart phase %q", phase)
	}
}

func TestGS7BImageSmoke(t *testing.T) {
	origin := strings.TrimRight(os.Getenv("WORKFLOW_CONTROL_GS7B_SMOKE_ORIGIN"), "/")
	if origin == "" {
		t.Skip("GS7-B image smoke origin is not configured")
	}
	input := testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))
	accepted := qualificationHTTPResponse(t, origin+app.RouteObservation, http.MethodPost, input.IdempotencyKey, input.ExactBody, nil)
	projection := qualificationHTTPResponse(t, origin+"/v1/shadow/workflow-control/runs/"+testsupport.RunID+"/projection", http.MethodGet, "", nil, map[string]string{app.HeaderWorkspaceID: testsupport.WorkspaceID})
	version := qualificationHTTPResponse(t, origin+app.RouteVersion, http.MethodGet, "", nil, nil)
	if accepted.status != http.StatusCreated || !strings.Contains(string(accepted.body), `"status":"accepted"`) ||
		projection.status != http.StatusOK || !strings.Contains(string(projection.body), `"matchedSourceSequence":1`) ||
		version.status != http.StatusOK || !strings.Contains(string(version.body), `"mode":"shadow-only"`) {
		t.Fatalf("GS7-B image smoke drift: accepted=%d %s projection=%d %s version=%d %s", accepted.status, accepted.body, projection.status, projection.body, version.status, version.body)
	}
}

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

type qualificationResponse struct {
	status int
	body   []byte
}

func qualificationHandlerRequest(t *testing.T, handler http.Handler, method, path, key string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func qualificationHTTPResponse(t *testing.T, url, method, key string, body []byte, headers map[string]string) qualificationResponse {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	return qualificationResponse{status: response.StatusCode, body: responseBody}
}
