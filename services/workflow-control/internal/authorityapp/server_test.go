package authorityapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"

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
	mutate     func(context.Context, authoritystore.MutateInput) (authoritystore.Receipt, error)
	readOutbox func(context.Context, string, string, int64) (authoritystore.OutboxRecord, error)
	ready      func(context.Context) error
	statistics func(context.Context) (authoritystore.Statistics, error)
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

func (repository *fakeRepository) ReadOutbox(ctx context.Context, workspaceID, runID string, revision int64) (authoritystore.OutboxRecord, error) {
	if repository.readOutbox != nil {
		return repository.readOutbox(ctx, workspaceID, runID, revision)
	}
	return authoritystore.OutboxRecord{}, authoritystore.Failure(authoritystore.ErrorNotFound, "read outbox", nil)
}
func (repository *fakeRepository) Ready(ctx context.Context) error {
	if repository.ready != nil {
		return repository.ready(ctx)
	}
	return nil
}
func (repository *fakeRepository) Statistics(ctx context.Context) (authoritystore.Statistics, error) {
	if repository.statistics != nil {
		return repository.statistics(ctx)
	}
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

func TestQualificationCompositionRejectsCanaryRecordPolicy(t *testing.T) {
	digest := sha256.Sum256([]byte(testBearer))
	_, err := New(Options{
		Repository: &fakeRepository{}, QualificationMode: true, AcceptNewRecords: true,
		BuildSHA: testBuildSHA, BearerTokenSHA256: hex.EncodeToString(digest[:]),
		WorkspaceID: testWorkspace, CallerID: testCaller, RoutingEpoch: testRoutingEpoch,
	})
	if err == nil || !strings.Contains(err.Error(), "cannot retain new-record or drain policy") {
		t.Fatalf("qualification composition retained canary policy: %v", err)
	}
}

func TestCanaryDisablesNewAcceptWhileRetainingBoundedDrainEpoch(t *testing.T) {
	mutations := 0
	repository := &fakeRepository{mutate: func(_ context.Context, input authoritystore.MutateInput) (authoritystore.Receipt, error) {
		mutations++
		if input.Prepared.Envelope.Operation != authoritystore.OperationTransition || input.Prepared.Envelope.Route.RoutingEpoch != 8 {
			t.Fatalf("unexpected drain mutation: %#v", input.Prepared.Envelope)
		}
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorConflict, "test drain reached repository", nil)
	}}
	service := newCanaryService(t, repository, false, []int64{8})

	accept := acceptBody(t)
	disabled := perform(t, service.Handler(), http.MethodPost, RouteAccept, accept, qualificationHeaders(t, accept, true))
	if disabled.Code != http.StatusConflict || !strings.Contains(disabled.Body.String(), `"code":"WORKFLOW_CONTROL_AUTHORITY_ACCEPT_DISABLED"`) || mutations != 0 {
		t.Fatalf("disabled canary accept drifted: status=%d body=%s mutations=%d", disabled.Code, disabled.Body.String(), mutations)
	}

	drainBody := transitionBody(t, 8)
	drainPath := "/v1/workflow-control/runs/" + testRunID + ":transition"
	drain := perform(t, service.Handler(), http.MethodPost, drainPath, drainBody, authorityHeaders(t, drainBody, drainPath, 8))
	if drain.Code != http.StatusConflict || mutations != 1 {
		t.Fatalf("bounded drain epoch did not reach the authority store: status=%d body=%s mutations=%d", drain.Code, drain.Body.String(), mutations)
	}

	version := perform(t, service.Handler(), http.MethodGet, RouteVersion, nil, nil)
	if version.Code != http.StatusOK || !strings.Contains(version.Body.String(), `"mode":"new-record-canary-v1"`) ||
		!strings.Contains(version.Body.String(), `"authority":"workflow-control"`) ||
		!strings.Contains(version.Body.String(), `"routingActivated":true`) ||
		!strings.Contains(version.Body.String(), `"acceptNewRecords":false`) {
		t.Fatalf("canary version drifted: status=%d body=%s", version.Code, version.Body.String())
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

func TestOutboxReadResponseMatchesOpenAPI(t *testing.T) {
	route := authoritystore.Route{
		Backend: authoritystore.Backend, Authority: authoritystore.Authority,
		RoutingEpoch: testRoutingEpoch, AuthorityBuildHash: testBuildSHA,
	}
	record := authoritystore.RunRecord{
		Schema: authoritystore.RunRecordSchema, WorkspaceID: testWorkspace, RunID: testRunID,
		WorkflowID: "workflow.demo", WorkflowVersion: "v1", WorkflowSourceHash: testBuildSHA,
		ManifestHash: testBuildSHA, InputHash: testBuildSHA, Route: route,
		State: authoritycontract.RunCreated, Revision: 1,
	}
	recordBytes, err := canonicaljson.Encode(record)
	if err != nil {
		t.Fatal(err)
	}
	recordDigest := sha256.Sum256(append(recordBytes, '\n'))
	payload := authoritystore.OutboxPayload{
		Schema: authoritystore.OutboxSchema, EventID: "wca-event-contract", ReceiptID: "wca-receipt-contract",
		WorkspaceID: testWorkspace, RunID: testRunID,
		Expected: authoritystore.ExpectedBinding{Revision: 0, ResumeGeneration: 0},
		Record:   record, RecordHash: hex.EncodeToString(recordDigest[:]), CorrelationID: "correlation-contract",
	}
	payloadBytes, err := canonicaljson.Encode(payload)
	if err != nil {
		t.Fatal(err)
	}
	payloadBytes = append(payloadBytes, '\n')
	payloadDigest := sha256.Sum256(payloadBytes)
	payloadHash := hex.EncodeToString(payloadDigest[:])
	repository := &fakeRepository{
		mutate: func(context.Context, authoritystore.MutateInput) (authoritystore.Receipt, error) {
			t.Fatal("outbox read must not mutate")
			return authoritystore.Receipt{}, nil
		},
		readOutbox: func(_ context.Context, workspaceID, runID string, revision int64) (authoritystore.OutboxRecord, error) {
			if workspaceID != testWorkspace || runID != testRunID || revision != 1 {
				t.Fatalf("unexpected outbox identity: %s %s %d", workspaceID, runID, revision)
			}
			return authoritystore.OutboxRecord{
				Schema: authoritystore.OutboxSchema, OutboxID: "wca-outbox-contract",
				EventID: payload.EventID, WorkspaceID: workspaceID, RunID: runID, RunRevision: revision,
				EventType: authoritystore.OutboxEventType, Status: "pending",
				IdempotencyKey: authoritystore.OutboxKeyPrefix + payloadHash,
				PayloadHash:    payloadHash, PayloadBytes: payloadBytes, AttemptCount: 0,
				CreatedAt: time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC),
			}, nil
		},
	}
	service := newQualificationService(t, repository)
	path := "/v1/workflow-control/runs/" + testRunID + "/outbox/1:pending"
	headers := qualificationReadHeaders()
	response := perform(t, service.Handler(), http.MethodGet, path, nil, headers)
	if response.Code != http.StatusOK {
		t.Fatalf("outbox read status=%d body=%s", response.Code, response.Body.String())
	}

	_, filename, _, _ := runtime.Caller(0)
	document, err := openapi3.NewLoader().LoadFromFile(filepath.Join(filepath.Dir(filename), "..", "..", "docs", "api", "authority-openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var instance any
	if err := json.Unmarshal(response.Body.Bytes(), &instance); err != nil {
		t.Fatalf("decode outbox response: %v", err)
	}
	if err := document.Components.Schemas["OutboxRead"].Value.VisitJSON(instance); err != nil {
		t.Fatalf("outbox response failed OpenAPI validation: %v\n%s", err, response.Body.String())
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

func TestServiceMapsStoredIntegrityFailureTo500(t *testing.T) {
	repository := &fakeRepository{mutate: func(context.Context, authoritystore.MutateInput) (authoritystore.Receipt, error) {
		return authoritystore.Receipt{}, authoritystore.Failure(authoritystore.ErrorIntegrity, "stored receipt is corrupt", nil)
	}}
	service := newQualificationService(t, repository)
	body := acceptBody(t)
	response := perform(t, service.Handler(), http.MethodPost, RouteAccept, body, qualificationHeaders(t, body, true))
	if response.Code != http.StatusInternalServerError ||
		!strings.Contains(response.Body.String(), `"code":"WORKFLOW_CONTROL_AUTHORITY_INTEGRITY_ERROR"`) ||
		strings.Contains(response.Body.String(), string(authoritystore.ErrorDatabase)) {
		t.Fatalf("integrity mapping drifted: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestQualificationReadinessUsesLightweightProbe(t *testing.T) {
	readyCalls := 0
	repository := &fakeRepository{
		ready: func(context.Context) error {
			readyCalls++
			return nil
		},
		statistics: func(context.Context) (authoritystore.Statistics, error) {
			t.Fatal("readiness must not scan authority statistics")
			return authoritystore.Statistics{}, nil
		},
	}
	response := perform(t, newQualificationService(t, repository).Handler(), http.MethodGet, RouteReady, nil, nil)
	if response.Code != http.StatusOK || response.Body.String() != "{\"status\":\"ready\"}\n" || readyCalls != 1 {
		t.Fatalf("qualification readiness drifted: status=%d body=%s calls=%d", response.Code, response.Body.String(), readyCalls)
	}
}

func TestQualificationReadinessFailureIsNotReady(t *testing.T) {
	repository := &fakeRepository{ready: func(context.Context) error {
		return authoritystore.Failure(authoritystore.ErrorDatabase, "probe failed", nil)
	}}
	response := perform(t, newQualificationService(t, repository).Handler(), http.MethodGet, RouteReady, nil, nil)
	if response.Code != http.StatusServiceUnavailable || response.Body.String() != "{\"status\":\"not_ready\"}\n" {
		t.Fatalf("failed readiness drifted: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestAuthorityTimeoutBudgetsLeaveWriteSlack(t *testing.T) {
	if serverReadTimeout != 30*time.Second || serverWriteTimeout != 45*time.Second {
		t.Fatalf("authority server timeout constants drifted: read=%s write=%s", serverReadTimeout, serverWriteTimeout)
	}
	if serverWriteTimeout <= requestDeadline+10*time.Second {
		t.Fatalf("write timeout has no response slack after two verification windows: request=%s write=%s", requestDeadline, serverWriteTimeout)
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

func newCanaryService(t *testing.T, repository authoritystore.Repository, accept bool, drains []int64) *Service {
	t.Helper()
	digest := sha256.Sum256([]byte(testBearer))
	service, err := New(Options{
		Repository: repository, AuthorityEnabled: true, CanaryMode: true,
		AcceptNewRecords: accept, DrainEpochs: drains, BuildSHA: testBuildSHA,
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

func transitionBody(t *testing.T, epoch int64) []byte {
	t.Helper()
	created := authoritycontract.RunCreated
	route := authoritystore.Route{Backend: authoritystore.Backend, Authority: authoritystore.Authority, RoutingEpoch: epoch, AuthorityBuildHash: testBuildSHA}
	body, err := canonicaljson.Encode(authoritystore.RequestEnvelope{
		Schema: authoritystore.TransitionSchema, Operation: authoritystore.OperationTransition,
		WorkspaceID: testWorkspace, RunID: testRunID,
		Expected: authoritystore.ExpectedBinding{Revision: 1, State: &created, ResumeGeneration: 0}, Route: route,
		Record: authoritystore.RunRecord{
			Schema: authoritystore.RunRecordSchema, WorkspaceID: testWorkspace, RunID: testRunID,
			WorkflowID: "workflow.demo", WorkflowVersion: "v1", WorkflowSourceHash: testBuildSHA,
			ManifestHash: testBuildSHA, InputHash: testBuildSHA, Route: route,
			State: authoritycontract.RunRunning, Revision: 2,
		},
		CorrelationID: "correlation-gs9g-drain",
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

func authorityHeaders(t *testing.T, body []byte, path string, epoch int64) map[string]string {
	t.Helper()
	prepared, err := authoritystore.PrepareRequest(body, testCaller, testWorkspace, stringEpoch(epoch), testBuildSHA)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{
		"Authorization": "Bearer " + testBearer, "Content-Type": "application/json",
		"Idempotency-Key": authoritystore.ExpectedIdempotencyKey(body),
		HeaderFingerprint: authoritystore.RequestFingerprint(http.MethodPost, path, prepared),
		HeaderCallerID:    testCaller, HeaderWorkspaceID: testWorkspace,
		HeaderRoutingEpoch: stringEpoch(epoch), HeaderExpectedBuildSHA: testBuildSHA,
	}
}

func stringEpoch(epoch int64) string {
	return strconv.FormatInt(epoch, 10)
}

func qualificationReadHeaders() map[string]string {
	return map[string]string{
		"Authorization": "Bearer " + testBearer, HeaderCallerID: testCaller,
		HeaderWorkspaceID: testWorkspace, HeaderRoutingEpoch: "9",
		HeaderExpectedBuildSHA: testBuildSHA,
	}
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
