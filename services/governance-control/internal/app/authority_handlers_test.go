package app

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

type fakeAuthorityStore struct {
	mutateCalls      int
	readCalls        int
	receiptReadCalls int
	pendingReadCalls int
	readResult       authoritystore.ReadResult
	pending          authoritystore.PendingAudit
	mutateErr        error
}

func (store *fakeAuthorityStore) Mutate(_ context.Context, input authoritystore.MutateInput) (authoritystore.Receipt, error) {
	store.mutateCalls++
	if store.mutateErr != nil {
		return authoritystore.Receipt{}, store.mutateErr
	}
	revision := input.Prepared.TargetRevision
	committed := time.Date(2026, 8, 3, 1, 2, 3, 456789000, time.UTC)
	return authoritystore.Receipt{Schema: authoritystore.ReceiptSchema, Operation: input.Prepared.Operation,
		Status: authoritystore.ReceiptAccepted, WorkspaceID: input.Prepared.WorkspaceID, PlanID: input.Prepared.PlanID,
		ExpectedRevision: input.Prepared.ExpectedRevision, AcceptedRevision: &revision, State: input.Prepared.TargetState,
		Route: input.Prepared.Route, IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint,
		RecordHash: input.Prepared.RecordHash, CorrelationID: input.Prepared.CorrelationID, CallerID: input.Prepared.CallerID,
		ServiceBuildSHA: input.ServiceBuildSHA, RecordBytes: input.Prepared.RecordBytes, CommittedAt: &committed}, nil
}

func (store *fakeAuthorityStore) Read(context.Context, string, string) (authoritystore.ReadResult, error) {
	store.readCalls++
	if store.readResult.RecordBytes != nil {
		return store.readResult, nil
	}
	return authoritystore.ReadResult{}, authoritystore.Failure(authoritystore.ErrorNotFound, "not found", nil)
}

func TestAuthorityAcceptGateAndDrainEpochAreIndependent(t *testing.T) {
	prepared, input := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	store := &fakeAuthorityStore{readResult: authoritystore.ReadResult{Schema: authoritystore.ReadSchema,
		WorkspaceID: testsupport.WorkspaceID, PlanID: testsupport.PlanID,
		Route:      authoritystore.Route{Backend: authoritystore.Backend, Authority: authoritystore.Authority, RoutingEpoch: 6},
		RecordHash: prepared.RecordHash, RecordBytes: prepared.RecordBytes, ServiceBuildSHA: strings.Repeat("f", 64)}}
	service, err := New(Options{Store: &fakeStore{}, BuildSHA: testBuildSHA, AuthorityStore: store,
		AuthorityEnabled: true, AuthorityWorkspaceID: testsupport.WorkspaceID, AuthorityCallerID: "typescript:qoder-mcp",
		AuthorityRoutingEpoch: 7, AuthorityAcceptNewRecords: false, AuthorityDrainEpochs: []int64{6}})
	if err != nil {
		t.Fatal(err)
	}
	accept := httptest.NewRequest(http.MethodPost, RouteAuthorityAccept, bytes.NewReader(prepared.ExactBody))
	setAuthorityTestHeaders(accept, input.IdempotencyKey, "7")
	acceptResponse := httptest.NewRecorder()
	service.Handler().ServeHTTP(acceptResponse, accept)
	if acceptResponse.Code != http.StatusConflict || store.mutateCalls != 0 {
		t.Fatalf("disabled accept = %d calls=%d", acceptResponse.Code, store.mutateCalls)
	}
	read := httptest.NewRequest(http.MethodGet, "/v1/governance/plans/"+testsupport.PlanID, nil)
	setAuthorityBindingTestHeaders(read, "6")
	readResponse := httptest.NewRecorder()
	service.Handler().ServeHTTP(readResponse, read)
	if readResponse.Code != http.StatusOK || !bytes.Contains(readResponse.Body.Bytes(), []byte(`"routingEpoch":6`)) ||
		!bytes.Contains(readResponse.Body.Bytes(), []byte(`"serviceBuildSha":"`+testBuildSHA+`"`)) {
		t.Fatalf("drain read = %d %s", readResponse.Code, readResponse.Body.Bytes())
	}
}

func TestAuthorityServiceRejectsDrainAllowlistAboveBound(t *testing.T) {
	drains := make([]int64, config.MaxAuthorityDrainEpochs+1)
	for index := range drains {
		drains[index] = int64(index + 1000)
	}
	_, err := New(Options{Store: &fakeStore{}, BuildSHA: testBuildSHA, AuthorityStore: &fakeAuthorityStore{},
		AuthorityEnabled: true, AuthorityWorkspaceID: testsupport.WorkspaceID, AuthorityCallerID: "typescript:qoder-mcp",
		AuthorityRoutingEpoch: 7, AuthorityDrainEpochs: drains})
	if err == nil {
		t.Fatal("authority service accepted a drain allowlist above the bound")
	}
}

func TestAuthorityPendingAuditPointReadIsClosedAndRecordedIsNotPending(t *testing.T) {
	prepared, _ := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	store := &fakeAuthorityStore{pending: authoritystore.PendingAudit{
		Schema: authoritystore.PendingAuditSchema, Status: "pending", Operation: authoritystore.OperationAccept,
		WorkspaceID: testsupport.WorkspaceID, PlanID: testsupport.PlanID, Revision: 1,
		Route:      authoritystore.Route{Backend: authoritystore.Backend, Authority: authoritystore.Authority, RoutingEpoch: 7},
		RecordHash: prepared.RecordHash, ServiceBuildSHA: testBuildSHA,
	}}
	service := authorityService(t, store)
	path := "/v1/governance/plans/" + testsupport.PlanID + "/authority-events/1:pending"
	request := httptest.NewRequest(http.MethodGet, path, nil)
	setAuthorityBindingTestHeaders(request, "7")
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	want := `{"operation":"accept","planId":"` + testsupport.PlanID + `","recordHash":"` + prepared.RecordHash +
		`","revision":1,"route":{"authority":"governance-control","backend":"go","routingEpoch":7},` +
		`"schema":"openslack.governance_authority_pending_audit.v1","serviceBuildSha":"` + testBuildSHA +
		`","status":"pending","workspaceId":"` + testsupport.WorkspaceID + `"}` + "\n"
	if response.Code != http.StatusOK || response.Body.String() != want {
		t.Fatalf("pending audit point read = %d %s", response.Code, response.Body.String())
	}

	badBindings := []struct {
		name string
		path string
		edit func(*http.Request)
	}{
		{name: "workspace", path: path, edit: func(request *http.Request) { request.Header.Set(HeaderGovernanceWorkspaceID, "workspace.other") }},
		{name: "caller", path: path, edit: func(request *http.Request) { request.Header.Set(HeaderGovernanceCallerID, "typescript:other") }},
		{name: "build", path: path, edit: func(request *http.Request) {
			request.Header.Set(HeaderGovernanceExpectedBuild, strings.Repeat("f", 64))
		}},
		{name: "duplicate", path: path, edit: func(request *http.Request) { request.Header.Add(HeaderGovernanceCallerID, "typescript:qoder-mcp") }},
		{name: "query", path: path + "?scan=true", edit: func(*http.Request) {}},
		{name: "noncanonical revision", path: strings.Replace(path, "/1:pending", "/01:pending", 1), edit: func(*http.Request) {}},
	}
	for _, item := range badBindings {
		request = httptest.NewRequest(http.MethodGet, item.path, nil)
		setAuthorityBindingTestHeaders(request, "7")
		item.edit(request)
		response = httptest.NewRecorder()
		service.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s pending audit binding = %d %s", item.name, response.Code, response.Body.String())
		}
	}
	redirectPath := strings.Replace(path, "/authority-events/", "//authority-events/", 1)
	request = httptest.NewRequest(http.MethodGet, redirectPath, nil)
	setAuthorityBindingTestHeaders(request, "7")
	response = httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || response.Header().Get("Location") != "" {
		t.Fatalf("noncanonical pending audit path redirected = %d location=%q", response.Code, response.Header().Get("Location"))
	}

	drainService, err := New(Options{Store: &fakeStore{}, BuildSHA: testBuildSHA, AuthorityStore: store,
		AuthorityEnabled: true, AuthorityWorkspaceID: testsupport.WorkspaceID, AuthorityCallerID: "typescript:qoder-mcp",
		AuthorityRoutingEpoch: 7, AuthorityDrainEpochs: []int64{6}})
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodGet, path, nil)
	setAuthorityBindingTestHeaders(request, "6")
	response = httptest.NewRecorder()
	drainService.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("wrong pending audit epoch = %d %s", response.Code, response.Body.String())
	}

	store.pending = authoritystore.PendingAudit{}
	for name, missingPath := range map[string]string{"recorded": path, "absent": strings.Replace(path, "/1:pending", "/99:pending", 1)} {
		response = httptest.NewRecorder()
		request = httptest.NewRequest(http.MethodGet, missingPath, nil)
		setAuthorityBindingTestHeaders(request, "7")
		service.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s audit exposed as pending = %d %s", name, response.Code, response.Body.String())
		}
	}
}

func (store *fakeAuthorityStore) ReadReceipt(context.Context, string, string) (authoritystore.Receipt, error) {
	store.receiptReadCalls++
	return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorNotFound, "not found", nil)
}

func (store *fakeAuthorityStore) ReadPendingAudit(context.Context, string, string, int64) (authoritystore.PendingAudit, error) {
	store.pendingReadCalls++
	if store.pending.Schema != "" {
		return store.pending, nil
	}
	return authoritystore.PendingAudit{}, authoritystore.Failure(authoritystore.ErrorNotFound, "not found", nil)
}

func TestAuthorityGETRoutesRejectFixedLengthAndChunkedBodiesBeforeStoreAccess(t *testing.T) {
	prepared, input := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	store := &fakeAuthorityStore{readResult: authoritystore.ReadResult{
		Schema: authoritystore.ReadSchema, WorkspaceID: testsupport.WorkspaceID, PlanID: testsupport.PlanID,
		Route:      authoritystore.Route{Backend: authoritystore.Backend, Authority: authoritystore.Authority, RoutingEpoch: 7},
		RecordHash: prepared.RecordHash, RecordBytes: prepared.RecordBytes, ServiceBuildSHA: testBuildSHA,
	}, pending: authoritystore.PendingAudit{
		Schema: authoritystore.PendingAuditSchema, Status: "pending", Operation: authoritystore.OperationAccept,
		WorkspaceID: testsupport.WorkspaceID, PlanID: testsupport.PlanID, Revision: 1,
		Route:      authoritystore.Route{Backend: authoritystore.Backend, Authority: authoritystore.Authority, RoutingEpoch: 7},
		RecordHash: prepared.RecordHash, ServiceBuildSHA: testBuildSHA,
	}}
	service := authorityService(t, store)
	paths := map[string]string{
		"authority read": "/v1/governance/plans/" + testsupport.PlanID,
		"receipt read":   "/v1/governance/receipts/" + input.IdempotencyKey,
		"pending read":   "/v1/governance/plans/" + testsupport.PlanID + "/authority-events/1:pending",
	}
	bodies := []struct {
		name string
		edit func(*http.Request)
	}{
		{name: "fixed-length", edit: func(*http.Request) {}},
		{name: "unknown-length", edit: func(request *http.Request) {
			request.ContentLength = -1
			request.TransferEncoding = nil
		}},
		{name: "chunked", edit: func(request *http.Request) {
			request.ContentLength = -1
			request.TransferEncoding = []string{"chunked"}
		}},
	}
	for routeName, routePath := range paths {
		for _, body := range bodies {
			t.Run(routeName+"/"+body.name, func(t *testing.T) {
				request := httptest.NewRequest(http.MethodGet, routePath, strings.NewReader("{}"))
				body.edit(request)
				setAuthorityBindingTestHeaders(request, "7")
				response := httptest.NewRecorder()
				service.Handler().ServeHTTP(response, request)
				want := "{\"code\":\"GOVERNANCE_AUTHORITY_UNPROCESSABLE\",\"message\":\"request body is not accepted\",\"schema\":\"openslack.governance_authority_error.v1\"}\n"
				if response.Code != http.StatusUnprocessableEntity || response.Body.String() != want {
					t.Fatalf("body rejection = %d %s", response.Code, response.Body.String())
				}
			})
		}
	}
	if store.readCalls != 0 || store.receiptReadCalls != 0 || store.pendingReadCalls != 0 {
		t.Fatalf("body reached store: read=%d receipt=%d pending=%d", store.readCalls, store.receiptReadCalls, store.pendingReadCalls)
	}
}

func (*fakeAuthorityStore) RecordAudit(context.Context, authoritystore.AuditInput) (authoritystore.AuditReceipt, error) {
	return authoritystore.AuditReceipt{}, nil
}

func (*fakeAuthorityStore) Statistics(context.Context) (authoritystore.Statistics, error) {
	return authoritystore.Statistics{}, nil
}

func authorityService(t *testing.T, authority *fakeAuthorityStore) *Service {
	t.Helper()
	service, err := New(Options{Store: &fakeStore{}, BuildSHA: testBuildSHA, AuthorityStore: authority,
		AuthorityEnabled: true, AuthorityWorkspaceID: testsupport.WorkspaceID,
		AuthorityCallerID: "typescript:qoder-mcp", AuthorityRoutingEpoch: 7, AuthorityAcceptNewRecords: true})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestAuthorityRoutesAreDisabledByDefault(t *testing.T) {
	service := testService(t, &fakeStore{})
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, RouteAuthorityAccept, nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestAuthorityAcceptRequiresExactHostBindingAndReturnsCanonicalMilliseconds(t *testing.T) {
	store := &fakeAuthorityStore{}
	service := authorityService(t, store)
	prepared, input := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	request := httptest.NewRequest(http.MethodPost, RouteAuthorityAccept, bytes.NewReader(prepared.ExactBody))
	setAuthorityTestHeaders(request, input.IdempotencyKey, "6")
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity || store.mutateCalls != 0 {
		t.Fatalf("drift status/calls = %d/%d", response.Code, store.mutateCalls)
	}

	request = httptest.NewRequest(http.MethodPost, RouteAuthorityAccept, bytes.NewReader(prepared.ExactBody))
	setAuthorityTestHeaders(request, input.IdempotencyKey, "7")
	response = httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated || store.mutateCalls != 1 ||
		!bytes.Contains(response.Body.Bytes(), []byte(`"committedAt":"2026-08-03T01:02:03.456Z"`)) {
		t.Fatalf("accepted = %d %s calls=%d", response.Code, response.Body.Bytes(), store.mutateCalls)
	}
}

func TestAuthorityMetricsExposeOnlyClosedOutcomeAndErrorLabels(t *testing.T) {
	store := &fakeAuthorityStore{}
	service := authorityService(t, store)
	prepared, input := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	request := httptest.NewRequest(http.MethodPost, RouteAuthorityAccept, bytes.NewReader(prepared.ExactBody))
	setAuthorityTestHeaders(request, input.IdempotencyKey, "7")
	service.Handler().ServeHTTP(httptest.NewRecorder(), request)

	store.mutateErr = authoritystore.Failure(authoritystore.ErrorDatabase, "database unavailable", nil)
	request = httptest.NewRequest(http.MethodPost, RouteAuthorityAccept, bytes.NewReader(prepared.ExactBody))
	setAuthorityTestHeaders(request, input.IdempotencyKey, "7")
	service.Handler().ServeHTTP(httptest.NewRecorder(), request)

	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, RouteMetrics, nil))
	for _, metric := range []string{
		`openslack_governance_authority_outcomes_total{outcome="accepted"} 1`,
		`openslack_governance_authority_outcomes_total{outcome="duplicate"} 0`,
		`openslack_governance_authority_outcomes_total{outcome="reconciliation_required"} 0`,
		`openslack_governance_authority_errors_total{code="conflict"} 0`,
		`openslack_governance_authority_errors_total{code="unavailable"} 1`,
		`openslack_governance_authority_errors_total{code="commit_unknown"} 0`,
		`openslack_governance_authority_errors_total{code="internal"} 0`,
	} {
		if !strings.Contains(response.Body.String(), metric) {
			t.Fatalf("metrics missing %q:\n%s", metric, response.Body.String())
		}
	}
}

func setAuthorityTestHeaders(request *http.Request, key, epoch string) {
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	setAuthorityBindingTestHeaders(request, epoch)
}

func setAuthorityBindingTestHeaders(request *http.Request, epoch string) {
	request.Header.Set(HeaderGovernanceCallerID, "typescript:qoder-mcp")
	request.Header.Set(HeaderGovernanceWorkspaceID, testsupport.WorkspaceID)
	request.Header.Set(HeaderGovernanceRoutingEpoch, epoch)
	request.Header.Set(HeaderGovernanceExpectedBuild, testBuildSHA)
}
