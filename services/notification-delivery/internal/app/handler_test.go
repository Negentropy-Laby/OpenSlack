package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/reliability"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry"
)

const testDeploymentDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type fakeStore struct {
	intake notificationstore.ValidatedIntake
	result notificationstore.IntakeResult
	err    error
}

func (s *fakeStore) Intake(ctx context.Context, in notificationstore.ValidatedIntake) (notificationstore.IntakeResult, error) {
	s.intake = in
	return s.result, s.err
}

type fakeAuthenticator struct {
	caller    calleraccess.CallerPrincipal
	operator  calleraccess.OperatorPrincipal
	authErr   error
	rateErr   error
	rateAfter time.Duration
	rateCalls []string
}

func (a *fakeAuthenticator) AuthenticateCaller(ctx context.Context, bearer string) (calleraccess.CallerPrincipal, error) {
	return a.caller, a.authErr
}

func (a *fakeAuthenticator) AuthenticateOperator(ctx context.Context, bearer string) (calleraccess.OperatorPrincipal, error) {
	return a.operator, a.authErr
}

func (a *fakeAuthenticator) ApplyRateLimit(principalID string, opClass string) (time.Duration, error) {
	a.rateCalls = append(a.rateCalls, principalID+":"+opClass)
	return a.rateAfter, a.rateErr
}

type fakeVendorRegistry struct {
	active      bool
	activeErr   error
	adminResult vendorregistry.AdminResult
	adminErr    error
	listPage    vendorregistry.Page[vendorregistry.VendorListItem]
	listErr     error
	versionPage vendorregistry.Page[vendorregistry.EndpointVersionListItem]
	versionCap  int64
	versionErr  error
	auditPage   vendorregistry.Page[vendorregistry.AdminAuditListItem]
	auditErr    error
	state       vendorregistry.VendorStateSummary
	stateErr    error
	adminActor  vendorregistry.ActorContext
	adminCmd    vendorregistry.AdminCommand
	listCalls   int
	activeCalls int
	activeActor vendorregistry.ActorContext
	activeID    string
	listFilter  vendorregistry.ScopeFilter
}

func (vr *fakeVendorRegistry) ExecuteCommand(ctx context.Context, actor vendorregistry.ActorContext, cmd vendorregistry.AdminCommand) (vendorregistry.AdminResult, error) {
	vr.adminActor = actor
	vr.adminCmd = cmd
	return vr.adminResult, vr.adminErr
}

func (vr *fakeVendorRegistry) IsVendorActive(ctx context.Context, actor vendorregistry.ActorContext, vendorID string) (bool, error) {
	vr.activeCalls++
	vr.activeActor = actor
	vr.activeID = vendorID
	return vr.active, vr.activeErr
}

func (vr *fakeVendorRegistry) ListVendors(ctx context.Context, actor vendorregistry.ActorContext, filter vendorregistry.ScopeFilter, cursor string, limit int) (vendorregistry.Page[vendorregistry.VendorListItem], error) {
	vr.listCalls++
	vr.listFilter = filter
	return vr.listPage, vr.listErr
}

func (vr *fakeVendorRegistry) DescribeVendorState(ctx context.Context, actor vendorregistry.ActorContext, vendorID string) (vendorregistry.VendorStateSummary, error) {
	return vr.state, vr.stateErr
}

func (vr *fakeVendorRegistry) ListEndpointVersions(ctx context.Context, actor vendorregistry.ActorContext, vendorID string, cursor string, limit int) (vendorregistry.Page[vendorregistry.EndpointVersionListItem], int64, error) {
	return vr.versionPage, vr.versionCap, vr.versionErr
}

func (vr *fakeVendorRegistry) ListAdminAuditEvents(ctx context.Context, actor vendorregistry.ActorContext, filter vendorregistry.ScopeFilter, cursor string, limit int) (vendorregistry.Page[vendorregistry.AdminAuditListItem], error) {
	return vr.auditPage, vr.auditErr
}

func newTestServer(t *testing.T, store *fakeStore, auth *fakeAuthenticator, vr *fakeVendorRegistry) *Server {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer(":0", "/metrics", testDeploymentDigest, nil, logger)
	srv.SetDeps(Deps{
		Store: store, Authenticator: auth, VendorRegistry: vr,
		Operations:  &fakeOperations{},
		Reliability: fixedReliability{snapshot: reliability.Snapshot{}},
	})
	srv.SetReady(func() bool { return true })
	return srv
}

func TestHandleSubmitNotification_MissingAuth(t *testing.T) {
	srv := newTestServer(t, &fakeStore{}, &fakeAuthenticator{}, &fakeVendorRegistry{})
	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"eyJ4IjoxfQ=="}`))
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var envelope map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["request_id"] == nil || envelope["error"] == nil {
		t.Fatalf("invalid error envelope: %v", envelope)
	}
	if errObj := envelope["error"].(map[string]any); errObj["request_id"] != nil {
		t.Fatalf("request_id leaked into error detail: %v", errObj)
	}
}

func TestHandleSubmitNotification_InvalidCredentialsUseUniform401WithoutDownstream(t *testing.T) {
	for _, category := range []string{"malformed", "unknown", "revoked"} {
		t.Run(category, func(t *testing.T) {
			store := &fakeStore{}
			vr := &fakeVendorRegistry{active: true}
			auth := &fakeAuthenticator{authErr: calleraccess.Rejection{Category: calleraccess.RejectionUnauthenticated}}
			srv := newTestServer(t, store, auth, vr)
			req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"e30="}`))
			req.Header.Set("Authorization", "Bearer "+category)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", "key-1")
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"code":"UNAUTHENTICATED"`) {
				t.Fatalf("response=%d %s", rec.Code, rec.Body.String())
			}
			if store.intake.CallerID != "" || vr.activeCalls != 0 || len(auth.rateCalls) != 0 {
				t.Fatalf("downstream invoked: intake=%+v active_calls=%d rate=%v", store.intake, vr.activeCalls, auth.rateCalls)
			}
		})
	}
}

func TestHandleSubmitNotification_RequiresIdempotencyKey(t *testing.T) {
	auth := &fakeAuthenticator{caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}}}
	srv := newTestServer(t, &fakeStore{}, auth, &fakeVendorRegistry{active: true})
	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"e30="}`))
	req.Header.Set("Authorization", "Bearer valid.key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestHandleSubmitNotification_StrictJSON(t *testing.T) {
	auth := &fakeAuthenticator{caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}}}
	srv := newTestServer(t, &fakeStore{}, auth, &fakeVendorRegistry{active: true})
	for _, tc := range []struct{ contentType, body string }{
		{"text/plain", `{"vendor_id":"vendor-a","payload_base64":"e30="}`},
		{"application/json", `{"vendor_id":"vendor-a","payload_base64":"e30=","caller_id":"forged"}`},
		{"application/json", `{"vendor_id":"vendor-a","payload_base64":"e30="} {}`},
	} {
		req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(tc.body))
		req.Header.Set("Authorization", "Bearer valid.key")
		req.Header.Set("Content-Type", tc.contentType)
		req.Header.Set("Idempotency-Key", "key-1")
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s %s: status=%d", tc.contentType, tc.body, rec.Code)
		}
	}
}

func TestHandleSubmitNotification_RejectsOmittedRequiredBodyFieldsBeforeDownstream(t *testing.T) {
	auth := &fakeAuthenticator{caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}}}
	for name, body := range map[string]string{
		"vendor_id":      `{"payload_base64":"e30="}`,
		"payload_base64": `{"vendor_id":"vendor-a"}`,
	} {
		t.Run(name, func(t *testing.T) {
			store := &fakeStore{}
			vr := &fakeVendorRegistry{active: true}
			srv := newTestServer(t, store, auth, vr)
			req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer valid.key")
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", "key-1")
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"INVALID_REQUEST"`) {
				t.Fatalf("response=%d %s", rec.Code, rec.Body.String())
			}
			if store.intake.CallerID != "" || len(auth.rateCalls) != 0 {
				t.Fatalf("downstream invoked: intake=%+v rate=%v", store.intake, auth.rateCalls)
			}
		})
	}
}

func TestHandleSubmitNotification_StoreFailureIsContract503(t *testing.T) {
	store := &fakeStore{err: errors.New("database unavailable")}
	auth := &fakeAuthenticator{caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}}}
	srv := newTestServer(t, store, auth, &fakeVendorRegistry{active: true})
	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"e30="}`))
	req.Header.Set("Authorization", "Bearer valid.key")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "key-1")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"code":"SERVICE_UNAVAILABLE"`) {
		t.Fatalf("response: %d %s", rec.Code, rec.Body.String())
	}
}

func TestHandleSubmitNotification_SelfReportedIdentity(t *testing.T) {
	auth := &fakeAuthenticator{caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}}}
	srv := newTestServer(t, &fakeStore{}, auth, &fakeVendorRegistry{})
	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"eyJ4IjoxfQ==","caller_id":"me"}`))
	req.Header.Set("Authorization", "Bearer x.y")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "key-1")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestHandleSubmitNotification_OutOfScopeDoesNotCallVendorRegistry(t *testing.T) {
	store := &fakeStore{}
	auth := &fakeAuthenticator{caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}}}
	vr := &fakeVendorRegistry{active: true}
	srv := newTestServer(t, store, auth, vr)
	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-b","payload_base64":"e30="}`))
	req.Header.Set("Authorization", "Bearer valid.key")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "key-1")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"VENDOR_UNAVAILABLE"`) {
		t.Fatalf("response=%d %s", rec.Code, rec.Body.String())
	}
	if vr.activeCalls != 0 || store.intake.CallerID != "" || len(auth.rateCalls) != 0 {
		t.Fatalf("downstream invoked: active_calls=%d intake=%+v rate=%v", vr.activeCalls, store.intake, auth.rateCalls)
	}
}

func TestHandleSubmitNotification_RequiresSubmitCapabilityBeforeDownstream(t *testing.T) {
	store := &fakeStore{}
	auth := &fakeAuthenticator{caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilityReadNotifications}}}
	srv := newTestServer(t, store, auth, &fakeVendorRegistry{active: true})
	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"e30="}`))
	req.Header.Set("Authorization", "Bearer valid.key")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "key-1")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"code":"FORBIDDEN"`) {
		t.Fatalf("response=%d %s", rec.Code, rec.Body.String())
	}
	if store.intake.CallerID != "" || len(auth.rateCalls) != 0 {
		t.Fatalf("downstream invoked: intake=%+v rate=%v", store.intake, auth.rateCalls)
	}
}

func TestHandleSubmitNotification_Success(t *testing.T) {
	acceptedAt := time.Date(2026, 7, 22, 1, 2, 3, 0, time.UTC)
	store := &fakeStore{result: notificationstore.IntakeResult{NotificationID: "notif-1", IdempotentReplay: false, AcceptedAt: acceptedAt}}
	auth := &fakeAuthenticator{
		caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}},
	}
	vr := &fakeVendorRegistry{active: true}
	srv := newTestServer(t, store, auth, vr)

	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"eyJ4IjoxfQ=="}`))
	req.Header.Set("Authorization", "Bearer valid.key")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "key-1")
	req.Header.Set("X-Notification-Service-Deployment-Digest", "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if got := rec.Header().Get("X-Notification-Service-Deployment-Digest"); got != testDeploymentDigest {
		t.Fatalf("deployment digest header = %q, want current deployment %q", got, testDeploymentDigest)
	}
	if store.intake.CallerID != "caller-1" {
		t.Fatalf("caller id = %s, want caller-1", store.intake.CallerID)
	}
	if store.intake.VendorID != "vendor-a" {
		t.Fatalf("vendor id = %s, want vendor-a", store.intake.VendorID)
	}
	if string(store.intake.Payload) != `{"x":1}` {
		t.Fatalf("payload = %s, want {\"x\":1}", string(store.intake.Payload))
	}
	if vr.activeID != "vendor-a" || vr.activeActor.Kind != vendorregistry.ActorKindIngress || vr.activeActor.ActorID != "caller-1" ||
		len(vr.activeActor.VendorScope.VendorIDs) != 1 || vr.activeActor.VendorScope.VendorIDs[0] != "vendor-a" ||
		len(vr.activeActor.Capabilities) != 1 || vr.activeActor.Capabilities[0] != vendorregistry.CapabilityReadActive {
		t.Fatalf("vendor registry context was not singleton and attenuated: id=%q actor=%+v", vr.activeID, vr.activeActor)
	}
	var envelope struct {
		RequestID string `json:"request_id"`
		Data      struct {
			NotificationID   string `json:"notification_id"`
			State            string `json:"state"`
			AcceptedAt       string `json:"accepted_at"`
			IdempotentReplay bool   `json:"idempotent_replay"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if envelope.RequestID == "" || envelope.Data.NotificationID != "notif-1" || envelope.Data.State != "pending" || envelope.Data.AcceptedAt != acceptedAt.Format(time.RFC3339Nano) {
		t.Fatalf("unexpected response: %+v", envelope)
	}
}

func TestHandleSubmitNotification_ReplayReturnsCurrentDeploymentDigest(t *testing.T) {
	acceptedAt := time.Date(2026, 7, 22, 1, 2, 3, 0, time.UTC)
	store := &fakeStore{result: notificationstore.IntakeResult{NotificationID: "notif-existing", IdempotentReplay: true, AcceptedAt: acceptedAt}}
	auth := &fakeAuthenticator{
		caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}},
	}
	srv := newTestServer(t, store, auth, &fakeVendorRegistry{active: true})
	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"e30="}`))
	req.Header.Set("Authorization", "Bearer valid.key")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "key-existing")
	req.Header.Set("X-Notification-Service-Deployment-Digest", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted || rec.Header().Get("X-Notification-Service-Deployment-Digest") != testDeploymentDigest {
		t.Fatalf("replay response=%d digest=%q", rec.Code, rec.Header().Get("X-Notification-Service-Deployment-Digest"))
	}
	var envelope struct {
		Data struct {
			NotificationID   string `json:"notification_id"`
			IdempotentReplay bool   `json:"idempotent_replay"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.NotificationID != "notif-existing" || !envelope.Data.IdempotentReplay {
		t.Fatalf("replay envelope=%+v", envelope)
	}
}

func TestHandleSubmitNotification_VendorInactive(t *testing.T) {
	auth := &fakeAuthenticator{
		caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}},
	}
	vr := &fakeVendorRegistry{active: false}
	store := &fakeStore{}
	srv := newTestServer(t, store, auth, vr)

	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"eyJ4IjoxfQ=="}`))
	req.Header.Set("Authorization", "Bearer valid.key")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "key-1")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if store.intake.CallerID != "" {
		t.Fatalf("inactive vendor reached Store: %+v", store.intake)
	}
}

func TestHandleSubmitNotification_RateLimited(t *testing.T) {
	auth := &fakeAuthenticator{
		caller:  calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}},
		rateErr: errors.New("rate limited"), rateAfter: 5 * time.Second,
	}
	vr := &fakeVendorRegistry{active: true}
	srv := newTestServer(t, &fakeStore{}, auth, vr)

	req := httptest.NewRequest(http.MethodPost, "/v1/notifications", strings.NewReader(`{"vendor_id":"vendor-a","payload_base64":"eyJ4IjoxfQ=="}`))
	req.Header.Set("Authorization", "Bearer valid.key")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "key-1")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	retry := rec.Header().Get("Retry-After")
	if retry != "5" {
		t.Fatalf("Retry-After = %s, want 5", retry)
	}
}

func TestHandleVendorAdminCommand_Success(t *testing.T) {
	auth := &fakeAuthenticator{
		operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, OwningScope: "team-a", Capabilities: []string{calleraccess.CapabilityManageAccessKeys, "vendor:register"}},
	}
	vr := &fakeVendorRegistry{adminResult: vendorregistry.AdminResult{Operation: "register", VendorID: "vendor-a", Lifecycle: "draft", RecordRevision: 1, CurrentConfigVersion: 1}}
	srv := newTestServer(t, &fakeStore{}, auth, vr)

	body := `{"operation":"register","vendor_id":"vendor-a","expected_record_revision":0,"idempotency_key":"idem-1","body":{"owning_scope":"team-a","initial_config":{}}}`
	req := httptest.NewRequest(http.MethodPost, "/v1/vendor-admin/commands", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer op.key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if vr.adminActor.VendorScope.Kind != "owning_scopes" || len(vr.adminActor.VendorScope.OwningScopes) != 1 || vr.adminActor.VendorScope.OwningScopes[0] != "team-a" {
		t.Fatalf("register actor scope = %+v", vr.adminActor.VendorScope)
	}
	if len(auth.rateCalls) != 1 || auth.rateCalls[0] != "op-1:operator_mutation" {
		t.Fatalf("rate calls = %v", auth.rateCalls)
	}
}

func TestHandleVendorAdminCommand_SelfReportedIdentity(t *testing.T) {
	auth := &fakeAuthenticator{
		operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{"vendor:register"}},
	}
	srv := newTestServer(t, &fakeStore{}, auth, &fakeVendorRegistry{})

	body := `{"operation":"register","vendor_id":"vendor-a","expected_record_revision":0,"idempotency_key":"idem-1","body":{},"actor_id":"me"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/vendor-admin/commands", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer op.key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestHandleVendorAdminCommand_RejectsMissingRequiredFields(t *testing.T) {
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, OwningScope: "team-a", Capabilities: []string{"vendor:register", "vendor:activate"}}}
	for name, body := range map[string]string{
		"expected revision": `{"operation":"register","vendor_id":"vendor-a","idempotency_key":"idem-1","body":{"owning_scope":"team-a","initial_config":{}}}`,
		"body":              `{"operation":"activate","vendor_id":"vendor-a","expected_record_revision":1,"idempotency_key":"idem-2"}`,
	} {
		t.Run(name, func(t *testing.T) {
			vr := &fakeVendorRegistry{}
			srv := newTestServer(t, &fakeStore{}, auth, vr)
			req := httptest.NewRequest(http.MethodPost, "/v1/vendor-admin/commands", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer op.key")
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"INVALID_COMMAND"`) {
				t.Fatalf("response=%d %s", rec.Code, rec.Body.String())
			}
			if vr.adminCmd.Operation != "" {
				t.Fatalf("registry called with %+v", vr.adminCmd)
			}
		})
	}
}

func TestHandleListVendors_ForbiddenCapability(t *testing.T) {
	auth := &fakeAuthenticator{
		operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{}},
	}
	srv := newTestServer(t, &fakeStore{}, auth, &fakeVendorRegistry{})
	req := httptest.NewRequest(http.MethodGet, "/v1/vendors", nil)
	req.Header.Set("Authorization", "Bearer op.key")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestHandleDescribeVendor_NotFound(t *testing.T) {
	auth := &fakeAuthenticator{
		operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{"vendor:read"}},
	}
	vr := &fakeVendorRegistry{stateErr: vendorregistry.ReadError{Code: "VENDOR_NOT_FOUND"}}
	srv := newTestServer(t, &fakeStore{}, auth, vr)
	req := httptest.NewRequest(http.MethodGet, "/v1/vendors/vendor-b", nil)
	req.Header.Set("Authorization", "Bearer op.key")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestVendorReadHandlersRejectMalformedClosedQuery(t *testing.T) {
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{vendorregistry.CapabilityRead, vendorregistry.CapabilityReadHistory}}}
	vr := &fakeVendorRegistry{}
	srv := newTestServer(t, &fakeStore{}, auth, vr)
	for _, path := range []string{
		"/v1/vendors?limit=abc",
		"/v1/vendors?vendor_ids=vendor-a",
		"/v1/vendors/vendor-a?unexpected=true",
		"/v1/vendors/vendor-a/versions?scope_kind=vendor_ids&vendor_ids=vendor-a",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer op.key")
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest && rec.Code != http.StatusForbidden {
			t.Fatalf("%s status=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}
	if vr.listCalls != 0 {
		t.Fatalf("malformed query reached registry %d times", vr.listCalls)
	}
}

func TestHandleListVendorsParsesOpenAPIDeepObjectScopeFilter(t *testing.T) {
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", VendorScope: []string{"vendor-a", "vendor-b"}, Capabilities: []string{vendorregistry.CapabilityRead}}}
	vr := &fakeVendorRegistry{}
	srv := newTestServer(t, &fakeStore{}, auth, vr)
	req := httptest.NewRequest(http.MethodGet, "/v1/vendors?scope_filter%5Bkind%5D=vendor_ids&scope_filter%5Bvendor_ids%5D=vendor-a&scope_filter%5Bvendor_ids%5D=vendor-b", nil)
	req.Header.Set("Authorization", "Bearer op.key")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || vr.listFilter.Kind != "vendor_ids" || len(vr.listFilter.VendorIDs) != 2 {
		t.Fatalf("status=%d filter=%+v body=%s", rec.Code, vr.listFilter, rec.Body.String())
	}
}

func TestAuthenticationAuthorityFailureIsServiceUnavailable(t *testing.T) {
	auth := &fakeAuthenticator{authErr: calleraccess.Rejection{Category: calleraccess.RejectionAuthorityUnavailable}}
	srv := newTestServer(t, &fakeStore{}, auth, &fakeVendorRegistry{})
	req := httptest.NewRequest(http.MethodGet, "/v1/vendors", nil)
	req.Header.Set("Authorization", "Bearer op.key")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestVendorAdminRateLimitPreventsRegistryCall(t *testing.T) {
	auth := &fakeAuthenticator{
		operator: calleraccess.OperatorPrincipal{PrincipalID: "op-1", OwningScope: "team-a", VendorScope: []string{"vendor-a"}, Capabilities: []string{vendorregistry.CapabilityRegister}},
		rateErr:  errors.New("limited"), rateAfter: 3 * time.Second,
	}
	vr := &fakeVendorRegistry{}
	srv := newTestServer(t, &fakeStore{}, auth, vr)
	body := `{"operation":"register","vendor_id":"vendor-a","expected_record_revision":0,"idempotency_key":"idem-1","body":{"owning_scope":"team-a","initial_config":{}}}`
	req := httptest.NewRequest(http.MethodPost, "/v1/vendor-admin/commands", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer op.key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "3" || vr.adminCmd.Operation != "" {
		t.Fatalf("status=%d retry=%q command=%+v", rec.Code, rec.Header().Get("Retry-After"), vr.adminCmd)
	}
}
