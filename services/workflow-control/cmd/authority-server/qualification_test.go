package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authorityapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	authoritypostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

const (
	qualificationBuildSHA        = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	qualificationBearer          = "openslack-workflow-authority-gs9b-local-qualification"
	qualificationCaller          = "typescript:workflow-control-qualification"
	qualificationWorkspace       = "workspace.demo"
	qualificationRunID           = "run-gs9b-authority"
	qualificationEpoch     int64 = 9
)

func TestGS9BQualification(t *testing.T) {
	if os.Getenv("WORKFLOW_CONTROL_GS9B_QUALIFICATION") != "1" {
		t.Skip("GS9-B PostgreSQL qualification is not enabled")
	}
	pool := testsupport.OpenPostgres(t)
	service := qualificationService(t, authoritypostgres.New(pool))

	acceptBody := qualificationRequestBody(t, authoritystore.OperationAccept, 0, nil, authoritycontract.RunCreated, 1)
	accepted := qualificationMutation(t, service.Handler(), authorityapp.RouteAccept, acceptBody)
	replay := qualificationMutation(t, service.Handler(), authorityapp.RouteAccept, acceptBody)
	if accepted.Code != http.StatusCreated || replay.Code != http.StatusOK || accepted.Body.String() != replay.Body.String() ||
		replay.Header().Get(authorityapp.HeaderReplay) != "true" || strings.Contains(replay.Body.String(), `"status":"duplicate"`) {
		t.Fatalf("accept/replay drift: accepted=%d %s replay=%d %s", accepted.Code, accepted.Body.String(), replay.Code, replay.Body.String())
	}

	created := authoritycontract.RunCreated
	transitionBody := qualificationRequestBody(t, authoritystore.OperationTransition, 1, &created, authoritycontract.RunRunning, 2)
	transitionPath := "/v1/workflow-control/runs/" + qualificationRunID + ":transition"
	transitioned := qualificationMutation(t, service.Handler(), transitionPath, transitionBody)
	if transitioned.Code != http.StatusCreated || !strings.Contains(transitioned.Body.String(), `"acceptedRevision":2`) {
		t.Fatalf("transition drift: %d %s", transitioned.Code, transitioned.Body.String())
	}
	transitionKey := authoritystore.ExpectedIdempotencyKey(transitionBody)
	for label, path := range map[string]string{
		"run":     "/v1/workflow-control/runs/" + qualificationRunID,
		"receipt": "/v1/workflow-control/receipts/" + transitionKey,
		"outbox":  "/v1/workflow-control/runs/" + qualificationRunID + "/outbox/2:pending",
	} {
		response := qualificationRead(t, service.Handler(), path)
		if response.Code != http.StatusOK {
			t.Fatalf("%s read failed: %d %s", label, response.Code, response.Body.String())
		}
	}
	run := qualificationRead(t, service.Handler(), "/v1/workflow-control/runs/"+qualificationRunID)
	if !strings.Contains(run.Body.String(), `"revision":2`) || !strings.Contains(run.Body.String(), `"state":"running"`) {
		t.Fatalf("run head drifted: %s", run.Body.String())
	}
	outbox := qualificationRead(t, service.Handler(), "/v1/workflow-control/runs/"+qualificationRunID+"/outbox/2:pending")
	if !strings.Contains(outbox.Body.String(), `"status":"pending"`) || !strings.Contains(outbox.Body.String(), `"eventType":"workflow_control.run_transitioned"`) {
		t.Fatalf("outbox drifted: %s", outbox.Body.String())
	}
}

func TestGS9BRestartQualification(t *testing.T) {
	phase := os.Getenv("WORKFLOW_CONTROL_GS9B_RESTART_PHASE")
	if phase == "" {
		t.Skip("GS9-B restart qualification is not enabled")
	}
	schema := os.Getenv("WORKFLOW_CONTROL_GS9B_RESTART_SCHEMA")
	body := qualificationRequestBody(t, authoritystore.OperationAccept, 0, nil, authoritycontract.RunCreated, 1)
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		service := qualificationService(t, authoritypostgres.New(pool))
		response := qualificationMutation(t, service.Handler(), authorityapp.RouteAccept, body)
		if response.Code != http.StatusCreated {
			t.Fatalf("restart seed failed: %d %s", response.Code, response.Body.String())
		}
		pool.Close()
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		service := qualificationService(t, authoritypostgres.New(pool))
		replay := qualificationMutation(t, service.Handler(), authorityapp.RouteAccept, body)
		if replay.Code != http.StatusOK || replay.Header().Get(authorityapp.HeaderReplay) != "true" ||
			!strings.Contains(replay.Body.String(), `"status":"accepted"`) {
			t.Fatalf("restart replay failed: %d %s", replay.Code, replay.Body.String())
		}
		acceptKey := authoritystore.ExpectedIdempotencyKey(body)
		for label, path := range map[string]string{
			"receipt-1": "/v1/workflow-control/receipts/" + acceptKey,
			"outbox-1":  "/v1/workflow-control/runs/" + qualificationRunID + "/outbox/1:pending",
		} {
			response := qualificationRead(t, service.Handler(), path)
			if response.Code != http.StatusOK {
				t.Fatalf("restart %s failed: %d %s", label, response.Code, response.Body.String())
			}
		}
		created := authoritycontract.RunCreated
		transitionBody := qualificationRequestBody(t, authoritystore.OperationTransition, 1, &created, authoritycontract.RunRunning, 2)
		transition := qualificationMutation(t, service.Handler(), "/v1/workflow-control/runs/"+qualificationRunID+":transition", transitionBody)
		if transition.Code != http.StatusCreated || !strings.Contains(transition.Body.String(), `"acceptedRevision":2`) {
			t.Fatalf("restart CAS transition failed: %d %s", transition.Code, transition.Body.String())
		}
		head := qualificationRead(t, service.Handler(), "/v1/workflow-control/runs/"+qualificationRunID)
		if head.Code != http.StatusOK || !strings.Contains(head.Body.String(), `"revision":2`) || !strings.Contains(head.Body.String(), `"state":"running"`) {
			t.Fatalf("restart head failed: %d %s", head.Code, head.Body.String())
		}
		outbox := qualificationRead(t, service.Handler(), "/v1/workflow-control/runs/"+qualificationRunID+"/outbox/2:pending")
		if outbox.Code != http.StatusOK || !strings.Contains(outbox.Body.String(), `"runRevision":2`) {
			t.Fatalf("restart revision-2 outbox failed: %d %s", outbox.Code, outbox.Body.String())
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown GS9-B restart phase %q", phase)
	}
}

func TestGS9BImageDefaultOff(t *testing.T) {
	origin := strings.TrimRight(os.Getenv("WORKFLOW_CONTROL_GS9B_DEFAULT_ORIGIN"), "/")
	if origin == "" {
		t.Skip("GS9-B default-off image origin is not configured")
	}
	live := qualificationHTTPAfterStartup(t, http.MethodGet, origin+authorityapp.RouteLive, nil, nil)
	ready := qualificationHTTP(t, http.MethodGet, origin+authorityapp.RouteReady, nil, nil)
	version := qualificationHTTP(t, http.MethodGet, origin+authorityapp.RouteVersion, nil, nil)
	metrics := qualificationHTTP(t, http.MethodGet, origin+authorityapp.RouteMetrics, nil, nil)
	mutation := qualificationHTTP(t, http.MethodPost, origin+authorityapp.RouteAccept, []byte("{}\n"), map[string]string{"Content-Type": "application/json"})
	const disabledVersion = "{\"acceptNewRecords\":false,\"authority\":\"typescript\",\"buildSha\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"contractVersion\":\"v2\",\"mode\":\"disabled\",\"qualificationMode\":false,\"routingActivated\":false,\"schema\":\"openslack.workflow_control_authority_service_version.v1\"}\n"
	if live.status != http.StatusOK || string(live.body) != "{\"status\":\"live\"}\n" ||
		ready.status != http.StatusOK || string(ready.body) != "{\"status\":\"ready\"}\n" ||
		version.status != http.StatusOK || string(version.body) != disabledVersion ||
		metrics.status != http.StatusOK || metrics.header.Get("Content-Type") != "text/plain; version=0.0.4" ||
		!validDefaultOffMetrics(metrics.body) ||
		mutation.status != http.StatusNotFound {
		t.Fatalf("default-off image drift: live=%d %s ready=%d %s version=%d %s metrics=%d %s mutation=%d %s",
			live.status, live.body, ready.status, ready.body, version.status, version.body,
			metrics.status, metrics.body, mutation.status, mutation.body)
	}
}

func validDefaultOffMetrics(body []byte) bool {
	lines := strings.Split(strings.TrimSuffix(string(body), "\n"), "\n")
	if len(lines) != 16 || lines[0] != "# TYPE openslack_workflow_control_authority_http_requests_total counter" {
		return false
	}
	const requestPrefix = "openslack_workflow_control_authority_http_requests_total "
	if !strings.HasPrefix(lines[1], requestPrefix) {
		return false
	}
	requests, err := strconv.ParseInt(strings.TrimPrefix(lines[1], requestPrefix), 10, 64)
	if err != nil || requests < 4 {
		return false
	}
	expected := []string{
		"# TYPE openslack_workflow_control_authority_http_unauthorized_total counter",
		"openslack_workflow_control_authority_http_unauthorized_total 0",
		"# TYPE openslack_workflow_control_authority_accepts_total counter",
		"openslack_workflow_control_authority_accepts_total 0",
		"# TYPE openslack_workflow_control_authority_replays_total counter",
		"openslack_workflow_control_authority_replays_total 0",
		"# TYPE openslack_workflow_control_authority_reconciliation_total counter",
		"openslack_workflow_control_authority_reconciliation_total 0",
		"# TYPE openslack_workflow_control_authority_runs gauge",
		"openslack_workflow_control_authority_runs 0",
		"# TYPE openslack_workflow_control_authority_receipts gauge",
		"openslack_workflow_control_authority_receipts 0",
		"# TYPE openslack_workflow_control_authority_outbox_pending gauge",
		"openslack_workflow_control_authority_outbox_pending 0",
	}
	return strings.Join(lines[2:], "\n") == strings.Join(expected, "\n")
}

func qualificationService(t *testing.T, repository authoritystore.Repository) *authorityapp.Service {
	t.Helper()
	digest := sha256.Sum256([]byte(qualificationBearer))
	service, err := authorityapp.New(authorityapp.Options{
		Repository: repository, Mode: config.AuthorityModeLocalQualification, BuildSHA: qualificationBuildSHA,
		BearerTokenSHA256: hex.EncodeToString(digest[:]), WorkspaceID: qualificationWorkspace,
		CallerID: qualificationCaller, RoutingEpoch: qualificationEpoch,
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func qualificationRequestBody(t *testing.T, operation authoritystore.Operation, expectedRevision int64, expectedState *authoritycontract.RunState, targetState authoritycontract.RunState, targetRevision int64) []byte {
	t.Helper()
	route := authoritystore.Route{
		Backend: authoritystore.Backend, Authority: authoritystore.Authority,
		RoutingEpoch: qualificationEpoch, AuthorityBuildHash: qualificationBuildSHA,
	}
	schema := authoritystore.TransitionSchema
	if operation == authoritystore.OperationAccept {
		schema = authoritystore.AcceptSchema
	}
	body, err := canonicaljson.Encode(authoritystore.RequestEnvelope{
		Schema: schema, Operation: operation, WorkspaceID: qualificationWorkspace,
		RunID: qualificationRunID, Expected: authoritystore.ExpectedBinding{
			Revision: expectedRevision, State: expectedState, ResumeGeneration: 0,
		}, Route: route,
		Record: authoritystore.RunRecord{
			Schema: authoritystore.RunRecordSchema, WorkspaceID: qualificationWorkspace,
			RunID: qualificationRunID, WorkflowID: "workflow.demo", WorkflowVersion: "v1",
			WorkflowSourceHash: qualificationBuildSHA, ManifestHash: qualificationBuildSHA,
			InputHash: qualificationBuildSHA, Route: route, State: targetState,
			Revision: targetRevision, ResumeGeneration: 0,
		}, CorrelationID: "correlation-gs9b-" + strconv.FormatInt(targetRevision, 10),
	})
	if err != nil {
		t.Fatal(err)
	}
	return append(body, '\n')
}

func qualificationMutation(t *testing.T, handler http.Handler, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	prepared, err := authoritystore.PrepareRequest(body, qualificationCaller, qualificationWorkspace, strconv.FormatInt(qualificationEpoch, 10), qualificationBuildSHA)
	if err != nil {
		t.Fatal(err)
	}
	headers := qualificationIdentityHeaders()
	headers["Content-Type"] = "application/json"
	headers["Idempotency-Key"] = authoritystore.ExpectedIdempotencyKey(body)
	headers[authorityapp.HeaderFingerprint] = authoritystore.RequestFingerprint(http.MethodPost, path, prepared)
	return qualificationHandler(t, handler, http.MethodPost, path, body, headers)
}

func qualificationRead(t *testing.T, handler http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	return qualificationHandler(t, handler, http.MethodGet, path, nil, qualificationIdentityHeaders())
}

func qualificationIdentityHeaders() map[string]string {
	return map[string]string{
		"Authorization":                     "Bearer " + qualificationBearer,
		authorityapp.HeaderCallerID:         qualificationCaller,
		authorityapp.HeaderWorkspaceID:      qualificationWorkspace,
		authorityapp.HeaderRoutingEpoch:     strconv.FormatInt(qualificationEpoch, 10),
		authorityapp.HeaderExpectedBuildSHA: qualificationBuildSHA,
	}
}

func qualificationHandler(t *testing.T, handler http.Handler, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

type qualificationHTTPResult struct {
	status int
	body   []byte
	header http.Header
}

func qualificationHTTP(t *testing.T, method, url string, body []byte, headers map[string]string) qualificationHTTPResult {
	t.Helper()
	result, err := qualificationHTTPAttempt(method, url, body, headers, 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// qualificationHTTPAfterStartup retries only failures that never produced an
// HTTP response and unwrap to a network operation. Any HTTP status, including
// an incorrect semantic status, is returned immediately for strict assertion.
func qualificationHTTPAfterStartup(t *testing.T, method, url string, body []byte, headers map[string]string) qualificationHTTPResult {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("authority image did not accept connections within 15s")
		}
		attemptTimeout := min(remaining, time.Second)
		result, err := qualificationHTTPAttempt(method, url, body, headers, attemptTimeout)
		if err == nil {
			return result
		}
		var networkError *net.OpError
		if !errors.As(err, &networkError) {
			t.Fatalf("authority image startup request failed without a retryable connection error: %v", err)
		}
		remaining = time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("authority image did not accept connections within 15s: %v", err)
		}
		delay := min(100*time.Millisecond, remaining)
		timer := time.NewTimer(delay)
		<-timer.C
	}
}

func qualificationHTTPAttempt(method, url string, body []byte, headers map[string]string, timeout time.Duration) (qualificationHTTPResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return qualificationHTTPResult{}, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := (&http.Client{Timeout: timeout}).Do(request)
	if err != nil {
		return qualificationHTTPResult{}, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return qualificationHTTPResult{}, err
	}
	return qualificationHTTPResult{status: response.StatusCode, body: responseBody, header: response.Header.Clone()}, nil
}
