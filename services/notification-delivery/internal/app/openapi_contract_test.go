package app

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/legacy"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry"
)

func loadContractRouter(t *testing.T) routers.Router {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(file), "..", "..", "docs", "api", "openapi.yaml")
	doc, err := openapi3.NewLoader().LoadFromFile(path)
	if err != nil {
		t.Fatalf("load OpenAPI: %v", err)
	}
	router, err := legacy.NewRouter(doc)
	if err != nil {
		t.Fatalf("validate OpenAPI: %v", err)
	}
	return router
}

func validateExchange(t *testing.T, router routers.Router, handler http.Handler, method, path string, headers http.Header, body []byte) int {
	t.Helper()
	contractReq := httptest.NewRequest(method, "https://rc-wsman.internal"+path, bytes.NewReader(body))
	contractReq.Header = headers.Clone()
	route, params, err := router.FindRoute(contractReq)
	if err != nil {
		t.Fatalf("route %s %s: %v", method, path, err)
	}
	requestInput := &openapi3filter.RequestValidationInput{
		Request: contractReq, PathParams: params, Route: route,
		Options: &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc},
	}
	if err := openapi3filter.ValidateRequest(context.Background(), requestInput); err != nil {
		t.Fatalf("request contract %s %s: %v", method, path, err)
	}

	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header = headers.Clone()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	responseInput := (&openapi3filter.ResponseValidationInput{
		RequestValidationInput: requestInput, Status: rec.Code, Header: rec.Header(),
	}).SetBodyBytes(rec.Body.Bytes())
	if err := openapi3filter.ValidateResponse(context.Background(), responseInput); err != nil {
		t.Fatalf("response contract %s %s (%d %s): %v", method, path, rec.Code, rec.Body.String(), err)
	}
	return rec.Code
}

// validateInvalidRequestResponse validates the documented error response for a
// request that is intentionally outside the OpenAPI request schema. Such a
// request cannot pass request validation by definition, but its handler result
// must still use a status/schema declared on the matched operation.
func validateInvalidRequestResponse(t *testing.T, router routers.Router, handler http.Handler, method, path string, headers http.Header, body []byte) int {
	t.Helper()
	contractReq := httptest.NewRequest(method, "https://rc-wsman.internal"+path, bytes.NewReader(body))
	contractReq.Header = headers.Clone()
	route, params, err := router.FindRoute(contractReq)
	if err != nil {
		t.Fatalf("route %s %s: %v", method, path, err)
	}
	requestInput := &openapi3filter.RequestValidationInput{
		Request: contractReq, PathParams: params, Route: route,
		Options: &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc},
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header = headers.Clone()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	responseInput := (&openapi3filter.ResponseValidationInput{RequestValidationInput: requestInput, Status: rec.Code, Header: rec.Header()}).SetBodyBytes(rec.Body.Bytes())
	if err := openapi3filter.ValidateResponse(context.Background(), responseInput); err != nil {
		t.Fatalf("invalid-request response contract %s %s (%d %s): %v", method, path, rec.Code, rec.Body.String(), err)
	}
	return rec.Code
}

func validateRequestRejected(t *testing.T, router routers.Router, method, path string, headers http.Header, body []byte) {
	t.Helper()
	request := httptest.NewRequest(method, "https://rc-wsman.internal"+path, bytes.NewReader(body))
	request.Header = headers.Clone()
	route, params, err := router.FindRoute(request)
	if err != nil {
		t.Fatal(err)
	}
	input := &openapi3filter.RequestValidationInput{Request: request, PathParams: params, Route: route, Options: &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc}}
	if err := openapi3filter.ValidateRequest(context.Background(), input); err == nil {
		t.Fatalf("request unexpectedly matched OpenAPI union: %s", body)
	}
}

func TestB3RoutesMatchOpenAPI(t *testing.T) {
	now := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	store := &fakeStore{result: notificationstore.IntakeResult{NotificationID: "n-1", AcceptedAt: now}}
	auth := &fakeAuthenticator{
		caller: calleraccess.CallerPrincipal{PrincipalID: "caller-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{calleraccess.CapabilitySubmitNotification}},
		operator: calleraccess.OperatorPrincipal{PrincipalID: "operator-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{
			vendorregistry.CapabilityRegister, vendorregistry.CapabilityRead, vendorregistry.CapabilityReadHistory, vendorregistry.CapabilityReadAudit,
		}},
	}
	vr := &fakeVendorRegistry{
		active:      true,
		adminResult: vendorregistry.AdminResult{Operation: "register", VendorID: "vendor-a", Lifecycle: "draft", RecordRevision: 1, CurrentConfigVersion: 1},
		listPage:    vendorregistry.Page[vendorregistry.VendorListItem]{Items: []vendorregistry.VendorListItem{{VendorID: "vendor-a", Lifecycle: "draft", OwningScope: "team-a", RecordRevision: 1, CurrentConfigVersion: 1, CreatedAt: now}}},
		state:       vendorregistry.VendorStateSummary{VendorID: "vendor-a", Lifecycle: "draft", OwningScope: "team-a", RecordRevision: 1, CurrentConfigVersion: 1, ConfigVersionCount: 1, CreatedAt: now},
		versionPage: vendorregistry.Page[vendorregistry.EndpointVersionListItem]{Items: []vendorregistry.EndpointVersionListItem{
			{VendorID: "vendor-a", ConfigVersion: 1, ConfigSchemaVersion: 1, CanonicalURL: "https://example.com/hook", Method: "POST", TransportKind: "https_public", AuthStrategy: "bearer", ResponsePolicy: vendorregistry.ResponsePolicyHTTPStatusV1, CredentialDescriptor: &vendorregistry.CredentialDescriptor{Scheme: "env"}, CreatedAt: now, CreatedByActor: "operator-1"},
			{VendorID: "vendor-a", ConfigVersion: 2, ConfigSchemaVersion: 2, CanonicalURL: "https://example.com/hook", Method: "POST", TransportKind: "https_public", AuthStrategy: "none", ResponsePolicy: vendorregistry.ResponsePolicyHTTPStatusV1, CreatedAt: now, CreatedByActor: "operator-1"},
		}},
		versionCap: 2,
		auditPage:  vendorregistry.Page[vendorregistry.AdminAuditListItem]{Items: []vendorregistry.AdminAuditListItem{{EventID: "event-1", AuditSeq: 1, VendorID: "vendor-a", ActorID: "operator-1", AuthorizationBasis: "vendor_id", Operation: "register", Outcome: "success", SanitizedRequestDigest: "0123456789abcdef", OccurredAt: now}}},
	}
	srv := newTestServer(t, store, auth, vr)
	router := loadContractRouter(t)
	jsonHeaders := http.Header{"Authorization": {"Bearer valid.key"}, "Content-Type": {"application/json"}, "Idempotency-Key": {"key-1"}}
	validateExchange(t, router, srv.Handler(), http.MethodPost, "/v1/notifications", jsonHeaders, []byte(`{"vendor_id":"vendor-a","payload_base64":"e30="}`))
	adminBody := []byte(`{"operation":"register","vendor_id":"vendor-a","expected_record_revision":0,"idempotency_key":"admin-key-1","body":{"owning_scope":"team-a","initial_config":{"endpoint_target":{"url":"https://example.com/hook"},"method":"POST","transport_auth_headers":[],"outbound_idempotency_mapping":{"mode":"none"},"endpoint_policy":{"allowed_request_header_names":[],"forbidden_request_header_names":[],"max_request_body_bytes":65536},"auth_strategy":"bearer","credential_ref":{"scheme":"env","opaque_handle":"TOKEN"}}}}`)
	validateExchange(t, router, srv.Handler(), http.MethodPost, "/v1/vendor-admin/commands", jsonHeaders, adminBody)
	getHeaders := http.Header{"Authorization": {"Bearer valid.key"}}
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/vendors", getHeaders, nil)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/vendors?scope_filter%5Bkind%5D=vendor_ids&scope_filter%5Bvendor_ids%5D=vendor-a", getHeaders, nil)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/vendors/vendor-a", getHeaders, nil)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/vendors/vendor-a/versions", getHeaders, nil)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/v1/vendor-admin/audit-events", getHeaders, nil)
	_ = io.EOF
}

func TestVendorAdminSchemaV2OpenAPIUnion(t *testing.T) {
	vr := &fakeVendorRegistry{adminResult: vendorregistry.AdminResult{Operation: "register", VendorID: "vendor-a", Lifecycle: "draft", RecordRevision: 1, CurrentConfigVersion: 1}}
	auth := &fakeAuthenticator{operator: calleraccess.OperatorPrincipal{PrincipalID: "operator-1", VendorScope: []string{"vendor-a"}, Capabilities: []string{vendorregistry.CapabilityRegister, vendorregistry.CapabilityUpdate}}}
	srv := newTestServer(t, &fakeStore{}, auth, vr)
	router := loadContractRouter(t)
	headers := http.Header{"Authorization": {"Bearer valid.key"}, "Content-Type": {"application/json"}, "Idempotency-Key": {"key-1"}}

	v2Bearer := []byte(`{"operation":"register","vendor_id":"vendor-a","expected_record_revision":0,"idempotency_key":"v2-bearer","body":{"owning_scope":"team-a","initial_config":{"config_schema_version":2,"response_policy":"json_ack_v1","endpoint_target":{"url":"https://example.com/hook"},"method":"POST","transport_auth_headers":[],"outbound_idempotency_mapping":{"mode":"none"},"endpoint_policy":{"allowed_request_header_names":[],"forbidden_request_header_names":[],"max_request_body_bytes":65536},"auth_strategy":"bearer","credential_ref":{"scheme":"env","opaque_handle":"TOKEN"}}}}`)
	validateExchange(t, router, srv.Handler(), http.MethodPost, "/v1/vendor-admin/commands", headers, v2Bearer)

	v2None := []byte(`{"operation":"register","vendor_id":"vendor-a","expected_record_revision":0,"idempotency_key":"v2-none","body":{"owning_scope":"team-a","initial_config":{"config_schema_version":2,"response_policy":"http_status_v1","endpoint_target":{"url":"https://example.com/hook"},"method":"POST","transport_auth_headers":[],"outbound_idempotency_mapping":{"mode":"headers","source":"ingress_idempotency_key","header_names":["idempotency-key","x-openslack-idempotency-key"]},"endpoint_policy":{"allowed_request_header_names":["idempotency-key","x-openslack-idempotency-key"],"forbidden_request_header_names":[],"max_request_body_bytes":65536},"auth_strategy":"none"}}}`)
	validateExchange(t, router, srv.Handler(), http.MethodPost, "/v1/vendor-admin/commands", headers, v2None)

	for _, invalid := range [][]byte{
		[]byte(`{"operation":"register","vendor_id":"vendor-a","expected_record_revision":0,"idempotency_key":"missing-policy","body":{"owning_scope":"team-a","initial_config":{"config_schema_version":2,"endpoint_target":{"url":"https://example.com/hook"},"method":"POST","transport_auth_headers":[],"outbound_idempotency_mapping":{"mode":"none"},"endpoint_policy":{"allowed_request_header_names":[],"forbidden_request_header_names":[],"max_request_body_bytes":65536},"auth_strategy":"none"}}}`),
		[]byte(`{"operation":"register","vendor_id":"vendor-a","expected_record_revision":0,"idempotency_key":"none-credential","body":{"owning_scope":"team-a","initial_config":{"config_schema_version":2,"response_policy":"http_status_v1","endpoint_target":{"url":"https://example.com/hook"},"method":"POST","transport_auth_headers":[],"outbound_idempotency_mapping":{"mode":"none"},"endpoint_policy":{"allowed_request_header_names":[],"forbidden_request_header_names":[],"max_request_body_bytes":65536},"auth_strategy":"none","credential_ref":{"scheme":"env","opaque_handle":"TOKEN"}}}}`),
		[]byte(`{"operation":"register","vendor_id":"vendor-a","expected_record_revision":0,"idempotency_key":"body-rewrite","body":{"owning_scope":"team-a","initial_config":{"config_schema_version":2,"response_policy":"http_status_v1","endpoint_target":{"url":"https://example.com/hook"},"method":"POST","transport_auth_headers":[],"outbound_idempotency_mapping":{"mode":"body_field","field_name":"id"},"endpoint_policy":{"allowed_request_header_names":[],"forbidden_request_header_names":[],"max_request_body_bytes":65536},"auth_strategy":"none"}}}`),
	} {
		validateRequestRejected(t, router, http.MethodPost, "/v1/vendor-admin/commands", headers, invalid)
	}
}

func TestPlatformRoutesMatchOpenAPI(t *testing.T) {
	srv := newTestServer(t, &fakeStore{}, &fakeAuthenticator{}, &fakeVendorRegistry{})
	router := loadContractRouter(t)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/health/live", nil, nil)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/health/ready", nil, nil)
	validateExchange(t, router, srv.Handler(), http.MethodGet, "/metrics", nil, nil)
}
