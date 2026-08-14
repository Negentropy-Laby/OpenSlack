package effectshadowapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/effectshadowstore"
)

type stubStore struct {
	observe          func(context.Context, effectshadowstore.ObserveInput) (effectshadowstore.Receipt, error)
	resolve          func(context.Context, effectshadowstore.ResolveInput) (effectshadowstore.Receipt, error)
	head             effectshadowstore.Head
	receipt          effectshadowstore.Receipt
	readyErr         error
	statistics       effectshadowstore.Statistics
	outbox           []effectshadowstore.OutboxRead
	headScope        [4]string
	outboxScope      string
	outboxLimit      int
	outboxCursor     string
	statisticsCalled int
	observeCalled    int
	resolveCalled    int
}

func (s *stubStore) ResolveReconciliation(ctx context.Context, input effectshadowstore.ResolveInput) (effectshadowstore.Receipt, error) {
	s.resolveCalled++
	if s.resolve != nil {
		return s.resolve(ctx, input)
	}
	return s.receipt, nil
}

func (s *stubStore) Observe(ctx context.Context, input effectshadowstore.ObserveInput) (effectshadowstore.Receipt, error) {
	s.observeCalled++
	if s.observe != nil {
		return s.observe(ctx, input)
	}
	return s.receipt, nil
}
func (s *stubStore) ReadHead(_ context.Context, workspace, run, occurrence, approval string) (effectshadowstore.Head, error) {
	s.headScope = [4]string{workspace, run, occurrence, approval}
	return s.head, nil
}
func (s *stubStore) ReadReceipt(context.Context, string, string) (effectshadowstore.Receipt, error) {
	return s.receipt, nil
}
func (s *stubStore) ReadPendingOutbox(_ context.Context, workspace string, limit int, cursor string) (effectshadowstore.OutboxPage, error) {
	s.outboxScope, s.outboxLimit, s.outboxCursor = workspace, limit, cursor
	return effectshadowstore.OutboxPage{Schema: effectshadowstore.OutboxPageSchema, Items: s.outbox, Count: len(s.outbox)}, nil
}
func (s *stubStore) Ready(context.Context) error { return s.readyErr }
func (s *stubStore) Statistics(context.Context) (effectshadowstore.Statistics, error) {
	s.statisticsCalled++
	return s.statistics, nil
}

type shadowGolden struct {
	SourceEnvelopes map[string]struct {
		CanonicalBytes string `json:"canonicalBytes"`
	} `json:"sourceEnvelopes"`
}

func goldenBody(t *testing.T, name string) []byte {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "packages", "workflows", "contracts", "workflow-effect-shadow", "v1", "golden-vectors.json")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var golden shadowGolden
	if err := json.Unmarshal(body, &golden); err != nil {
		t.Fatal(err)
	}
	return append([]byte(golden.SourceEnvelopes[name].CanonicalBytes), '\n')
}

func acceptedReceipt(t *testing.T, input effectshadowstore.ObserveInput, replay bool) effectshadowstore.Receipt {
	t.Helper()
	o := input.Prepared.Envelope.Observation
	observationID := "observation.gs9d.test"
	committedAt := "2026-08-14T00:00:01.000Z"
	value := effectshadowstore.ReceiptValue{
		Schema: effectshadowstore.ReceiptSchema, Status: "accepted",
		IdempotencyKey: input.IdempotencyKey, ReceiptID: "receipt.gs9d.test",
		ObservationID: &observationID, WorkspaceID: o.WorkspaceID, RunID: o.RunID,
		OccurrenceID: o.OccurrenceID, ApprovalID: o.ApprovalID,
		SourceSequence: input.Prepared.Envelope.SourceSequence,
		Operation:      input.Prepared.Envelope.Operation, Parity: "matched",
		EnvelopeHash:     input.Prepared.EnvelopeHash,
		ObservationHash:  input.Prepared.Envelope.ObservationHash,
		ServiceBuildHash: input.ServiceBuildHash, CommittedAt: &committedAt,
	}
	exact, err := canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	return effectshadowstore.Receipt{Value: value, ExactBytes: exact, Replay: replay}
}

func reconciliationReceipt(t *testing.T, input effectshadowstore.ObserveInput, replay bool) effectshadowstore.Receipt {
	t.Helper()
	o := input.Prepared.Envelope.Observation
	token := "reconciliation.gs9d.test"
	value := effectshadowstore.ReceiptValue{
		Schema: effectshadowstore.ReceiptSchema, Status: "reconciliation_required",
		IdempotencyKey: input.IdempotencyKey, ReceiptID: "receipt.gs9d.reconciliation",
		WorkspaceID: o.WorkspaceID, RunID: o.RunID, OccurrenceID: o.OccurrenceID,
		ApprovalID: o.ApprovalID, SourceSequence: input.Prepared.Envelope.SourceSequence,
		Operation: input.Prepared.Envelope.Operation, Parity: "unknown",
		ReconciliationToken: &token, EnvelopeHash: input.Prepared.EnvelopeHash,
		ObservationHash:  input.Prepared.Envelope.ObservationHash,
		ServiceBuildHash: input.ServiceBuildHash,
	}
	exact, err := canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	return effectshadowstore.Receipt{Value: value, ExactBytes: exact, Replay: replay}
}

func qualificationService(t *testing.T, store *stubStore) (*Service, string) {
	t.Helper()
	token := strings.Repeat("qualification-token-", 2)
	digest := sha256.Sum256([]byte(token))
	service, err := New(Options{
		QualificationMode: true,
		BuildSHA:          strings.Repeat("8", 64),
		BearerTokenSHA256: hex.EncodeToString(digest[:]),
		WorkspaceID:       "workspace-d1",
		CallerID:          "workflow-runner",
		Store:             store,
	})
	if err != nil {
		t.Fatal(err)
	}
	return service, token
}

func request(handler http.Handler, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	return requestReader(handler, method, path, bytes.NewReader(body), headers)
}

func requestReader(handler http.Handler, method, path string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, body)
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}

type failedReader struct{ err error }

func (reader failedReader) Read([]byte) (int, error) { return 0, reader.err }

func identityHeaders(token, key string) map[string]string {
	return map[string]string{
		"Authorization":            "Bearer " + token,
		"Content-Type":             "application/json; charset=utf-8",
		"Idempotency-Key":          key,
		"X-OpenSlack-Workspace-ID": "workspace-d1",
		"X-OpenSlack-Caller-ID":    "workflow-runner",
	}
}

func TestGS9DImageDefaultOff(t *testing.T) {
	service, err := New(Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := request(service.Handler(), http.MethodPost, effectshadowstore.Route, nil, nil); got.Code != http.StatusNotFound {
		t.Fatalf("POST route = %d", got.Code)
	}
	version := request(service.Handler(), http.MethodGet, "/version", nil, nil)
	if version.Code != http.StatusOK || !strings.Contains(version.Body.String(), `"goEffectDecisionAuthority":false`) || !strings.Contains(version.Body.String(), `"goEffectExecutionAuthority":false`) {
		t.Fatalf("version = %d %s", version.Code, version.Body.String())
	}
}

func TestGS9DQualification(t *testing.T) {
	store := &stubStore{statistics: effectshadowstore.Statistics{Heads: 1, Observations: 1, Receipts: 1, OutboxPending: 1}}
	service, token := qualificationService(t, store)
	body := goldenBody(t, "approvalCreated")
	prepared, err := effectshadowstore.PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	key := effectshadowstore.IdempotencyPrefix + prepared.EnvelopeHash
	call := 0
	store.observe = func(_ context.Context, input effectshadowstore.ObserveInput) (effectshadowstore.Receipt, error) {
		call++
		store.receipt = acceptedReceipt(t, input, call > 1)
		return store.receipt, nil
	}
	store.head = effectshadowstore.Head{
		Schema:                 effectshadowstore.HeadSchema,
		WorkspaceID:            prepared.Envelope.Observation.WorkspaceID,
		RunID:                  prepared.Envelope.Observation.RunID,
		OccurrenceID:           prepared.Envelope.Observation.OccurrenceID,
		ApprovalID:             prepared.Envelope.Observation.ApprovalID,
		SourceSequence:         1,
		Operation:              effectshadowstore.OperationApprovalCreated,
		LastObservationHash:    prepared.Envelope.ObservationHash,
		MatchedSourceSequence:  pointer(int64(1)),
		MatchedOperation:       pointer(effectshadowstore.OperationApprovalCreated),
		MatchedObservationHash: pointer(prepared.Envelope.ObservationHash),
		ServiceBuildHash:       strings.Repeat("8", 64),
		UpdatedAt:              "2026-08-14T00:00:01.000Z",
	}

	unauthorized := request(service.Handler(), http.MethodPost, effectshadowstore.Route, body, map[string]string{"Content-Type": "application/json"})
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized = %d", unauthorized.Code)
	}
	created := request(service.Handler(), http.MethodPost, effectshadowstore.Route, body, identityHeaders(token, key))
	if created.Code != http.StatusCreated || created.Header().Get("Idempotency-Replayed") != "" {
		t.Fatalf("created = %d/%q %s", created.Code, created.Header().Get("Idempotency-Replayed"), created.Body.String())
	}
	replay := request(service.Handler(), http.MethodPost, effectshadowstore.Route, body, identityHeaders(token, key))
	if replay.Code != http.StatusOK || replay.Header().Get("Idempotency-Replayed") != "true" || replay.Body.String() != created.Body.String() {
		t.Fatalf("replay = %d/%q %s", replay.Code, replay.Header().Get("Idempotency-Replayed"), replay.Body.String())
	}
	headPath := "/v1/shadow/workflow-control/runs/" + prepared.Envelope.Observation.RunID + "/occurrences/" + prepared.Envelope.Observation.OccurrenceID + "/approvals/" + prepared.Envelope.Observation.ApprovalID + "/head"
	head := request(service.Handler(), http.MethodGet, headPath, nil, identityHeaders(token, key))
	if head.Code != http.StatusOK || store.headScope != [4]string{"workspace-d1", prepared.Envelope.Observation.RunID, prepared.Envelope.Observation.OccurrenceID, prepared.Envelope.Observation.ApprovalID} {
		t.Fatalf("head = %d %#v", head.Code, store.headScope)
	}
	receipt := request(service.Handler(), http.MethodGet, "/v1/shadow/workflow-control/receipts/"+key, nil, identityHeaders(token, key))
	if receipt.Code != http.StatusOK || receipt.Body.String() != created.Body.String() {
		t.Fatalf("receipt = %d %s", receipt.Code, receipt.Body.String())
	}
	outbox := request(service.Handler(), http.MethodGet, effectshadowstore.OutboxRoute+"?limit=7&cursor=opaque-cursor", nil, identityHeaders(token, key))
	if outbox.Code != http.StatusOK || store.outboxScope != "workspace-d1" || store.outboxLimit != 7 || store.outboxCursor != "opaque-cursor" || !strings.Contains(outbox.Body.String(), `"schema":"openslack.workflow_effect_shadow_outbox_page.v1"`) || !strings.Contains(outbox.Body.String(), `"items":[]`) || !strings.Contains(outbox.Body.String(), `"nextCursor":null`) {
		t.Fatalf("outbox = %d %s / %q %d", outbox.Code, outbox.Body.String(), store.outboxScope, store.outboxLimit)
	}
	if invalid := request(service.Handler(), http.MethodGet, effectshadowstore.OutboxRoute+"?limit=101", nil, identityHeaders(token, key)); invalid.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid outbox limit = %d", invalid.Code)
	}
	for _, path := range []string{
		"/v1/shadow/workflow-control/runs/%25/occurrences/not-an-occurrence/approvals/%25/head",
		"/v1/shadow/workflow-control/receipts/not-an-idempotency-key",
	} {
		response := request(service.Handler(), http.MethodGet, path, nil, identityHeaders(token, key))
		if response.Code != http.StatusNotFound || response.Header().Get("Content-Type") != "application/json" || !strings.Contains(response.Body.String(), `"schema":"openslack.workflow_effect_shadow_error.v1"`) {
			t.Fatalf("malformed read path %q = %d/%q %s", path, response.Code, response.Header().Get("Content-Type"), response.Body.String())
		}
	}
	ready := request(service.Handler(), http.MethodGet, "/health/ready", nil, nil)
	if ready.Code != http.StatusOK || store.statisticsCalled != 0 {
		t.Fatalf("ready = %d, statistics calls = %d", ready.Code, store.statisticsCalled)
	}
	metrics := request(service.Handler(), http.MethodGet, "/metrics", nil, nil)
	if metrics.Code != http.StatusOK || !strings.Contains(metrics.Body.String(), "# TYPE workflow_effect_shadow_heads gauge") || !strings.Contains(metrics.Body.String(), "workflow_effect_shadow_outbox_pending 1") || store.statisticsCalled != 1 {
		t.Fatalf("metrics = %d %s", metrics.Code, metrics.Body.String())
	}
}

func TestEffectShadowRejectsMalformedRequestsAndMapsFailures(t *testing.T) {
	store := &stubStore{}
	service, token := qualificationService(t, store)
	body := goldenBody(t, "approvalCreated")
	prepared, err := effectshadowstore.PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	key := effectshadowstore.IdempotencyPrefix + prepared.EnvelopeHash
	headers := identityHeaders(token, key)
	headers["Content-Type"] = "text/plain"
	if got := request(service.Handler(), http.MethodPost, effectshadowstore.Route, body, headers); got.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("content type = %d", got.Code)
	}
	wrongKeyHeaders := identityHeaders(token, effectshadowstore.IdempotencyPrefix+strings.Repeat("0", 64))
	if got := request(service.Handler(), http.MethodPost, effectshadowstore.Route, body, wrongKeyHeaders); got.Code != http.StatusUnprocessableEntity || store.observeCalled != 0 {
		t.Fatalf("mismatched idempotency key = %d, observe calls = %d", got.Code, store.observeCalled)
	}
	for _, item := range []struct {
		err  error
		want int
	}{
		{effectshadowstore.Failure(effectshadowstore.ErrorInputInvalid, "bad input", nil), http.StatusUnprocessableEntity},
		{effectshadowstore.Failure(effectshadowstore.ErrorConflict, "stale", nil), http.StatusConflict},
		{effectshadowstore.Failure(effectshadowstore.ErrorNotFound, "missing", nil), http.StatusNotFound},
		{effectshadowstore.Failure(effectshadowstore.ErrorDatabase, "database", nil), http.StatusServiceUnavailable},
		{effectshadowstore.Failure(effectshadowstore.ErrorIntegrity, "corrupt", nil), http.StatusInternalServerError},
	} {
		store.observe = func(context.Context, effectshadowstore.ObserveInput) (effectshadowstore.Receipt, error) {
			return effectshadowstore.Receipt{}, item.err
		}
		if got := request(service.Handler(), http.MethodPost, effectshadowstore.Route, body, identityHeaders(token, key)); got.Code != item.want {
			t.Fatalf("%v = %d, want %d", item.err, got.Code, item.want)
		}
	}
	store.readyErr = errors.New("offline")
	if got := request(service.Handler(), http.MethodGet, "/health/ready", nil, nil); got.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready failure = %d", got.Code)
	}
}

func TestEffectShadowClassifiesRequestBodyReadFailures(t *testing.T) {
	store := &stubStore{}
	service, token := qualificationService(t, store)
	headers := identityHeaders(token, effectshadowstore.IdempotencyPrefix+strings.Repeat("0", 64))
	for _, item := range []struct {
		name string
		body io.Reader
		want int
		code string
	}{
		{
			name: "oversized",
			body: io.LimitReader(strings.NewReader(strings.Repeat("x", effectshadowstore.MaxRequestBytes+1)), effectshadowstore.MaxRequestBytes+1),
			want: http.StatusRequestEntityTooLarge,
			code: string(effectshadowstore.ErrorContentInvalid),
		},
		{name: "deadline", body: failedReader{err: context.DeadlineExceeded}, want: http.StatusRequestTimeout, code: "WORKFLOW_EFFECT_SHADOW_REQUEST_TIMEOUT"},
		{name: "cancelled", body: failedReader{err: context.Canceled}, want: http.StatusRequestTimeout, code: "WORKFLOW_EFFECT_SHADOW_REQUEST_TIMEOUT"},
		{name: "deterministic", body: failedReader{err: errors.New("read failed")}, want: http.StatusBadRequest, code: "WORKFLOW_EFFECT_SHADOW_REQUEST_READ_FAILED"},
	} {
		t.Run(item.name, func(t *testing.T) {
			response := requestReader(service.Handler(), http.MethodPost, effectshadowstore.Route, item.body, headers)
			if response.Code != item.want || !strings.Contains(response.Body.String(), `"code":"`+item.code+`"`) {
				t.Fatalf("response = %d %s, want %d/%s", response.Code, response.Body.String(), item.want, item.code)
			}
		})
	}
	if store.observeCalled != 0 {
		t.Fatalf("malformed bodies reached the store %d times", store.observeCalled)
	}
}

func TestEffectShadowResolvesAnImmutableReconciliationReceipt(t *testing.T) {
	store := &stubStore{}
	service, token := qualificationService(t, store)
	body := goldenBody(t, "approvalCreated")
	prepared, err := effectshadowstore.PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	key := effectshadowstore.IdempotencyPrefix + prepared.EnvelopeHash
	store.observe = func(_ context.Context, input effectshadowstore.ObserveInput) (effectshadowstore.Receipt, error) {
		return reconciliationReceipt(t, input, store.observeCalled > 1), nil
	}
	store.resolve = func(_ context.Context, input effectshadowstore.ResolveInput) (effectshadowstore.Receipt, error) {
		if input.ReconciliationToken != "reconciliation.gs9d.test" {
			t.Fatalf("resolve token = %q", input.ReconciliationToken)
		}
		return acceptedReceipt(t, input.ObserveInput, store.resolveCalled > 1), nil
	}

	original := request(service.Handler(), http.MethodPost, effectshadowstore.Route, body, identityHeaders(token, key))
	if original.Code != http.StatusAccepted || original.Header().Get("Idempotency-Replayed") != "" {
		t.Fatalf("original reconciliation = %d/%q %s", original.Code, original.Header().Get("Idempotency-Replayed"), original.Body.String())
	}
	replay := request(service.Handler(), http.MethodPost, effectshadowstore.Route, body, identityHeaders(token, key))
	if replay.Code != http.StatusAccepted || replay.Header().Get("Idempotency-Replayed") != "true" || replay.Body.String() != original.Body.String() {
		t.Fatalf("replayed reconciliation = %d/%q %s", replay.Code, replay.Header().Get("Idempotency-Replayed"), replay.Body.String())
	}
	path := effectshadowstore.ReconciliationResolveRoutePrefix + "reconciliation.gs9d.test" + effectshadowstore.ReconciliationResolveRouteSuffix
	resolved := request(service.Handler(), http.MethodPost, path, body, identityHeaders(token, key))
	if resolved.Code != http.StatusCreated || resolved.Header().Get("Idempotency-Replayed") != "" {
		t.Fatalf("resolved reconciliation = %d/%q %s", resolved.Code, resolved.Header().Get("Idempotency-Replayed"), resolved.Body.String())
	}
	resolvedReplay := request(service.Handler(), http.MethodPost, path, body, identityHeaders(token, key))
	if resolvedReplay.Code != http.StatusOK || resolvedReplay.Header().Get("Idempotency-Replayed") != "true" || resolvedReplay.Body.String() != resolved.Body.String() {
		t.Fatalf("replayed resolution = %d/%q %s", resolvedReplay.Code, resolvedReplay.Header().Get("Idempotency-Replayed"), resolvedReplay.Body.String())
	}
}

func TestEffectShadowTimeoutsHaveCommitRecoverySlack(t *testing.T) {
	if writeTimeout <= requestDeadline || writeTimeout < requestDeadline+2*5_000_000_000 {
		t.Fatalf("write timeout %s lacks recovery slack after %s", writeTimeout, requestDeadline)
	}
	if readTimeout != requestDeadline {
		t.Fatalf("read timeout = %s, request deadline = %s", readTimeout, requestDeadline)
	}
}

func pointer[T any](value T) *T { return &value }
