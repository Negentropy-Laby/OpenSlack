package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rc_wsman/internal/calleraccess"
	"rc_wsman/internal/notificationstore"
	"rc_wsman/internal/operationscontrol"
)

type fakeOperations struct {
	outbox      operationscontrol.OutboxProjection
	status      operationscontrol.NotificationStatus
	dead        operationscontrol.DeadPage
	attempts    operationscontrol.AttemptPage
	preview     []operationscontrol.ReplayPreviewItem
	execute     operationscontrol.ReplayExecuteResult
	err         error
	previewIDs  []string
	executeBody []operationscontrol.ReplayExecuteInput
	calls       int
}

func (f *fakeOperations) QueryOutbox(context.Context, calleraccess.OperatorPrincipal, []string) (operationscontrol.OutboxProjection, error) {
	f.calls++
	return f.outbox, f.err
}
func (f *fakeOperations) QueryNotification(context.Context, calleraccess.OperatorPrincipal, string) (operationscontrol.NotificationStatus, error) {
	f.calls++
	return f.status, f.err
}
func (f *fakeOperations) ListDead(context.Context, calleraccess.OperatorPrincipal, []string, int, string) (operationscontrol.DeadPage, error) {
	f.calls++
	return f.dead, f.err
}
func (f *fakeOperations) ListAttemptHistory(context.Context, calleraccess.OperatorPrincipal, string, int, string) (operationscontrol.AttemptPage, error) {
	f.calls++
	return f.attempts, f.err
}
func (f *fakeOperations) PreviewReplay(_ context.Context, _ calleraccess.OperatorPrincipal, ids []string, _ string) ([]operationscontrol.ReplayPreviewItem, error) {
	f.calls++
	f.previewIDs = append([]string(nil), ids...)
	return f.preview, f.err
}
func (f *fakeOperations) ExecuteReplay(_ context.Context, _ calleraccess.OperatorPrincipal, items []operationscontrol.ReplayExecuteInput, _ string) (operationscontrol.ReplayExecuteResult, error) {
	f.calls++
	f.executeBody = append([]operationscontrol.ReplayExecuteInput(nil), items...)
	return f.execute, f.err
}

func opsTestServer(t *testing.T, ops *fakeOperations, auth *fakeAuthenticator) *Server {
	t.Helper()
	srv := newTestServer(t, &fakeStore{}, auth, &fakeVendorRegistry{})
	srv.deps.Operations = ops
	return srv
}

func TestOpsRoutesRejectMissingInvalidAndRevokedAuthenticationBeforeOperations(t *testing.T) {
	routes := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/v1/ops/outbox", ""},
		{http.MethodGet, "/v1/ops/notifications/n-1", ""},
		{http.MethodGet, "/v1/ops/dead", ""},
		{http.MethodGet, "/v1/ops/notifications/n-1/attempts", ""},
		{http.MethodPost, "/v1/ops/replays/preview", `{"notification_ids":["n-1"],"justification":"vendor recovery was confirmed"}`},
		{http.MethodPost, "/v1/ops/replays/execute", `{"items":[{"notification_id":"n-1","expected_version":1}],"justification":"vendor recovery was confirmed"}`},
	}
	for _, authCase := range []struct {
		name   string
		header string
		err    error
	}{
		{name: "missing"},
		{name: "invalid", header: "Bearer invalid", err: calleraccess.Rejection{Category: calleraccess.RejectionUnauthenticated}},
		{name: "revoked", header: "Bearer revoked", err: calleraccess.Rejection{Category: calleraccess.RejectionUnauthenticated}},
	} {
		t.Run(authCase.name, func(t *testing.T) {
			for _, route := range routes {
				ops := &fakeOperations{}
				srv := opsTestServer(t, ops, &fakeAuthenticator{authErr: authCase.err})
				req := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
				if authCase.header != "" {
					req.Header.Set("Authorization", authCase.header)
				}
				if route.method == http.MethodPost {
					req.Header.Set("Content-Type", "application/json")
				}
				rec := httptest.NewRecorder()
				srv.Handler().ServeHTTP(rec, req)
				if rec.Code != http.StatusUnauthorized || ops.calls != 0 {
					t.Fatalf("%s %s status=%d operations_calls=%d", route.method, route.path, rec.Code, ops.calls)
				}
			}
		})
	}
}

func TestOpsHandlersAuthenticateRateLimitAndReturnStableEnvelope(t *testing.T) {
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilityReadNotifications}}}
	ops := &fakeOperations{outbox: operationscontrol.OutboxProjection{PendingCount: 2}}
	srv := opsTestServer(t, ops, auth)
	req := httptest.NewRequest(http.MethodGet, "/v1/ops/outbox?vendor_id=vendor-a", nil)
	req.Header.Set("Authorization", "Bearer op.key")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || len(auth.rateCalls) != 1 || auth.rateCalls[0] != "op-1:operator_read" {
		t.Fatalf("status=%d calls=%v body=%s", rec.Code, auth.rateCalls, rec.Body.String())
	}
	var envelope map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil || envelope["request_id"] == "" || envelope["data"] == nil {
		t.Fatalf("invalid envelope=%v err=%v", envelope, err)
	}
}

func TestOpsReplayHandlersRejectOpenEndedAndMalformedWrites(t *testing.T) {
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilityReplayExecute, calleraccess.CapabilityReplayBatch}}}
	ops := &fakeOperations{}
	srv := opsTestServer(t, ops, auth)
	for _, body := range []string{
		`{"filter":{"state":"dead"},"justification":"vendor recovery was confirmed"}`,
		`{"items":[{"notification_id":"n-1","expected_version":1}],"justification":"vendor recovery was confirmed","actor_id":"forged"}`,
		`{"items":[{"notification_id":"n-1","expected_version":1}],"justification":"vendor recovery was confirmed"} {}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/v1/ops/replays/execute", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer op.key")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status=%d response=%s", body, rec.Code, rec.Body.String())
		}
	}
	if len(ops.executeBody) != 0 {
		t.Fatalf("malformed execute reached service: %+v", ops.executeBody)
	}
}

func TestOpsExecuteReauthenticatesAfterPreviewRevocation(t *testing.T) {
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilityReplayPreview, calleraccess.CapabilityReplayExecute}}}
	ops := &fakeOperations{preview: []operationscontrol.ReplayPreviewItem{{InputIndex: 0, NotificationID: "n-1", Outcome: "eligible", CurrentState: "dead", ExpectedVersion: 7}}}
	srv := opsTestServer(t, ops, auth)
	preview := httptest.NewRequest(http.MethodPost, "/v1/ops/replays/preview", strings.NewReader(`{"notification_ids":["n-1"],"justification":"vendor recovery was confirmed"}`))
	preview.Header.Set("Authorization", "Bearer active")
	preview.Header.Set("Content-Type", "application/json")
	previewRecorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(previewRecorder, preview)
	if previewRecorder.Code != http.StatusOK || ops.calls != 1 {
		t.Fatalf("preview status=%d calls=%d", previewRecorder.Code, ops.calls)
	}
	auth.authErr = calleraccess.Rejection{Category: calleraccess.RejectionUnauthenticated}
	execute := httptest.NewRequest(http.MethodPost, "/v1/ops/replays/execute", strings.NewReader(`{"items":[{"notification_id":"n-1","expected_version":7}],"justification":"vendor recovery was confirmed"}`))
	execute.Header.Set("Authorization", "Bearer revoked")
	execute.Header.Set("Content-Type", "application/json")
	executeRecorder := httptest.NewRecorder()
	srv.Handler().ServeHTTP(executeRecorder, execute)
	if executeRecorder.Code != http.StatusUnauthorized || ops.calls != 1 || len(ops.executeBody) != 0 {
		t.Fatalf("execute status=%d calls=%d writes=%v", executeRecorder.Code, ops.calls, ops.executeBody)
	}
}

func TestOpsRequestLoggingExcludesKeyPayloadJustificationAndStoreFields(t *testing.T) {
	const rawKeyMarker = "raw-key-material-must-not-log"
	const justificationMarker = "justification-full-text-must-not-log"
	var logs bytes.Buffer
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilityReplayExecute}}}
	ops := &fakeOperations{execute: operationscontrol.ReplayExecuteResult{Succeeded: []operationscontrol.ReplaySucceeded{}, Skipped: []operationscontrol.ReplaySkipped{}, Failed: []operationscontrol.ReplayFailed{{InputIndex: 0, NotificationID: "n-1", Reason: "unavailable"}}}}
	srv := opsTestServer(t, ops, auth)
	srv.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	req := httptest.NewRequest(http.MethodPost, "/v1/ops/replays/execute", strings.NewReader(`{"items":[{"notification_id":"n-1","expected_version":7}],"justification":"`+justificationMarker+`"}`))
	req.Header.Set("Authorization", "Bearer "+rawKeyMarker)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	combined := logs.String() + rec.Body.String()
	for _, forbidden := range []string{rawKeyMarker, justificationMarker, "payload", "credential", "lease_id", "actor_id"} {
		if strings.Contains(combined, forbidden) {
			t.Fatalf("runtime surface leaked %q: %s", forbidden, combined)
		}
	}
}

func TestOpsHandlersMapStoreErrorsWithoutExistenceLeak(t *testing.T) {
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilityReadNotifications}}}
	ops := &fakeOperations{err: errors.New("database down")}
	srv := opsTestServer(t, ops, auth)
	req := httptest.NewRequest(http.MethodGet, "/v1/ops/notifications/unknown", nil)
	req.Header.Set("Authorization", "Bearer op.key")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || strings.Contains(rec.Body.String(), "database down") {
		t.Fatalf("response=%d %s", rec.Code, rec.Body.String())
	}
}

func TestOpsRoutesMatchClosedResponseShapes(t *testing.T) {
	now := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{
		calleraccess.CapabilityReadNotifications, calleraccess.CapabilityReplayPreview, calleraccess.CapabilityReplayExecute, calleraccess.CapabilityReplayBatch,
	}}}
	ops := &fakeOperations{
		outbox:   operationscontrol.OutboxProjection{},
		status:   operationscontrol.NotificationStatus{NotificationID: "n-1", State: "dead", Version: 2, DeliveryCycleStartedAt: now, CreatedAt: now},
		dead:     operationscontrol.DeadPage{Items: []operationscontrol.DeadProjection{{NotificationID: "n-1", VendorID: "vendor-a", State: "dead", Version: 2, DeadAt: now, DeadReason: "deadline_exceeded"}}},
		attempts: operationscontrol.AttemptPage{Items: []operationscontrol.AttemptProjection{{AttemptSeq: 1, EventKind: "claimed", RecordedAt: now}}},
		preview:  []operationscontrol.ReplayPreviewItem{{InputIndex: 0, NotificationID: "n-1", Outcome: "eligible", CurrentState: "dead", ExpectedVersion: 2}},
		execute:  operationscontrol.ReplayExecuteResult{Succeeded: []operationscontrol.ReplaySucceeded{{InputIndex: 0, NotificationID: "n-1", State: "pending", Version: 3}}, Skipped: []operationscontrol.ReplaySkipped{}, Failed: []operationscontrol.ReplayFailed{}},
	}
	srv := opsTestServer(t, ops, auth)
	router := loadContractRouter(t)
	headers := http.Header{"Authorization": {"Bearer op.key"}}
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/ops/outbox", headers, nil)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/ops/notifications/n-1", headers, nil)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/ops/dead", headers, nil)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/ops/notifications/n-1/attempts", headers, nil)
	jsonHeaders := headers.Clone()
	jsonHeaders.Set("Content-Type", "application/json")
	validateExchange(t, router, srv.Handler(), http.MethodPost, "/v1/ops/replays/preview", jsonHeaders, []byte(`{"notification_ids":["n-1"],"justification":"vendor recovery was confirmed"}`))
	validateExchange(t, router, srv.Handler(), http.MethodPost, "/v1/ops/replays/execute", jsonHeaders, []byte(`{"items":[{"notification_id":"n-1","expected_version":2}],"justification":"vendor recovery was confirmed"}`))
}

func TestOpsMajorErrorResponsesMatchOpenAPI(t *testing.T) {
	router := loadContractRouter(t)
	validReader := calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilityReadNotifications}}
	t.Run("400 outbox query", func(t *testing.T) {
		srv := opsTestServer(t, &fakeOperations{}, &fakeAuthenticator{operator: validReader})
		if got := validateInvalidRequestResponse(t, router, srv.Handler(), http.MethodGet, "/v1/ops/outbox?unexpected=true", http.Header{"Authorization": {"Bearer op.key"}}, nil); got != http.StatusBadRequest {
			t.Fatalf("status=%d want=%d", got, http.StatusBadRequest)
		}
	})
	t.Run("400 notification id", func(t *testing.T) {
		srv := opsTestServer(t, &fakeOperations{err: operationscontrol.Rejection{Category: operationscontrol.RejectionInvalidRequest}}, &fakeAuthenticator{operator: validReader})
		if got := validateInvalidRequestResponse(t, router, srv.Handler(), http.MethodGet, "/v1/ops/notifications/"+strings.Repeat("n", 129), http.Header{"Authorization": {"Bearer op.key"}}, nil); got != http.StatusBadRequest {
			t.Fatalf("status=%d want=%d", got, http.StatusBadRequest)
		}
	})
	t.Run("401", func(t *testing.T) {
		srv := opsTestServer(t, &fakeOperations{}, &fakeAuthenticator{})
		if got := validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/ops/outbox", nil, nil); got != http.StatusUnauthorized {
			t.Fatalf("status=%d want=%d", got, http.StatusUnauthorized)
		}
	})
	t.Run("403", func(t *testing.T) {
		srv := opsTestServer(t, &fakeOperations{err: calleraccess.Rejection{Category: calleraccess.RejectionForbidden}}, &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}}})
		if got := validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/ops/outbox", http.Header{"Authorization": {"Bearer op.key"}}, nil); got != http.StatusForbidden {
			t.Fatalf("status=%d want=%d", got, http.StatusForbidden)
		}
	})
	t.Run("404", func(t *testing.T) {
		srv := opsTestServer(t, &fakeOperations{err: notificationstore.Rejection{Category: notificationstore.RejectionNotFound}}, &fakeAuthenticator{operator: validReader})
		if got := validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/ops/notifications/n-1", http.Header{"Authorization": {"Bearer op.key"}}, nil); got != http.StatusNotFound {
			t.Fatalf("status=%d want=%d", got, http.StatusNotFound)
		}
	})
	t.Run("429", func(t *testing.T) {
		srv := opsTestServer(t, &fakeOperations{}, &fakeAuthenticator{operator: validReader, rateErr: errors.New("limited"), rateAfter: time.Second})
		if got := validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/ops/outbox", http.Header{"Authorization": {"Bearer op.key"}}, nil); got != http.StatusTooManyRequests {
			t.Fatalf("status=%d want=%d", got, http.StatusTooManyRequests)
		}
	})
	t.Run("503", func(t *testing.T) {
		srv := opsTestServer(t, &fakeOperations{err: errors.New("store down")}, &fakeAuthenticator{operator: validReader})
		if got := validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/ops/outbox", http.Header{"Authorization": {"Bearer op.key"}}, nil); got != http.StatusServiceUnavailable {
			t.Fatalf("status=%d want=%d", got, http.StatusServiceUnavailable)
		}
	})
}
