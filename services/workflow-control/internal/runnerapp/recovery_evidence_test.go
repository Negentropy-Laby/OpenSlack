package runnerapp

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

func TestRecoveryEvidenceStoreFailuresKeepPublicContract(t *testing.T) {
	for _, version := range []int64{9, 10} {
		for _, tc := range []struct {
			code   runnerstore.ErrorCode
			status int
			public string
		}{
			{runnerstore.ErrorReconciliation, 202, "WORKFLOW_RUNNER_RECONCILIATION_REQUIRED"},
			{runnerstore.ErrorNotFound, 404, "WORKFLOW_RUNNER_NOT_FOUND"},
			{runnerstore.ErrorLimitExceeded, 422, "WORKFLOW_RUNNER_UNPROCESSABLE"},
			{runnerstore.ErrorDatabase, 503, "WORKFLOW_RUNNER_UNAVAILABLE"},
			{runnerstore.ErrorAuthorityUnavailable, 503, "WORKFLOW_RUNNER_UNAVAILABLE"},
			{"UNEXPECTED", 500, "WORKFLOW_RUNNER_INTERNAL"},
		} {
			service := &Service{workspaceID: "workspace.test", tokenHash: sha256.Sum256([]byte(testToken)), schemaVersion: version,
				logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			failure := runnerstore.Failure(tc.code, "private-read-context", errors.New("private-read-cause"))
			service.recoveryStore = recoveryReader(func(context.Context, string, string, string, string, string) (runnerstore.RecoveryEvidence, error) {
				return runnerstore.RecoveryEvidence{}, failure
			})
			service.recoveryV2Store = recoveryV2Reader(func(context.Context, string, string, string, string, string) (runnerstore.RecoveryEvidenceV2, error) {
				return runnerstore.RecoveryEvidenceV2{}, failure
			})
			service.handler = service.routes()
			request := httptest.NewRequest(http.MethodGet, "/v2/runner/runs/run.test/recovery-evidence", nil)
			request.Header.Set("Authorization", "Bearer "+testToken)
			request.Header.Set(HeaderWorkspaceID, service.workspaceID)
			response := httptest.NewRecorder()
			service.Handler().ServeHTTP(response, request)
			if response.Code != tc.status || !strings.Contains(response.Body.String(), tc.public) || strings.Contains(response.Body.String(), "private-") {
				t.Fatalf("schema %d %s: %d %s", version, tc.code, response.Code, response.Body.String())
			}
		}
	}
}

type recoveryReader func(context.Context, string, string, string, string, string) (runnerstore.RecoveryEvidence, error)

type recoveryV2Reader func(context.Context, string, string, string, string, string) (runnerstore.RecoveryEvidenceV2, error)

func (read recoveryV2Reader) ReadRecoveryEvidenceV2(ctx context.Context, workspace, run, binding, cursor, snapshot string) (runnerstore.RecoveryEvidenceV2, error) {
	return read(ctx, workspace, run, binding, cursor, snapshot)
}

func TestRecoveryEvidenceV2RecordCursorAndResponseIdentity(t *testing.T) {
	service := &Service{workspaceID: "workspace.test", tokenHash: sha256.Sum256([]byte(testToken)), schemaVersion: 10}
	binding := "WFRUNNER-BINDING-" + strings.Repeat("a", 64)
	calls := 0
	invalid := false
	service.recoveryV2Store = recoveryV2Reader(func(ctx context.Context, workspace, run, selected, cursor, snapshot string) (runnerstore.RecoveryEvidenceV2, error) {
		calls++
		if selected != binding || cursor != "binding."+binding || snapshot != strings.Repeat("b", 64) {
			t.Fatal("record cursor changed")
		}
		if invalid {
			run = "run.foreign"
		}
		return runnerstore.RecoveryEvidenceV2{Schema: runnerstore.RecoveryEvidenceV2Schema, WorkspaceID: workspace, RunID: run, Complete: false, Snapshot: snapshot, Records: []runnerstore.RecoveryEvidenceRecord{}}, nil
	})
	service.handler = service.routes()
	request := func(query string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/v2/runner/runs/run.test/recovery-evidence"+query, nil)
		r.Header.Set("Authorization", "Bearer "+testToken)
		r.Header.Set(HeaderWorkspaceID, service.workspaceID)
		w := httptest.NewRecorder()
		service.Handler().ServeHTTP(w, r)
		return w
	}
	for _, query := range []string{"?snapshot=" + strings.Repeat("b", 64), "?afterBindingId=binding." + binding, "?bindingId=bad", "?unknown=value"} {
		if w := request(query); w.Code != 422 {
			t.Fatalf("invalid v2 query: %d", w.Code)
		}
	}
	if calls != 0 {
		t.Fatal("invalid query reached store")
	}
	query := "?bindingId=" + binding + "&afterBindingId=binding." + binding + "&snapshot=" + strings.Repeat("b", 64)
	if w := request(query); w.Code != 200 {
		t.Fatalf("v2 record page: %d %s", w.Code, w.Body.String())
	}
	invalid = true
	if w := request(query); w.Code != 500 || strings.Contains(w.Body.String(), "run.foreign") {
		t.Fatalf("invalid response identity leaked: %d %s", w.Code, w.Body.String())
	}
}

func (read recoveryReader) ReadRecoveryEvidence(ctx context.Context, workspace, run, binding, cursor, snapshot string) (runnerstore.RecoveryEvidence, error) {
	return read(ctx, workspace, run, binding, cursor, snapshot)
}

func TestRecoveryEvidenceAuthenticationQueriesAndExactFrames(t *testing.T) {
	calls := 0
	binding := "WFRUNNER-BINDING-" + strings.Repeat("a", 64)
	exact := "{\"checkpointId\":\"checkpoint-a\"}\n"
	service := &Service{workspaceID: "workspace.test", tokenHash: sha256.Sum256([]byte(testToken))}
	service.recoveryStore = recoveryReader(func(ctx context.Context, workspace, run, selected, cursor, snapshot string) (runnerstore.RecoveryEvidence, error) {
		calls++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > readDeadline || workspace != service.workspaceID || run != "run.test" {
			t.Fatal("recovery request lost its deadline or workspace binding")
		}
		if cursor != "" && (cursor != binding || snapshot != strings.Repeat("b", 64)) {
			t.Fatal("pagination binding changed")
		}
		return runnerstore.RecoveryEvidence{Schema: runnerstore.RecoveryEvidenceSchema, WorkspaceID: workspace, RunID: run, Complete: selected == "", Snapshot: strings.Repeat("b", 64),
			Route:      runnerbindingcontract.Record{"backend": "go", "authority": "workflow-control", "routingEpoch": 1, "authorityBuildHash": strings.Repeat("c", 64)},
			Bindings:   []runnerstore.RecoveryBinding{{BindingID: binding, State: "resolved", Stage: exact, StageReceipt: exact, Resolution: &exact, ResolutionReceipt: &exact}},
			Unfinished: []runnerstore.RecoveryDiagnostic{{BindingID: binding, Operation: "checkpoint_commit", State: "resolved"}}, ActiveAttempts: []string{}}, nil
	})
	service.handler = service.routes()
	request := func(path, token, workspace string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set(HeaderWorkspaceID, workspace)
		w := httptest.NewRecorder()
		service.Handler().ServeHTTP(w, r)
		return w
	}
	path := "/v2/runner/runs/run.test/recovery-evidence"
	for _, identity := range [][2]string{{"", service.workspaceID}, {testToken, "workspace.foreign"}} {
		if response := request(path, identity[0], identity[1]); response.Code != http.StatusUnauthorized {
			t.Fatalf("unauthorized read returned %d", response.Code)
		}
	}
	for _, suffix := range []string{"?bindingId=", "?bindingId=bad", "?bindingId=" + binding + "&bindingId=" + binding, "?unknown=x", "?snapshot=" + strings.Repeat("b", 64), "?afterBindingId=" + binding, "?bindingId=" + binding + "&snapshot=" + strings.Repeat("b", 64)} {
		if response := request(path+suffix, testToken, service.workspaceID); response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("invalid query %s returned %d: %s", suffix, response.Code, response.Body.String())
		}
	}
	if calls != 0 {
		t.Fatal("invalid read reached the store")
	}
	for _, suffix := range []string{"", "?bindingId=" + binding, "?afterBindingId=" + binding + "&snapshot=" + strings.Repeat("b", 64)} {
		response := request(path+suffix, testToken, service.workspaceID)
		var view runnerstore.RecoveryEvidence
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &view) != nil || len(view.Bindings) != 1 || view.Bindings[0].Stage != exact || *view.Bindings[0].ResolutionReceipt != exact {
			t.Fatalf("exact read failed: %d %s", response.Code, response.Body.String())
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("recovery evidence can be cached")
		}
	}
	service.recoveryStore = nil
	if response := request(path, testToken, service.workspaceID); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable capability returned %d", response.Code)
	}
}

func TestRecoveryEvidenceCancellationReachesTheStore(t *testing.T) {
	service := &Service{workspaceID: "workspace.test", tokenHash: sha256.Sum256([]byte(testToken))}
	service.recoveryStore = recoveryReader(func(ctx context.Context, _, _, _, _, _ string) (runnerstore.RecoveryEvidence, error) {
		if ctx.Err() != context.Canceled {
			t.Fatal("cancelled recovery query was not cancelled")
		}
		return runnerstore.RecoveryEvidence{}, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "cancelled", ctx.Err())
	})
	service.handler = service.routes()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodGet, "/v2/runner/runs/run.test/recovery-evidence", nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set(HeaderWorkspaceID, service.workspaceID)
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, r)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("cancelled read returned %d", response.Code)
	}
}
