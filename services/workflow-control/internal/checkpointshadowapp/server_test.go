package checkpointshadowapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointshadowstore"
)

type stubStore struct {
	observe       checkpointshadowstore.Receipt
	observeErr    error
	head          checkpointshadowstore.Head
	headErr       error
	receipt       checkpointshadowstore.Receipt
	receiptErr    error
	readyErr      error
	statistics    checkpointshadowstore.Statistics
	statisticsErr error
}

func (s *stubStore) Observe(context.Context, checkpointshadowstore.ObserveInput) (checkpointshadowstore.Receipt, error) {
	return s.observe, s.observeErr
}
func (s *stubStore) ReadHead(context.Context, string, string) (checkpointshadowstore.Head, error) {
	return s.head, s.headErr
}
func (s *stubStore) ReadReceipt(context.Context, string, string) (checkpointshadowstore.Receipt, error) {
	return s.receipt, s.receiptErr
}
func (s *stubStore) Ready(context.Context) error { return s.readyErr }
func (s *stubStore) Statistics(context.Context) (checkpointshadowstore.Statistics, error) {
	return s.statistics, s.statisticsErr
}

func TestGS9CImageDefaultOff(t *testing.T) {
	service, err := New(Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ method, path string }{
		{http.MethodPost, "/v1/shadow/workflow-control/checkpoints"},
		{http.MethodGet, "/v1/shadow/workflow-control/runs/run/checkpoint-head"},
		{http.MethodGet, "/v1/shadow/workflow-control/receipts/key"},
	} {
		response := performCheckpointRequest(service.Handler(), test.method, test.path, nil, nil)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status=%d", test.path, response.Code)
		}
	}
	version := performCheckpointRequest(service.Handler(), http.MethodGet, "/version", nil, nil)
	if version.Code != http.StatusOK || !strings.Contains(version.Body.String(), `"checkpointAuthority":false`) || !strings.Contains(version.Body.String(), `"qualificationMode":false`) {
		t.Fatalf("disabled version=%d %s", version.Code, version.Body.String())
	}
}

func TestGS9CQualification(t *testing.T) {
	body := checkpointBody(t)
	accepted := checkpointReceipt(t, "accepted", "matched", false)
	store := &stubStore{
		observe:    accepted,
		receipt:    accepted,
		head:       checkpointshadowstore.Head{Schema: checkpointshadowstore.HeadSchema, GoRole: "observer_only", WorkspaceID: "workspace-test", RunID: "run-test", SourceSequence: 1, Operation: checkpointshadowstore.OperationCheckpointCommit, MismatchLatched: false, UpdatedAt: "2026-08-12T00:00:00.000Z"},
		statistics: checkpointshadowstore.Statistics{Runs: 1, Observations: 2, Receipts: 3, ReconciliationPending: 4},
	}
	service, token := qualificationService(t, store)

	unauthorized := performCheckpointRequest(service.Handler(), http.MethodPost, "/v1/shadow/workflow-control/checkpoints", body, map[string]string{"Content-Type": "application/json"})
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", unauthorized.Code)
	}

	response := performCheckpointRequest(service.Handler(), http.MethodPost, "/v1/shadow/workflow-control/checkpoints", body, qualificationHeaders(token))
	if response.Code != http.StatusCreated || !bytes.Equal(response.Body.Bytes(), accepted.ExactBytes) {
		t.Fatalf("accepted status=%d body=%s", response.Code, response.Body.String())
	}
	store.observe.Replay = true
	replay := performCheckpointRequest(service.Handler(), http.MethodPost, "/v1/shadow/workflow-control/checkpoints", body, qualificationHeaders(token))
	if replay.Code != http.StatusOK || replay.Header().Get("Idempotency-Replayed") != "true" || !bytes.Equal(replay.Body.Bytes(), accepted.ExactBytes) {
		t.Fatalf("replay status=%d headers=%v body=%s", replay.Code, replay.Header(), replay.Body.String())
	}
	store.observe = checkpointReceipt(t, "accepted", "mismatched", false)
	mismatch := performCheckpointRequest(service.Handler(), http.MethodPost, "/v1/shadow/workflow-control/checkpoints", body, qualificationHeaders(token))
	if mismatch.Code != http.StatusCreated {
		t.Fatalf("mismatch status=%d body=%s", mismatch.Code, mismatch.Body.String())
	}
	store.observe.Replay = true
	mismatchReplay := performCheckpointRequest(service.Handler(), http.MethodPost, "/v1/shadow/workflow-control/checkpoints", body, qualificationHeaders(token))
	if mismatchReplay.Code != http.StatusOK {
		t.Fatalf("mismatch replay status=%d body=%s", mismatchReplay.Code, mismatchReplay.Body.String())
	}
	store.observe = checkpointReceipt(t, "reconciliation_required", "unknown", true)
	reconciliation := performCheckpointRequest(service.Handler(), http.MethodPost, "/v1/shadow/workflow-control/checkpoints", body, qualificationHeaders(token))
	if reconciliation.Code != http.StatusAccepted || reconciliation.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatalf("reconciliation replay status=%d headers=%v", reconciliation.Code, reconciliation.Header())
	}

	head := performCheckpointRequest(service.Handler(), http.MethodGet, "/v1/shadow/workflow-control/runs/run-test/checkpoint-head", nil, qualificationHeaders(token))
	if head.Code != http.StatusOK || !strings.Contains(head.Body.String(), `"goRole":"observer_only"`) {
		t.Fatalf("head status=%d body=%s", head.Code, head.Body.String())
	}
	receipt := performCheckpointRequest(service.Handler(), http.MethodGet, "/v1/shadow/workflow-control/receipts/"+checkpointKey(), nil, qualificationHeaders(token))
	if receipt.Code != http.StatusOK || !bytes.Equal(receipt.Body.Bytes(), accepted.ExactBytes) {
		t.Fatalf("receipt status=%d body=%s", receipt.Code, receipt.Body.String())
	}

	metrics := performCheckpointRequest(service.Handler(), http.MethodGet, "/metrics", nil, nil)
	if metrics.Code != http.StatusOK {
		t.Fatalf("metrics status=%d body=%s", metrics.Code, metrics.Body.String())
	}
	for _, expected := range []string{
		"# TYPE workflow_checkpoint_shadow_http_requests_total counter",
		"# TYPE workflow_checkpoint_shadow_unauthorized_total counter",
		"# TYPE workflow_checkpoint_shadow_accepts_total counter",
		"# TYPE workflow_checkpoint_shadow_replays_total counter",
		"# TYPE workflow_checkpoint_shadow_mismatches_total counter\nworkflow_checkpoint_shadow_mismatches_total 1",
		"# TYPE workflow_checkpoint_shadow_runs gauge\nworkflow_checkpoint_shadow_runs 1",
		"# TYPE workflow_checkpoint_shadow_observations gauge\nworkflow_checkpoint_shadow_observations 2",
		"# TYPE workflow_checkpoint_shadow_receipts gauge\nworkflow_checkpoint_shadow_receipts 3",
		"# TYPE workflow_checkpoint_shadow_reconciliation_pending gauge\nworkflow_checkpoint_shadow_reconciliation_pending 4",
	} {
		if !strings.Contains(metrics.Body.String(), expected) {
			t.Fatalf("metrics missing %q:\n%s", expected, metrics.Body.String())
		}
	}

	store.readyErr = errors.New("database unavailable")
	ready := performCheckpointRequest(service.Handler(), http.MethodGet, "/health/ready", nil, nil)
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness status=%d body=%s", ready.Code, ready.Body.String())
	}
}

func TestCheckpointShadowStoreErrorStatusMapping(t *testing.T) {
	tests := []struct {
		code checkpointshadowstore.ErrorCode
		want int
	}{
		{checkpointshadowstore.ErrorInputInvalid, http.StatusUnprocessableEntity},
		{checkpointshadowstore.ErrorContentInvalid, http.StatusUnprocessableEntity},
		{checkpointshadowstore.ErrorConflict, http.StatusConflict},
		{checkpointshadowstore.ErrorIdempotencyConflict, http.StatusConflict},
		{checkpointshadowstore.ErrorNotFound, http.StatusNotFound},
		{checkpointshadowstore.ErrorDatabase, http.StatusServiceUnavailable},
		{checkpointshadowstore.ErrorIntegrity, http.StatusInternalServerError},
		{checkpointshadowstore.ErrorCommitUnknown, http.StatusInternalServerError},
	}
	for _, test := range tests {
		t.Run(string(test.code), func(t *testing.T) {
			response := httptest.NewRecorder()
			writeStoreError(response, checkpointshadowstore.Failure(test.code, "test", nil))
			if response.Code != test.want || !strings.Contains(response.Body.String(), string(test.code)) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestQualificationRequiresClosedBindings(t *testing.T) {
	_, err := New(Options{QualificationMode: true, Store: &stubStore{}, BuildSHA: "bad", BearerTokenSHA256: strings.Repeat("a", 64), WorkspaceID: "workspace", CallerID: "caller"})
	if err == nil {
		t.Fatal("invalid build was accepted")
	}
}

func qualificationService(t *testing.T, store *stubStore) (*Service, string) {
	t.Helper()
	token := strings.Repeat("token", 8)
	digest := sha256.Sum256([]byte(token))
	service, err := New(Options{QualificationMode: true, Store: store, BuildSHA: strings.Repeat("f", 64), BearerTokenSHA256: hex.EncodeToString(digest[:]), WorkspaceID: "workspace-test", CallerID: "caller-test"})
	if err != nil {
		t.Fatal(err)
	}
	return service, token
}

func qualificationHeaders(token string) map[string]string {
	return map[string]string{
		"Authorization":            "Bearer " + token,
		"Content-Type":             "application/json",
		"X-OpenSlack-Workspace-ID": "workspace-test",
		"X-OpenSlack-Caller-ID":    "caller-test",
		"Idempotency-Key":          checkpointKey(),
	}
}

func performCheckpointRequest(handler http.Handler, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func checkpointKey() string { return checkpointshadowstore.IdempotencyPrefix + strings.Repeat("1", 64) }

func checkpointBody(t *testing.T) []byte {
	t.Helper()
	observation := checkpointshadowstore.Observation{
		Schema: checkpointshadowstore.ObservationSchema, Authority: "typescript", GoRole: "observer_only", RunID: "run-test", Revision: 2,
		WorkflowSourceHash: strings.Repeat("b", 64), ManifestHash: strings.Repeat("c", 64), InputHash: strings.Repeat("d", 64),
		Runner:     checkpointshadowstore.RunnerBinding{WorkspaceID: "workspace-test", JobID: "job-test", AttemptID: "attempt-test", LeaseID: "lease-test", FencingToken: 1, CorrelationID: "correlation-test", RunnerBuildHash: strings.Repeat("e", 64)},
		Checkpoint: &checkpointshadowstore.Checkpoint{CheckpointID: "checkpoint-test", PhaseID: "phase-0", PhaseIndex: 0, CommitPoint: "after_phase_work", ArtifactRef: "artifacts/checkpoint.json", ArtifactHash: strings.Repeat("a", 64), CommittedRevision: 2, CommittedAt: "2026-08-12T00:00:00.000Z"},
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
	return body
}

func checkpointReceipt(t *testing.T, status, parity string, replay bool) checkpointshadowstore.Receipt {
	t.Helper()
	observationID := "wccs-observation-test"
	committedAt := "2026-08-12T00:00:00.000Z"
	value := checkpointshadowstore.ReceiptValue{Schema: checkpointshadowstore.ReceiptSchema, Status: status, IdempotencyKey: checkpointKey(), ReceiptID: "wccs-receipt-test", ObservationID: &observationID, WorkspaceID: "workspace-test", RunID: "run-test", SourceSequence: 1, Operation: checkpointshadowstore.OperationCheckpointCommit, Parity: parity, EnvelopeHash: strings.Repeat("a", 64), ObservationHash: strings.Repeat("b", 64), ServiceBuildHash: strings.Repeat("f", 64), CommittedAt: &committedAt}
	if parity == "mismatched" {
		code := "manifest_hash_drift"
		value.MismatchCode = &code
	}
	if status == "reconciliation_required" {
		token := "wccs-reconciliation-test"
		value.ObservationID, value.CommittedAt, value.ReconciliationToken = nil, nil, &token
	}
	exact, err := canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	return checkpointshadowstore.Receipt{Value: value, ExactBytes: exact, Replay: replay}
}
