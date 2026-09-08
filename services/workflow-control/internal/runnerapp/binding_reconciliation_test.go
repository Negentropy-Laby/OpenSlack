package runnerapp

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

type reconciliationStub struct {
	previews, applies, reads, pauses int
	failure                          error
	prepared                         runnerstore.PreparedBindingReconciliation
	exact                            []byte
}

func (s *reconciliationStub) PreviewBindingReconciliation(ctx context.Context, workspace, run, binding, after string) (runnerstore.BindingReconciliationPreview, error) {
	s.previews++
	value := runnerstore.BindingReconciliationPreview{Schema: "openslack.workflow_runner_binding_reconciliation_preview.v1", WorkspaceID: workspace, RunID: run, Items: []runnerstore.BindingReconciliationItem{}}
	raw, _ := canonicaljson.Encode(value)
	value.Encoded = append(raw, '\n')
	return value, s.failure
}
func (s *reconciliationStub) ApplyBindingReconciliation(ctx context.Context, p runnerstore.PreparedBindingReconciliation) ([]byte, error) {
	s.applies++
	s.prepared = p
	return s.exact, s.failure
}
func (s *reconciliationStub) ReadBindingSettlementReceipt(ctx context.Context, workspace, run, key string) ([]byte, error) {
	s.reads++
	return s.exact, s.failure
}
func (s *reconciliationStub) PauseReconciledRun(ctx context.Context, p runnerstore.RecoveryPauseRequest) ([]byte, error) {
	s.pauses++
	return s.exact, s.failure
}

func TestBindingReconciliationHTTPContracts(t *testing.T) {
	store := &reconciliationStub{exact: []byte("{\"originalReceipt\":true}\n")}
	service := &Service{workspaceID: "workspace.test", tokenHash: sha256.Sum256([]byte(testToken)), schemaVersion: 10, reconciliationStore: store}
	service.handler = service.routes()
	path := "/v2/runner/runs/run.test/binding-reconciliation"
	raw, err := canonicaljson.Encode(runnerstore.BindingReconciliationRequest{Schema: runnerstore.BindingReconciliationSchema, WorkspaceID: "workspace.test", RunID: "run.test", BindingID: "WFRUNNER-BINDING-" + strings.Repeat("a", 64), StageHash: strings.Repeat("b", 64), Outcome: "not_committed", RulesVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := runnerstore.ParseBindingReconciliation(append(raw, '\n'))
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body, key, workspace, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set(HeaderWorkspaceID, workspace)
		if method == http.MethodPost {
			r.Header.Set("Content-Type", "application/json")
			if key != "" {
				r.Header.Set("Idempotency-Key", key)
			}
		}
		w := httptest.NewRecorder()
		service.Handler().ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct{ workspace, token string }{{"workspace.foreign", testToken}, {"workspace.test", "invalid"}} {
		if w := request("POST", path, string(prepared.ExactBytes), prepared.IdempotencyKey, tc.workspace, tc.token); w.Code != 401 {
			t.Fatalf("auth: %d", w.Code)
		}
	}
	if store.applies != 0 {
		t.Fatal("unauthorized apply reached store")
	}
	if w := request("GET", path, "", "", "workspace.test", testToken); w.Code != 200 || store.previews != 1 || store.applies != 0 || store.pauses != 0 {
		t.Fatalf("read-only preview: %d", w.Code)
	}
	for _, key := range []string{"", prepared.IdempotencyKey + "0"} {
		if w := request("POST", path, string(prepared.ExactBytes), key, "workspace.test", testToken); w.Code != 422 {
			t.Fatalf("idempotency: %d", w.Code)
		}
	}
	if w := request("POST", path, string(prepared.ExactBytes), prepared.IdempotencyKey, "workspace.test", testToken); w.Code != 200 || w.Body.String() != string(store.exact) || string(store.prepared.ExactBytes) != string(prepared.ExactBytes) {
		t.Fatalf("exact apply: %d %s", w.Code, w.Body.String())
	}
	if w := request("GET", path+"/receipts/"+prepared.IdempotencyKey, "", "", "workspace.test", testToken); w.Code != 200 || w.Body.String() != string(store.exact) {
		t.Fatalf("exact lookup: %d", w.Code)
	}
	for _, tc := range []struct {
		code   runnerstore.ErrorCode
		status int
		public string
	}{
		{runnerstore.ErrorReconciliation, 202, "WORKFLOW_RUNNER_RECONCILIATION_REQUIRED"},
		{runnerstore.ErrorConflict, 409, "WORKFLOW_RUNNER_CONFLICT"},
		{runnerstore.ErrorIdempotencyConflict, 409, "WORKFLOW_RUNNER_CONFLICT"},
		{runnerstore.ErrorLeaseExpired, 409, "WORKFLOW_RUNNER_CONFLICT"},
		{runnerstore.ErrorAuthorityUnavailable, 503, "WORKFLOW_RUNNER_UNAVAILABLE"},
		{runnerstore.ErrorDatabase, 503, "WORKFLOW_RUNNER_UNAVAILABLE"},
		{runnerstore.ErrorNotFound, 404, "WORKFLOW_RUNNER_NOT_FOUND"},
		{runnerstore.ErrorLimitExceeded, 422, "WORKFLOW_RUNNER_UNPROCESSABLE"},
		{runnerstore.ErrorInputInvalid, 422, "WORKFLOW_RUNNER_UNPROCESSABLE"},
	} {
		t.Run(string(tc.code), func(t *testing.T) {
			store.failure = runnerstore.Failure(tc.code, "private-store-details", errors.New("private-cause"))
			w := request("GET", path, "", "", "workspace.test", testToken)
			if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.public) || strings.Contains(w.Body.String(), "private-") {
				t.Fatalf("public mapping: %d %s", w.Code, w.Body.String())
			}
		})
	}
	store.failure = nil
	if w := request("POST", path, strings.Repeat("x", 65537), prepared.IdempotencyKey, "workspace.test", testToken); w.Code != 413 {
		t.Fatalf("limit: %d", w.Code)
	}
	pause, _ := canonicaljson.Encode(runnerstore.RecoveryPauseRequest{Schema: "openslack.workflow_runner_recovery_pause.v1", WorkspaceID: "workspace.test", RunID: "run.test", ExpectedRevision: 4, ExpectedRecordHash: strings.Repeat("a", 64)})
	if w := request("POST", "/v2/runner/runs/run.test/recovery-pause", string(append(pause, '\n')), "", "workspace.test", testToken); w.Code != 200 || store.pauses != 1 {
		t.Fatalf("pause: %d", w.Code)
	}
}
