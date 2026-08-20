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

func (store fakeV2Store) SubmitV2(ctx context.Context, input runnerstore.V2SubmitInput) (runnerstore.V2JobReceipt, error) {
	return store.submit(ctx, input)
}

func TestV2QualificationAdmissionReplaysAcceptedReceiptWithoutActivatingGoRoute(t *testing.T) {
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
	if first.Code != http.StatusCreated || replay.Code != http.StatusOK || replay.Header().Get(HeaderIdempotencyReplayed) != "true" || first.Body.String() != replay.Body.String() || !strings.Contains(first.Body.String(), `"status":"accepted"`) {
		t.Fatalf("v2 replay drifted: first=%d/%q replay=%d/%q/%q", first.Code, first.Body.String(), replay.Code, replay.Header().Get(HeaderIdempotencyReplayed), replay.Body.String())
	}
	if service.accepted.Load() != 1 || service.duplicates.Load() != 1 {
		t.Fatalf("v2 admission metrics drifted: accepted=%d duplicate=%d", service.accepted.Load(), service.duplicates.Load())
	}
	goSpec := spec
	goSpec.AuthorityRoute.Backend, goSpec.AuthorityRoute.Authority = "go", "workflow-control"
	goPrepared, _ := runnerstore.PrepareV2JobSpec(goSpec)
	goRequest := httptest.NewRequest(http.MethodPost, RouteV2Jobs, strings.NewReader(string(goPrepared.ExactBody)))
	goRequest.Header.Set("Content-Type", "application/json")
	goRequest.Header.Set("Authorization", "Bearer "+testToken)
	goRequest.Header.Set(HeaderWorkspaceID, spec.WorkspaceID)
	goKey, goFingerprint := runnerstore.V2SubmissionBindings(goPrepared)
	goRequest.Header.Set("Idempotency-Key", goKey)
	goRequest.Header.Set(HeaderRequestFingerprint, goFingerprint)
	goResponse := httptest.NewRecorder()
	service.Handler().ServeHTTP(goResponse, goRequest)
	if goResponse.Code != http.StatusUnprocessableEntity || calls != 2 {
		t.Fatalf("Go route reached v2 store: status=%d calls=%d", goResponse.Code, calls)
	}

	mutations := map[string]func(*runnerstore.V2JobReceipt){
		"workspace":    func(value *runnerstore.V2JobReceipt) { value.WorkspaceID = "workspace.splice" },
		"workflow run": func(value *runnerstore.V2JobReceipt) { value.WorkflowRunID = "run.splice" },
		"idempotency key": func(value *runnerstore.V2JobReceipt) {
			value.IdempotencyKey = runnerstore.V2JobKeyPrefix + strings.Repeat("f", 64)
		},
		"fingerprint": func(value *runnerstore.V2JobReceipt) { value.RequestFingerprint = "sha256:" + strings.Repeat("f", 64) },
		"status state": func(value *runnerstore.V2JobReceipt) {
			value.Status = runnerstore.ReceiptReconciliationRequired
		},
		"revision": func(value *runnerstore.V2JobReceipt) { value.Revision = 2 },
	}
	for name, mutate := range mutations {
		t.Run("rejects cross-spliced "+name, func(t *testing.T) {
			badService, serviceErr := New(Options{Store: base, V2Store: fakeV2Store{submit: func(_ context.Context, input runnerstore.V2SubmitInput) (runnerstore.V2JobReceipt, error) {
				receipt := runnerstore.V2JobReceipt{Schema: runnerstore.V2JobReceiptSchema, Status: runnerstore.ReceiptAccepted,
					WorkspaceID: spec.WorkspaceID, JobID: spec.JobID, WorkflowRunID: spec.WorkflowRunID, State: runnerstore.JobQueued,
					Revision: 1, JobSpecHash: prepared.JobSpecHash, IdempotencyKey: input.IdempotencyKey,
					RequestFingerprint: input.RequestFingerprint, CommittedAt: "2026-08-15T00:00:01.000Z"}
				mutate(&receipt)
				receipt.ExactBytes, _ = v2JobReceiptBytes(receipt)
				return receipt, nil
			}}, V2Qualification: true, SchemaVersion: 7, BuildSHA: strings.Repeat("a", 64), WorkspaceID: spec.WorkspaceID, BearerTokenSHA256: fmt.Sprintf("%x", digest[:])})
			if serviceErr != nil {
				t.Fatal(serviceErr)
			}
			req := httptest.NewRequest(http.MethodPost, RouteV2Jobs, strings.NewReader(string(prepared.ExactBody)))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+testToken)
			req.Header.Set(HeaderWorkspaceID, spec.WorkspaceID)
			req.Header.Set("Idempotency-Key", key)
			req.Header.Set(HeaderRequestFingerprint, fingerprint)
			response := httptest.NewRecorder()
			badService.Handler().ServeHTTP(response, req)
			if response.Code != http.StatusInternalServerError {
				t.Fatalf("cross-spliced receipt escaped validation: %d %s", response.Code, response.Body.String())
			}
		})
	}

	reconciliationID := "reconciliation.v2"
	reconciliationCalls := 0
	reconciliationService, err := New(Options{Store: base, V2Store: fakeV2Store{submit: func(_ context.Context, input runnerstore.V2SubmitInput) (runnerstore.V2JobReceipt, error) {
		reconciliationCalls++
		receipt := runnerstore.V2JobReceipt{Schema: runnerstore.V2JobReceiptSchema, Status: runnerstore.ReceiptReconciliationRequired,
			WorkspaceID: spec.WorkspaceID, JobID: spec.JobID, WorkflowRunID: spec.WorkflowRunID, State: runnerstore.JobReconciliationRequired,
			Revision: 1, JobSpecHash: prepared.JobSpecHash, IdempotencyKey: input.IdempotencyKey,
			RequestFingerprint: input.RequestFingerprint, CommittedAt: "2026-08-15T00:00:01.000Z", ReconciliationID: &reconciliationID,
			Replay: reconciliationCalls > 1}
		receipt.ExactBytes, _ = v2JobReceiptBytes(receipt)
		return receipt, nil
	}}, V2Qualification: true, SchemaVersion: 7, BuildSHA: strings.Repeat("a", 64), WorkspaceID: spec.WorkspaceID, BearerTokenSHA256: fmt.Sprintf("%x", digest[:])})
	if err != nil {
		t.Fatal(err)
	}
	reconciliationRequest := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, RouteV2Jobs, strings.NewReader(string(prepared.ExactBody)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+testToken)
		req.Header.Set(HeaderWorkspaceID, spec.WorkspaceID)
		req.Header.Set("Idempotency-Key", key)
		req.Header.Set(HeaderRequestFingerprint, fingerprint)
		response := httptest.NewRecorder()
		reconciliationService.Handler().ServeHTTP(response, req)
		return response
	}
	reconciliation, reconciliationReplay := reconciliationRequest(), reconciliationRequest()
	if reconciliation.Code != http.StatusAccepted || reconciliationReplay.Code != http.StatusOK ||
		reconciliationReplay.Header().Get(HeaderIdempotencyReplayed) != "true" || reconciliation.Body.String() != reconciliationReplay.Body.String() {
		t.Fatalf("v2 reconciliation response drifted: first=%d replay=%d/%q", reconciliation.Code, reconciliationReplay.Code, reconciliationReplay.Header().Get(HeaderIdempotencyReplayed))
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

func TestSubmitRequiresBearerWorkspaceAndExactBindings(t *testing.T) {
	prepared := testPreparedJob(t)
	key, fingerprint := runnerstore.SubmissionBindings(prepared)
	store := &fakeStore{}
	store.submit = func(_ context.Context, input runnerstore.SubmitInput) (runnerstore.JobReceipt, error) {
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
	if recorder.Code != http.StatusCreated || recorder.Body.String() == "" {
		t.Fatalf("valid admission status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	request = httptest.NewRequest(http.MethodPost, RouteJobs, strings.NewReader(string(prepared.ExactBody)))
	authorized(request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	request.Header.Set(HeaderRequestFingerprint, "sha256:"+strings.Repeat("0", 64))
	recorder = httptest.NewRecorder()
	service.Handler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("mismatched fingerprint status=%d", recorder.Code)
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
			service.Handler().ServeHTTP(recorder, request)
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
