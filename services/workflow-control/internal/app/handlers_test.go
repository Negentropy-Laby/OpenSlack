package app

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore"
)

const testBuildSHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

type fakeStore struct {
	receipt    shadowstore.Receipt
	projection shadowstore.Projection
	statistics shadowstore.Statistics
	err        error
}

func (store *fakeStore) Observe(context.Context, shadowstore.ObserveInput) (shadowstore.Receipt, error) {
	return store.receipt, store.err
}

func (store *fakeStore) Projection(context.Context, string, string) (shadowstore.Projection, error) {
	return store.projection, store.err
}

func (store *fakeStore) Statistics(context.Context) (shadowstore.Statistics, error) {
	return store.statistics, store.err
}

func TestObservationProjectionAndClosedRouteSurface(t *testing.T) {
	body, prepared, readModel := testBody(t)
	committed := time.Date(2026, 8, 3, 0, 0, 2, 0, time.UTC)
	store := &fakeStore{
		receipt: shadowstore.Receipt{
			Schema: shadowstore.ReceiptSchema, Operation: "observation_ingest", Status: shadowstore.ReceiptAccepted,
			Parity: shadowstore.ParityMatched, IdempotencyKey: shadowstore.ExpectedIdempotencyKey(prepared),
			RequestFingerprint: shadowstore.RequestFingerprint(prepared), WorkspaceID: "workspace-test",
			RunID: "run-test", SourceSequence: 1, ObservationDigest: shadowstore.DigestString(prepared.BodyDigest),
			ObservationHash: readModel.ObservationHash, CommittedAt: &committed,
		},
		projection: shadowstore.Projection{
			Schema: shadowstore.ProjectionSchema, Authority: workflowcontrol.Authority, Shadow: "go",
			GoRole: "credential-free-observer-only", AuthorityEligible: false,
			Parity: shadowstore.ParityMatched, WorkspaceID: "workspace-test", RunID: "run-test",
			SourceSequence: 1, MatchedSourceSequence: 1, MatchedObservationHash: readModel.ObservationHash,
			ReadModel: readModel, MatchedObservations: 1,
		},
		statistics: shadowstore.Statistics{Runs: 1, SourceSequenceMax: 1, MatchedObservations: 1},
	}
	service := testService(t, store)

	request := httptest.NewRequest(http.MethodPost, RouteObservation, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", store.receipt.IdempotencyKey)
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated || strings.Contains(response.Body.String(), `"token"`) {
		t.Fatalf("unexpected observation response %d: %s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/v1/shadow/workflow-control/runs/run-test/projection", nil)
	request.Header.Set(HeaderWorkspaceID, "workspace-test")
	response = httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"authorityEligible":false`) ||
		!strings.Contains(response.Body.String(), `"matchedSourceSequence":1`) || !strings.Contains(response.Body.String(), `"no-lease"`) {
		t.Fatalf("unexpected projection response %d: %s", response.Code, response.Body.String())
	}

	for _, route := range []string{
		"/v1/workflow-control/runs", "/v1/workflow-control/runs/run-test:cancel",
		"/v1/workflow-control/runs/run-test:approve", "/v1/workflow-control/leases",
	} {
		response = httptest.NewRecorder()
		service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, route, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("unexpected authority route %s returned %d", route, response.Code)
		}
	}
}

func TestStrictHTTPBindingsHealthVersionAndMetrics(t *testing.T) {
	service := testService(t, &fakeStore{statistics: shadowstore.Statistics{Runs: 2, MismatchedObservations: 1}})

	for _, testCase := range []struct {
		method, route string
		headers       http.Header
		want          int
	}{
		{http.MethodGet, RouteLive, nil, http.StatusOK},
		{http.MethodGet, RouteReady, nil, http.StatusOK},
		{http.MethodGet, RouteVersion, nil, http.StatusOK},
		{http.MethodGet, RouteMetrics, nil, http.StatusOK},
		{http.MethodGet, RouteLive + "?verbose=true", nil, http.StatusUnprocessableEntity},
		{http.MethodPost, RouteObservation, http.Header{"Content-Type": []string{"application/json; charset=utf-8"}}, http.StatusUnsupportedMediaType},
		{http.MethodGet, "/v1/shadow/workflow-control/runs/run-test/projection", nil, http.StatusUnprocessableEntity},
		{http.MethodGet, "/health/%6cive", nil, http.StatusNotFound},
	} {
		request := httptest.NewRequest(testCase.method, testCase.route, nil)
		request.Header = testCase.headers
		response := httptest.NewRecorder()
		service.Handler().ServeHTTP(response, request)
		if response.Code != testCase.want {
			t.Fatalf("%s %s returned %d, want %d: %s", testCase.method, testCase.route, response.Code, testCase.want, response.Body.String())
		}
	}

	version := httptest.NewRecorder()
	service.Handler().ServeHTTP(version, httptest.NewRequest(http.MethodGet, RouteVersion, nil))
	if version.Body.String() != `{"authority":"typescript","buildSha":"`+testBuildSHA+`","contractVersion":"v1","mode":"shadow-only","schema":"openslack.workflow_control_shadow_service_version.v1"}`+"\n" {
		t.Fatalf("unexpected version body: %s", version.Body.String())
	}
	metrics := httptest.NewRecorder()
	service.Handler().ServeHTTP(metrics, httptest.NewRequest(http.MethodGet, RouteMetrics, nil))
	if strings.Contains(metrics.Body.String(), "run-test") || !strings.Contains(metrics.Body.String(), "openslack_workflow_control_shadow_runs 2") {
		t.Fatalf("metrics are missing or contain high-cardinality identity: %s", metrics.Body.String())
	}
}

func TestStoreErrorsAreSanitized(t *testing.T) {
	service := testService(t, &fakeStore{err: shadowstore.Failure(shadowstore.ErrorContentInvalid, "secret database detail", io.ErrUnexpectedEOF)})
	request := httptest.NewRequest(http.MethodGet, "/v1/shadow/workflow-control/runs/run-test/projection", nil)
	request.Header.Set(HeaderWorkspaceID, "workspace-test")
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "EOF") {
		t.Fatalf("store error leaked detail: %d %s", response.Code, response.Body.String())
	}
}

func testService(t *testing.T, store shadowstore.Store) *Service {
	t.Helper()
	service, err := New(Options{Store: store, BuildSHA: testBuildSHA, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func testBody(t *testing.T) ([]byte, shadowstore.PreparedObservation, workflowcontrol.ReadModel) {
	t.Helper()
	observation := workflowcontrol.Observation{
		Schema: workflowcontrol.ObservationSchema, Authority: workflowcontrol.Authority,
		RunID: "run-test", WorkflowName: "workflow.test", Mode: workflowcontrol.ModeExecute,
		Status: workflowcontrol.RunRunning, StartedAt: "2026-08-03T00:00:00.000Z",
		UpdatedAt: "2026-08-03T00:00:01.000Z", ManifestHash: strings.Repeat("a", 64),
		Phases: []workflowcontrol.PhaseObservation{},
		Approvals: workflowcontrol.ApprovalObservation{
			LegacyRunGate: workflowcontrol.LegacyRunGateApproval{Plane: "legacy-run-gate", Semantics: "run-gate-only", Counts: workflowcontrol.ApprovalCounts{}},
			EffectV2:      workflowcontrol.EffectApprovalSummary{Plane: "workflow-effect-v2", Semantics: "effect-decision-only", Schema: workflowcontrol.EffectSchema, Counts: workflowcontrol.ApprovalCounts{}},
		},
		Budget: workflowcontrol.BudgetObservation{Configured: false, Warnings: []workflowcontrol.BudgetWarning{}},
	}
	readModel, err := workflowcontrol.ProjectReadModel(observation)
	if err != nil {
		t.Fatal(err)
	}
	envelope := workflowcontrol.ShadowEnvelope{
		Authority: workflowcontrol.Authority, Observation: observation, Projection: readModel,
		Schema: workflowcontrol.ShadowObservationSchema,
		Source: workflowcontrol.ShadowSource{RunID: "run-test", SourceSequence: 1, WorkspaceID: "workspace-test"},
	}
	body, err := workflowcontrol.CanonicalShadowEnvelopeBytes(envelope)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := shadowstore.PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	return body, prepared, readModel
}
