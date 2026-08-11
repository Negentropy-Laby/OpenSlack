package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointshadowapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointshadowstore"
	checkpointpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointshadowstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

const gs9cBuildSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestGS9CQualification(t *testing.T) {
	if os.Getenv("WORKFLOW_CONTROL_GS9C_QUALIFICATION") != "1" {
		t.Skip("GS9-C PostgreSQL qualification is not enabled")
	}
	pool := testsupport.OpenPostgres(t)
	repository := checkpointpostgres.New(pool)
	service, token := gs9cService(t, repository)
	input := gs9cInput(t)
	accepted := gs9cHandlerRequest(t, service.Handler(), http.MethodPost, "/v1/shadow/workflow-control/checkpoints", input.Prepared.ExactBody, token)
	replay := gs9cHandlerRequest(t, service.Handler(), http.MethodPost, "/v1/shadow/workflow-control/checkpoints", input.Prepared.ExactBody, token)
	head := gs9cHandlerRequest(t, service.Handler(), http.MethodGet, "/v1/shadow/workflow-control/runs/run.gs9c.qualification/checkpoint-head", nil, token)
	if accepted.Code != http.StatusCreated || replay.Code != http.StatusOK || replay.Header().Get("Idempotency-Replayed") != "true" || !bytes.Equal(accepted.Body.Bytes(), replay.Body.Bytes()) || head.Code != http.StatusOK || !strings.Contains(head.Body.String(), `"goRole":"observer_only"`) {
		t.Fatalf("GS9-C qualification drift: accepted=%d replay=%d head=%d", accepted.Code, replay.Code, head.Code)
	}
}

func TestGS9CRestartQualification(t *testing.T) {
	phase := os.Getenv("WORKFLOW_CONTROL_GS9C_RESTART_PHASE")
	if phase == "" {
		t.Skip("GS9-C restart qualification is not enabled")
	}
	schema := os.Getenv("WORKFLOW_CONTROL_GS9C_RESTART_SCHEMA")
	input := gs9cInput(t)
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		if _, err := checkpointpostgres.New(pool).Observe(context.Background(), input); err != nil {
			t.Fatal(err)
		}
		pool.Close()
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		repository := checkpointpostgres.New(pool)
		replay, err := repository.Observe(context.Background(), input)
		if err != nil || !replay.Replay {
			t.Fatalf("restart replay=%#v err=%v", replay.Value, err)
		}
		head, err := repository.ReadHead(context.Background(), "workspace.gs9c", "run.gs9c.qualification")
		if err != nil || head.SourceSequence != 1 {
			t.Fatalf("restart head=%#v err=%v", head, err)
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown GS9-C restart phase %q", phase)
	}
}

func TestGS9CImageDefaultOff(t *testing.T) {
	origin := strings.TrimRight(os.Getenv("WORKFLOW_CONTROL_GS9C_DEFAULT_ORIGIN"), "/")
	if origin == "" {
		t.Skip("GS9-C image smoke origin is not configured")
	}
	version := gs9cHTTPResponse(t, http.MethodGet, origin+"/version", nil)
	data := gs9cHTTPResponse(t, http.MethodPost, origin+"/v1/shadow/workflow-control/checkpoints", []byte("{}"))
	if version.status != http.StatusOK || !strings.Contains(string(version.body), `"qualificationMode":false`) || !strings.Contains(string(version.body), `"checkpointAuthority":false`) || data.status != http.StatusNotFound {
		t.Fatalf("GS9-C default-off image drift: version=%d %s data=%d %s", version.status, version.body, data.status, data.body)
	}
}

func gs9cService(t *testing.T, store checkpointshadowstore.Store) (*checkpointshadowapp.Service, string) {
	t.Helper()
	token := strings.Repeat("qualification-token-", 2)
	digest := sha256.Sum256([]byte(token))
	service, err := checkpointshadowapp.New(checkpointshadowapp.Options{QualificationMode: true, Store: store, BuildSHA: gs9cBuildSHA, BearerTokenSHA256: hex.EncodeToString(digest[:]), WorkspaceID: "workspace.gs9c", CallerID: "runner.gs9c"})
	if err != nil {
		t.Fatal(err)
	}
	return service, token
}

func gs9cInput(t *testing.T) checkpointshadowstore.ObserveInput {
	t.Helper()
	observation := checkpointshadowstore.Observation{
		Schema: checkpointshadowstore.ObservationSchema, Authority: "typescript", GoRole: "observer_only", RunID: "run.gs9c.qualification", Revision: 2,
		WorkflowSourceHash: strings.Repeat("5", 64), ManifestHash: strings.Repeat("6", 64), InputHash: strings.Repeat("7", 64),
		Runner:     checkpointshadowstore.RunnerBinding{WorkspaceID: "workspace.gs9c", JobID: "job.gs9c", AttemptID: "attempt.gs9c", LeaseID: "lease.gs9c", FencingToken: 1, CorrelationID: "correlation.gs9c", RunnerBuildHash: strings.Repeat("1", 64)},
		Checkpoint: &checkpointshadowstore.Checkpoint{CheckpointID: "checkpoint.gs9c", PhaseID: "phase-0", PhaseIndex: 0, CommitPoint: "after_phase_work", ArtifactRef: "checkpoint-control/artifacts/gs9c.json", ArtifactHash: strings.Repeat("2", 64), CommittedRevision: 2, CommittedAt: "2026-08-12T00:00:00.000Z"},
	}
	observationBytes, err := canonicaljson.Encode(observation)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(observationBytes)
	envelope := checkpointshadowstore.Envelope{Schema: checkpointshadowstore.EnvelopeSchema, GoRole: "observer_only", SourceSequence: 1, Operation: checkpointshadowstore.OperationCheckpointCommit, Observation: observation, ObservationHash: hex.EncodeToString(digest[:])}
	body, err := canonicaljson.Encode(envelope)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := checkpointshadowstore.PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	key := checkpointshadowstore.IdempotencyPrefix + prepared.Envelope.ObservationHash
	return checkpointshadowstore.ObserveInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: checkpointshadowstore.Fingerprint(http.MethodPost, "/v1/shadow/workflow-control/checkpoints", key, body), ServiceBuildHash: gs9cBuildSHA}
}

func gs9cHandlerRequest(t *testing.T, handler http.Handler, method, path string, body []byte, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-OpenSlack-Workspace-ID", "workspace.gs9c")
	request.Header.Set("X-OpenSlack-Caller-ID", "runner.gs9c")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
		prepared, err := checkpointshadowstore.PrepareObservation(body)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Idempotency-Key", checkpointshadowstore.IdempotencyPrefix+prepared.Envelope.ObservationHash)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

type gs9cResponse struct {
	status int
	body   []byte
}

func gs9cHTTPResponse(t *testing.T, method, url string, body []byte) gs9cResponse {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
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
	return gs9cResponse{status: response.StatusCode, body: responseBody}
}
