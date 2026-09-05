package runnerapp

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

type fakeV2Store struct {
	submit func(context.Context, runnerstore.V2SubmitInput) (runnerstore.V2JobReceipt, error)
}

func TestV2NewRecordCanaryVersionReportsActivatedRouting(t *testing.T) {
	runnerToken := sha256.Sum256([]byte(testToken))
	service := &Service{
		buildSHA: strings.Repeat("a", 64), schemaVersion: 8,
		v2Enabled: true, v2RuntimeDelivery: true, v2NewRecordCanary: true,
		workspaceID: "workspace.test", tokenHash: runnerToken,
		runAuthorityOrigin: "http://127.0.0.1:8082", runAuthorityCallerID: "workflow-runner-v2",
		runAuthorityBuildSHA: strings.Repeat("b", 64), runAuthorityTokenSHA256: strings.Repeat("c", 64),
	}
	request := httptest.NewRequest(http.MethodGet, RouteVersion, nil)
	response := httptest.NewRecorder()
	service.handleVersion(response, request)
	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"routingActivated":true`) ||
		!strings.Contains(response.Body.String(), `"productionRoutingActivated":true`) ||
		!strings.Contains(response.Body.String(), `"newRecordCanary":true`) {
		t.Fatalf("canary version did not report activated routing: %d %s", response.Code, response.Body.String())
	}
	binding := httptest.NewRecorder()
	service.handleBinding(binding, httptest.NewRequest(http.MethodGet, RouteBinding, nil))
	if binding.Code != http.StatusOK ||
		!strings.Contains(binding.Body.String(), `"schema":"openslack.workflow_runner_control_binding.v1"`) ||
		!strings.Contains(binding.Body.String(), `"runnerTokenSha256":"`+fmt.Sprintf("%x", runnerToken[:])+`"`) ||
		!strings.Contains(binding.Body.String(), `"authorityBuildSha":"`+strings.Repeat("b", 64)+`"`) {
		t.Fatalf("canary binding drifted: %d %s", binding.Code, binding.Body.String())
	}
	if _, err := New(Options{RunAuthorityOrigin: "http://127.0.0.1:8082"}); err == nil {
		t.Fatal("disabled runner retained a run-authority binding")
	}
}

func (store fakeV2Store) SubmitV2(ctx context.Context, input runnerstore.V2SubmitInput) (runnerstore.V2JobReceipt, error) {
	return store.submit(ctx, input)
}

func TestV2TypeScriptQualificationAdmissionIsRetiredWithoutStoreMutation(t *testing.T) {
	base := &fakeStore{
		submit: func(context.Context, runnerstore.SubmitInput) (runnerstore.JobReceipt, error) {
			return runnerstore.JobReceipt{}, nil
		},
		read: func(context.Context, string, string) (runnerstore.JobView, error) { return runnerstore.JobView{}, nil },
		cancel: func(context.Context, runnerstore.CancelInput) (runnerstore.CancelControl, error) {
			return runnerstore.CancelControl{}, nil
		},
	}
	digest := sha256.Sum256([]byte(testToken))
	spec := runnerstore.V2JobSpec{
		Schema: runnerstore.V2JobSpecSchema, WorkspaceID: "workspace.test", JobID: "job.v2", WorkflowRunID: "run.v2",
		CorrelationID: "correlation.v2", ExecutionDescriptorRef: "descriptor.v2", ExecutionDescriptorHash: strings.Repeat("1", 64),
		WorkflowID: "workflow.v2", WorkflowVersion: "1.0.0", WorkflowSourceHash: strings.Repeat("2", 64),
		ManifestHash: strings.Repeat("3", 64), InputHash: strings.Repeat("4", 64), WholeTimeoutMS: 60_000,
		SubmittedAt: "2026-08-15T00:00:00.000Z", RequiredProtocolVersion: authoritycontract.ProtocolVersion,
		RequiredCapabilities: runnerstore.V2RequiredCapabilities(), AuthorityRoute: authoritycontract.Route{
			Backend: "ts-local", Authority: "typescript", RoutingEpoch: 1, AuthorityBuildHash: strings.Repeat("5", 64),
		}, RunRevision: 1,
	}
	prepared, err := runnerstore.PrepareV2JobSpec(spec)
	if err != nil {
		t.Fatal(err)
	}
	key, fingerprint := runnerstore.V2SubmissionBindings(prepared)
	calls := 0
	service, err := New(Options{Store: base, V2Store: fakeV2Store{submit: func(_ context.Context, input runnerstore.V2SubmitInput) (runnerstore.V2JobReceipt, error) {
		calls++
		receipt := runnerstore.V2JobReceipt{Schema: runnerstore.V2JobReceiptSchema, Status: runnerstore.ReceiptAccepted,
			WorkspaceID: spec.WorkspaceID, JobID: spec.JobID, WorkflowRunID: spec.WorkflowRunID, State: runnerstore.JobQueued,
			Revision: 1, JobSpecHash: prepared.JobSpecHash, IdempotencyKey: input.IdempotencyKey,
			RequestFingerprint: input.RequestFingerprint, CommittedAt: "2026-08-15T00:00:01.000Z", Replay: calls > 1}
		receipt.ExactBytes, _ = v2JobReceiptBytes(receipt)
		return receipt, nil
	}}, V2Qualification: true, SchemaVersion: 7, BuildSHA: strings.Repeat("a", 64), WorkspaceID: spec.WorkspaceID, BearerTokenSHA256: fmt.Sprintf("%x", digest[:])})
	if err != nil {
		t.Fatal(err)
	}
	request := func(body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, RouteV2Jobs, strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+testToken)
		req.Header.Set(HeaderWorkspaceID, spec.WorkspaceID)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set(HeaderRequestFingerprint, fingerprint)
		response := httptest.NewRecorder()
		service.Handler().ServeHTTP(response, req)
		return response
	}
	first, replay := request(prepared.ExactBody), request(prepared.ExactBody)
	if first.Code != http.StatusGone || replay.Code != http.StatusGone ||
		!strings.Contains(first.Body.String(), "WORKFLOW_RUNNER_TS_MUTATION_RETIRED") {
		t.Fatalf("retired v2 TypeScript admission drifted: first=%d/%q replay=%d/%q", first.Code, first.Body.String(), replay.Code, replay.Body.String())
	}
	if calls != 0 || service.accepted.Load() != 0 || service.duplicates.Load() != 0 {
		t.Fatalf("retired v2 TypeScript admission mutated state: calls=%d accepted=%d duplicate=%d", calls, service.accepted.Load(), service.duplicates.Load())
	}
}

const testToken = "0123456789abcdef0123456789abcdef"

type fakeStore struct {
	submit func(context.Context, runnerstore.SubmitInput) (runnerstore.JobReceipt, error)
	read   func(context.Context, string, string) (runnerstore.JobView, error)
	cancel func(context.Context, runnerstore.CancelInput) (runnerstore.CancelControl, error)
}

func (store *fakeStore) Submit(ctx context.Context, input runnerstore.SubmitInput) (runnerstore.JobReceipt, error) {
	return store.submit(ctx, input)
}
func (*fakeStore) ClaimNext(context.Context, runnerstore.ClaimInput) (runnerstore.AttemptLease, error) {
	return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorNoWork, "none", nil)
}
func (*fakeStore) RecordNegotiation(context.Context, runnerstore.NegotiationInput) (runnerstore.Negotiation, error) {
	return runnerstore.Negotiation{}, nil
}
func (*fakeStore) RecordEvent(context.Context, runnerstore.RecordEventInput) (runnerstore.RecordedEvent, error) {
	return runnerstore.RecordedEvent{}, nil
}
func (store *fakeStore) RequestCancel(ctx context.Context, input runnerstore.CancelInput) (runnerstore.CancelControl, error) {
	return store.cancel(ctx, input)
}
func (*fakeStore) PendingCancel(context.Context, string, string, string) (*runnerstore.CancelControl, error) {
	return nil, nil
}
func (*fakeStore) MarkControlDelivered(context.Context, string, string, string, time.Time) error {
	return nil
}
func (*fakeStore) RecordProcessExit(context.Context, runnerstore.ProcessExitInput) (runnerstore.JobView, error) {
	return runnerstore.JobView{}, nil
}
func (*fakeStore) RecoverExpired(context.Context, runnerstore.RecoverExpiredInput) ([]runnerstore.RecoveryResult, error) {
	return nil, nil
}
func (*fakeStore) RecoverOrphans(context.Context, string, time.Time, int) ([]runnerstore.RecoveryResult, error) {
	return nil, nil
}
func (store *fakeStore) ReadJob(ctx context.Context, workspaceID, jobID string) (runnerstore.JobView, error) {
	return store.read(ctx, workspaceID, jobID)
}
func (*fakeStore) Statistics(context.Context) (runnerstore.Statistics, error) {
	return runnerstore.Statistics{QueuedJobs: 1}, nil
}

func newTestService(t *testing.T, store *fakeStore) *Service {
	t.Helper()
	digest := sha256.Sum256([]byte(testToken))
	service, err := New(Options{
		Store: store, BuildSHA: strings.Repeat("a", 64), WorkspaceID: "workspace.test",
		BearerTokenSHA256: fmt.Sprintf("%x", digest[:]),
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func testPreparedJob(t *testing.T) runnerstore.PreparedJobSpec {
	t.Helper()
	prepared, err := runnerstore.PrepareJobSpec(runnerstore.JobSpec{
		Schema: runnerstore.JobSpecSchema, WorkspaceID: "workspace.test", JobID: "job.test",
		WorkflowRunID: "run.test", CorrelationID: "correlation.test",
		ExecutionDescriptorRef: "descriptor.test", ExecutionDescriptorHash: strings.Repeat("b", 64),
		WorkflowID: "workflow.test", WorkflowVersion: "1.0.0",
		WorkflowSourceHash: strings.Repeat("c", 64), ManifestHash: strings.Repeat("d", 64),
		InputHash: strings.Repeat("e", 64), WholeTimeoutMS: 60_000,
		SubmittedAt: "2026-08-04T01:02:03.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	return prepared
}

func authorized(request *http.Request) {
	request.Header.Set("Authorization", "Bearer "+testToken)
	request.Header.Set(HeaderWorkspaceID, "workspace.test")
}

func TestV1SubmitRequiresIdentityThenFailsClosedWithoutStoreMutation(t *testing.T) {
	prepared := testPreparedJob(t)
	key, fingerprint := runnerstore.SubmissionBindings(prepared)
	submitCalled := false
	store := &fakeStore{}
	store.submit = func(_ context.Context, input runnerstore.SubmitInput) (runnerstore.JobReceipt, error) {
		submitCalled = true
		receipt := runnerstore.JobReceipt{
			Schema: runnerstore.JobReceiptSchema, Status: runnerstore.ReceiptAccepted,
			WorkspaceID: prepared.Spec.WorkspaceID, JobID: prepared.Spec.JobID,
			WorkflowRunID: prepared.Spec.WorkflowRunID, State: runnerstore.JobQueued,
			Revision: 1, JobSpecHash: prepared.JobSpecHash,
			IdempotencyKey: input.IdempotencyKey, RequestFingerprint: input.RequestFingerprint,
			CommittedAt: "2026-08-04T01:02:04.000Z",
		}
		receipt.ExactBytes, _ = jobReceiptBytes(receipt)
		return receipt, nil
	}
	store.read = func(context.Context, string, string) (runnerstore.JobView, error) { return runnerstore.JobView{}, nil }
	store.cancel = func(context.Context, runnerstore.CancelInput) (runnerstore.CancelControl, error) {
		return runnerstore.CancelControl{}, nil
	}
	service := newTestService(t, store)

	request := httptest.NewRequest(http.MethodPost, RouteJobs, strings.NewReader(string(prepared.ExactBody)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	request.Header.Set(HeaderRequestFingerprint, fingerprint)
	recorder := httptest.NewRecorder()
	service.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("without identity status=%d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodPost, RouteJobs, strings.NewReader(string(prepared.ExactBody)))
	authorized(request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	request.Header.Set(HeaderRequestFingerprint, fingerprint)
	recorder = httptest.NewRecorder()
	service.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusGone || !strings.Contains(recorder.Body.String(), "WORKFLOW_RUNNER_TS_MUTATION_RETIRED") {
		t.Fatalf("retired admission status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if submitCalled {
		t.Fatal("retired v1 HTTP admission reached the legacy store")
	}

	// Preserve the closed legacy parser/store contract as recovery evidence;
	// it is no longer composed into the authenticated HTTP surface.
	request = httptest.NewRequest(http.MethodPost, RouteJobs, strings.NewReader(string(prepared.ExactBody)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	request.Header.Set(HeaderRequestFingerprint, fingerprint)
	recorder = httptest.NewRecorder()
	service.handleSubmit(recorder, request)
	if recorder.Code != http.StatusCreated || !submitCalled {
		t.Fatalf("closed legacy contract status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSubmitRejectsForbiddenLaunchAndGS9AuthorityFields(t *testing.T) {
	prepared := testPreparedJob(t)
	store := &fakeStore{
		submit: func(context.Context, runnerstore.SubmitInput) (runnerstore.JobReceipt, error) {
			t.Fatal("store must not be called")
			return runnerstore.JobReceipt{}, nil
		},
		read: func(context.Context, string, string) (runnerstore.JobView, error) { return runnerstore.JobView{}, nil },
		cancel: func(context.Context, runnerstore.CancelInput) (runnerstore.CancelControl, error) {
			return runnerstore.CancelControl{}, nil
		},
	}
	service := newTestService(t, store)
	for _, field := range []string{"command", "path", "args", "url", "prompt", "credential", "approval", "budget", "checkpoint", "resume"} {
		t.Run(field, func(t *testing.T) {
			body := strings.TrimSuffix(string(prepared.ExactBody), "}") + `,"` + field + `":"forbidden"}`
			request := httptest.NewRequest(http.MethodPost, RouteJobs, strings.NewReader(body))
			authorized(request)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Idempotency-Key", "invalid")
			request.Header.Set(HeaderRequestFingerprint, "invalid")
			recorder := httptest.NewRecorder()
			service.handleSubmit(recorder, request)
			if recorder.Code != http.StatusUnprocessableEntity {
				t.Fatalf("field %s status=%d", field, recorder.Code)
			}
		})
	}
}

func TestReadJobIsBoundToConfiguredWorkspace(t *testing.T) {
	store := &fakeStore{
		submit: func(context.Context, runnerstore.SubmitInput) (runnerstore.JobReceipt, error) {
			return runnerstore.JobReceipt{}, nil
		},
		cancel: func(context.Context, runnerstore.CancelInput) (runnerstore.CancelControl, error) {
			return runnerstore.CancelControl{}, nil
		},
		read: func(_ context.Context, workspaceID, jobID string) (runnerstore.JobView, error) {
			return runnerstore.JobView{Schema: runnerstore.JobViewSchema, WorkspaceID: workspaceID, JobID: jobID}, nil
		},
	}
	service := newTestService(t, store)
	request := httptest.NewRequest(http.MethodGet, "/v1/runner/jobs/job.test", nil)
	authorized(request)
	recorder := httptest.NewRecorder()
	service.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"workspaceId":"workspace.test"`) {
		t.Fatalf("read status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestCancellationReplayReturnsExactOriginalResponse(t *testing.T) {
	requestedAt := time.Date(2026, 8, 4, 1, 2, 3, 0, time.UTC)
	expiresAt := requestedAt.Add(30 * time.Second)
	input := runnerstore.CancelInput{
		WorkspaceID: "workspace.test", JobID: "job.test", CorrelationID: "correlation.test",
		ExpectedAttemptID: "attempt.test", ExpectedLeaseID: "lease.test", ExpectedFence: 7,
		Reason: "operator", Now: requestedAt, ExpiresAt: expiresAt,
	}
	key, fingerprint, err := runnerstore.CancelBindings(input)
	if err != nil {
		t.Fatal(err)
	}
	body, err := canonicaljson.Encode(cancellationRequest{
		Schema: cancellationSchema, CorrelationID: input.CorrelationID,
		ExpectedAttemptID: input.ExpectedAttemptID, ExpectedLeaseID: input.ExpectedLeaseID,
		ExpectedFence: input.ExpectedFence, Reason: input.Reason,
		RequestedAt: runnerstore.CanonicalTimestamp(requestedAt),
		ExpiresAt:   runnerstore.CanonicalTimestamp(expiresAt),
	})
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	store := &fakeStore{
		submit: func(context.Context, runnerstore.SubmitInput) (runnerstore.JobReceipt, error) {
			return runnerstore.JobReceipt{}, nil
		},
		read: func(context.Context, string, string) (runnerstore.JobView, error) { return runnerstore.JobView{}, nil },
		cancel: func(_ context.Context, received runnerstore.CancelInput) (runnerstore.CancelControl, error) {
			calls++
			return runnerstore.CancelControl{
				WorkspaceID: received.WorkspaceID, JobID: received.JobID, WorkflowRunID: "run.test",
				AttemptID: received.ExpectedAttemptID, LeaseID: received.ExpectedLeaseID,
				FencingToken: received.ExpectedFence, CancelID: "cancel.stable", Reason: received.Reason,
				RequestedAt: received.Now, ExpiresAt: received.ExpiresAt, ControlSequence: 8,
				Duplicate: calls > 1,
			}, nil
		},
	}
	service := newTestService(t, store)
	invoke := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/v1/runner/jobs/job.test/cancellations", strings.NewReader(string(body)))
		authorized(request)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", key)
		request.Header.Set(HeaderRequestFingerprint, fingerprint)
		recorder := httptest.NewRecorder()
		service.Handler().ServeHTTP(recorder, request)
		return recorder
	}
	first, second := invoke(), invoke()
	if first.Code != http.StatusAccepted || second.Code != first.Code || second.Body.String() != first.Body.String() {
		t.Fatalf("replay changed response: first=%d %q second=%d %q", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
}
