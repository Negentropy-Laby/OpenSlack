package authorityapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

const (
	testBuildSHA           = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testWorkspace          = "workspace.demo"
	testCaller             = "typescript:workflow-control-qualification"
	testBearer             = "openslack-workflow-authority-gs9b-local-qualification"
	testRunID              = "run-gs9b-authority"
	testRoutingEpoch int64 = 9
)

type fakeRepository struct {
	mutate func(context.Context, authoritystore.MutateInput) (authoritystore.Receipt, error)
}

func (repository *fakeRepository) Mutate(ctx context.Context, input authoritystore.MutateInput) (authoritystore.Receipt, error) {
	return repository.mutate(ctx, input)
}
func (*fakeRepository) Read(context.Context, string, string) (authoritystore.RunHead, error) {
	return authoritystore.RunHead{}, authoritystore.Failure(authoritystore.ErrorNotFound, "read", nil)
}
func (*fakeRepository) ReadReceipt(context.Context, string, string) (authoritystore.Receipt, error) {
	return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorNotFound, "read receipt", nil)
}
func (*fakeRepository) ReadOutbox(context.Context, string, string, int64) (authoritystore.OutboxRecord, error) {
	return authoritystore.OutboxRecord{}, authoritystore.Failure(authoritystore.ErrorNotFound, "read outbox", nil)
}
func (*fakeRepository) Statistics(context.Context) (authoritystore.Statistics, error) {
	return authoritystore.Statistics{}, nil
}

func TestServiceDefaultsToHealthOnly(t *testing.T) {
	service, err := New(Options{BuildSHA: strings.Repeat("0", 64)})
	if err != nil {
		t.Fatal(err)
	}
	ready := perform(t, service.Handler(), http.MethodGet, RouteReady, nil, nil)
	if ready.Code != http.StatusOK || ready.Body.String() != "{\"status\":\"ready\"}\n" {
		t.Fatalf("default readiness contract drifted: %d %s", ready.Code, ready.Body.String())
	}
	version := perform(t, service.Handler(), http.MethodGet, RouteVersion, nil, nil)
	if version.Code != http.StatusOK || !strings.Contains(version.Body.String(), `"authority":"typescript"`) ||
		!strings.Contains(version.Body.String(), `"routingActivated":false`) ||
		!strings.Contains(version.Body.String(), `"acceptNewRecords":false`) ||
		!strings.Contains(version.Body.String(), `"qualificationMode":false`) {
		t.Fatalf("default version drifted: %d %s", version.Code, version.Body.String())
	}
	mutation := perform(t, service.Handler(), http.MethodPost, RouteAccept, []byte("{}\n"), nil)
	if mutation.Code != http.StatusNotFound {
		t.Fatalf("default service exposed a mutation route: %d %s", mutation.Code, mutation.Body.String())
	}
}

func TestServicePinsBearerAndAllQualificationBindings(t *testing.T) {
	service := newQualificationService(t, &fakeRepository{mutate: func(context.Context, authoritystore.MutateInput) (authoritystore.Receipt, error) {
		t.Fatal("repository must not be called for invalid identity")
		return authoritystore.Receipt{}, nil
	}})
	body := acceptBody(t)
	withoutBearer := perform(t, service.Handler(), http.MethodPost, RouteAccept, body, qualificationHeaders(t, body, false))
	if withoutBearer.Code != http.StatusUnauthorized {
		t.Fatalf("missing bearer status=%d body=%s", withoutBearer.Code, withoutBearer.Body.String())
	}
	headers := qualificationHeaders(t, body, true)
	headers[HeaderCallerID] = "different-caller"
	wrongCaller := perform(t, service.Handler(), http.MethodPost, RouteAccept, body, headers)
	if wrongCaller.Code != http.StatusUnprocessableEntity {
		t.Fatalf("caller drift status=%d body=%s", wrongCaller.Code, wrongCaller.Body.String())
	}
}

func TestServiceReturnsExactOriginalReceiptOnReplay(t *testing.T) {
	callCount := 0
	repository := &fakeRepository{}
	repository.mutate = func(_ context.Context, input authoritystore.MutateInput) (authoritystore.Receipt, error) {
		callCount++
		acceptedRevision := int64(1)
		committedAt := "2026-08-04T00:00:00.000Z"
		recordHash := input.Prepared.RecordHash
		value := authoritycontract.Receipt{
			Schema: authoritycontract.ReceiptSchema, Operation: authoritycontract.ReceiptRunTransition,
			Status: authoritycontract.ReceiptAccepted, WorkspaceID: testWorkspace, RunID: testRunID,
			ExpectedRevision: 0, AcceptedRevision: &acceptedRevision, ResumeGeneration: 0,
			Route: input.Prepared.Envelope.Route, IdempotencyKey: input.IdempotencyKey,
			RequestFingerprint: input.RequestFingerprint, RequestHash: input.Prepared.RequestHash,
			RecordHash: &recordHash, CorrelationID: input.Prepared.Envelope.CorrelationID,
			ServiceBuildHash: input.ServiceBuildHash, CommittedAt: &committedAt,
		}
		exact, err := authoritycontract.CanonicalJSON(value)
		if err != nil {
			t.Fatal(err)
		}
		return authoritystore.Receipt{Value: value, ExactBytes: append(exact, '\n'), Replay: callCount > 1}, nil
	}
	service := newQualificationService(t, repository)
	body := acceptBody(t)
	headers := qualificationHeaders(t, body, true)
	first := perform(t, service.Handler(), http.MethodPost, RouteAccept, body, headers)
	replay := perform(t, service.Handler(), http.MethodPost, RouteAccept, body, headers)
	if first.Code != http.StatusCreated || replay.Code != http.StatusOK || first.Body.String() != replay.Body.String() || replay.Header().Get(HeaderReplay) != "true" {
		t.Fatalf("exact replay drifted: first=%d %q replay=%d %q header=%q", first.Code, first.Body.String(), replay.Code, replay.Body.String(), replay.Header().Get(HeaderReplay))
	}
	if strings.Contains(replay.Body.String(), `"status":"duplicate"`) {
		t.Fatal("replay mutated the original accepted receipt")
	}
}

func TestServiceMapsCommitUnknownToStableNon2xx(t *testing.T) {
	repository := &fakeRepository{mutate: func(context.Context, authoritystore.MutateInput) (authoritystore.Receipt, error) {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorCommitUnknown, "qualification commit outcome is unknown", nil)
	}}
	service := newQualificationService(t, repository)
	body := acceptBody(t)
	headers := qualificationHeaders(t, body, true)
	first := perform(t, service.Handler(), http.MethodPost, RouteAccept, body, headers)
	second := perform(t, service.Handler(), http.MethodPost, RouteAccept, body, headers)
	if first.Code != http.StatusInternalServerError || second.Code != http.StatusInternalServerError ||
		first.Body.String() != second.Body.String() || !strings.Contains(first.Body.String(), `"code":"WORKFLOW_CONTROL_AUTHORITY_COMMIT_OUTCOME_UNKNOWN"`) {
		t.Fatalf("commit-unknown mapping drifted: first=%d %s second=%d %s", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
}

func newQualificationService(t *testing.T, repository authoritystore.Repository) *Service {
	t.Helper()
	digest := sha256.Sum256([]byte(testBearer))
	service, err := New(Options{
		Repository: repository, QualificationMode: true, BuildSHA: testBuildSHA,
		BearerTokenSHA256: hex.EncodeToString(digest[:]), WorkspaceID: testWorkspace,
		CallerID: testCaller, RoutingEpoch: testRoutingEpoch,
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func acceptBody(t *testing.T) []byte {
	t.Helper()
	route := authoritystore.Route{Backend: authoritystore.Backend, Authority: authoritystore.Authority, RoutingEpoch: testRoutingEpoch, AuthorityBuildHash: testBuildSHA}
	body, err := canonicaljson.Encode(authoritystore.RequestEnvelope{
		Schema: authoritystore.AcceptSchema, Operation: authoritystore.OperationAccept,
		WorkspaceID: testWorkspace, RunID: testRunID,
		Expected: authoritystore.ExpectedBinding{Revision: 0, ResumeGeneration: 0}, Route: route,
		Record: authoritystore.RunRecord{
			Schema: authoritystore.RunRecordSchema, WorkspaceID: testWorkspace, RunID: testRunID,
			WorkflowID: "workflow.demo", WorkflowVersion: "v1", WorkflowSourceHash: testBuildSHA,
			ManifestHash: testBuildSHA, InputHash: testBuildSHA, Route: route,
			State: authoritycontract.RunCreated, Revision: 1,
		},
		CorrelationID: "correlation-gs9b",
	})
	if err != nil {
		t.Fatal(err)
	}
	return append(body, '\n')
}

func qualificationHeaders(t *testing.T, body []byte, bearer bool) map[string]string {
	t.Helper()
	prepared, err := authoritystore.PrepareRequest(body, testCaller, testWorkspace, "9", testBuildSHA)
	if err != nil {
		t.Fatal(err)
	}
	headers := map[string]string{
		"Content-Type": "application/json", "Idempotency-Key": authoritystore.ExpectedIdempotencyKey(body),
		HeaderFingerprint: authoritystore.RequestFingerprint(http.MethodPost, RouteAccept, prepared),
		HeaderCallerID:    testCaller, HeaderWorkspaceID: testWorkspace,
		HeaderRoutingEpoch: "9", HeaderExpectedBuildSHA: testBuildSHA,
	}
	if bearer {
		headers["Authorization"] = "Bearer " + testBearer
	}
	return headers
}

func perform(t *testing.T, handler http.Handler, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
