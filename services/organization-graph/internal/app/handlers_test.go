package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

const testServiceBuildSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type fixedClock struct{ value time.Time }

func (clock fixedClock) Now() time.Time { return clock.value }

type fakeStore struct {
	snapshot         graph.Snapshot
	snapshotReceipt  *Receipt
	deltaReceipt     *Receipt
	snapshotErr      error
	deltaErr         error
	currentErr       error
	readyErr         error
	metricsErr       error
	snapshotCommands []SnapshotCommand
	deltaCommands    []DeltaCommand
	scenarios        []Scenario
	metrics          StoreMetrics
}

func (store *fakeStore) CheckReady(context.Context) error { return store.readyErr }

func (store *fakeStore) IngestSnapshot(_ context.Context, command SnapshotCommand) (Receipt, error) {
	store.snapshotCommands = append(store.snapshotCommands, command)
	if store.snapshotErr != nil {
		var failure *StoreError
		if errors.As(store.snapshotErr, &failure) && failure.Receipt != nil {
			failure.Receipt.IdempotencyKey = command.IdempotencyKey
			failure.Receipt.RequestFingerprint = command.Fingerprint
		}
		return Receipt{}, store.snapshotErr
	}
	if store.snapshotReceipt != nil {
		result := *store.snapshotReceipt
		result.IdempotencyKey = command.IdempotencyKey
		result.RequestFingerprint = command.Fingerprint
		return result, nil
	}
	committed := "2026-07-30T10:00:00Z"
	return Receipt{
		Operation:             OperationSnapshotIngest,
		Status:                ReceiptAccepted,
		IdempotencyKey:        command.IdempotencyKey,
		RequestFingerprint:    command.Fingerprint,
		ScenarioInstanceID:    command.Snapshot.ScenarioInstanceID,
		Cursor:                command.Snapshot.Cursor,
		Revision:              1,
		SnapshotIntegrityHash: command.Snapshot.IntegrityHash,
		CommittedAt:           &committed,
	}, nil
}

func (store *fakeStore) IngestDelta(_ context.Context, command DeltaCommand) (Receipt, error) {
	store.deltaCommands = append(store.deltaCommands, command)
	if store.deltaErr != nil {
		return Receipt{}, store.deltaErr
	}
	if store.deltaReceipt != nil {
		result := *store.deltaReceipt
		result.IdempotencyKey = command.IdempotencyKey
		result.RequestFingerprint = command.Fingerprint
		return result, nil
	}
	committed := "2026-07-30T10:00:00Z"
	deltaHash := command.Delta.IntegrityHash
	return Receipt{
		Operation:             OperationDeltaIngest,
		Status:                ReceiptAccepted,
		IdempotencyKey:        command.IdempotencyKey,
		RequestFingerprint:    command.Fingerprint,
		ScenarioInstanceID:    command.TargetSnapshot.ScenarioInstanceID,
		Cursor:                command.TargetSnapshot.Cursor,
		Revision:              2,
		SnapshotIntegrityHash: command.TargetSnapshot.IntegrityHash,
		DeltaIntegrityHash:    &deltaHash,
		CommittedAt:           &committed,
	}, nil
}

func (store *fakeStore) CurrentSnapshot(context.Context, string) (CurrentSnapshot, error) {
	return CurrentSnapshot{Snapshot: store.snapshot, Revision: 1}, store.currentErr
}

func (store *fakeStore) ListScenarios(context.Context) ([]Scenario, error) {
	return append([]Scenario(nil), store.scenarios...), nil
}

func (store *fakeStore) Metrics(context.Context) (StoreMetrics, error) {
	return store.metrics, store.metricsErr
}

func testSnapshot(t *testing.T, cursor, generatedAt string) graph.Snapshot {
	t.Helper()
	authority := graph.AuthorityRef{
		Provider:   "github",
		ObjectType: "issue",
		ObjectID:   "42",
		Version:    "v1",
		ObservedAt: "2026-07-30T09:00:00Z",
	}
	nodeID, err := graph.DeriveNodeID("scenario-1", "core.work_item", authority)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := graph.SealSnapshot(graph.Snapshot{
		Schema:             graph.SnapshotSchema,
		Cursor:             cursor,
		ScenarioInstanceID: "scenario-1",
		GeneratedAt:        generatedAt,
		ProjectorVersion:   "projector-v1",
		Nodes: []graph.Node{{
			ID:                   nodeID,
			Type:                 "core.work_item",
			ScenarioDefinitionID: "software-delivery",
			ScenarioInstanceID:   "scenario-1",
			Title:                "Issue 42",
			AuthorityRef:         authority,
			Owners:               []graph.ActorRef{},
			Properties:           graph.Object{},
			SourceEventIDs:       []string{},
			EvidenceRefs:         []string{"github:issue:42"},
			ProjectorVersion:     "projector-v1",
			ValidFrom:            "2026-07-30T09:00:00Z",
		}},
		Edges: []graph.Edge{},
		Completeness: graph.Completeness{
			SourcesRequested: []string{"github"},
			SourcesObserved:  []string{"github"},
			MissingSources:   []string{},
			Warnings:         []string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func testService(t *testing.T, store *fakeStore) *Service {
	t.Helper()
	service, err := New(Options{
		Store:        store,
		CursorSecret: []byte("0123456789abcdef0123456789abcdef"),
		BuildSHA:     testServiceBuildSHA,
		Logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		Clock:        fixedClock{value: time.UnixMilli(1_784_800_000_000).UTC()},
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func snapshotRequestBody(t *testing.T, snapshot graph.Snapshot, expected *string) []byte {
	t.Helper()
	raw, err := graph.SerializeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	value, err := graph.ParseCanonicalJSON(raw, graph.DefaultJSONLimits())
	if err != nil {
		t.Fatal(err)
	}
	body, err := graph.CanonicalJSON(graph.Object{
		"expectedCursor": expectedCursorValue(expected),
		"snapshot":       value,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func deltaRequestBody(t *testing.T, expected string, target graph.Snapshot, delta graph.Delta) []byte {
	t.Helper()
	targetBytes, err := graph.SerializeSnapshot(target)
	if err != nil {
		t.Fatal(err)
	}
	targetValue, err := graph.ParseCanonicalJSON(targetBytes, graph.DefaultJSONLimits())
	if err != nil {
		t.Fatal(err)
	}
	deltaBytes, err := graph.SerializeDelta(delta)
	if err != nil {
		t.Fatal(err)
	}
	deltaValue, err := graph.ParseCanonicalJSON(deltaBytes, graph.DefaultJSONLimits())
	if err != nil {
		t.Fatal(err)
	}
	body, err := graph.CanonicalJSON(graph.Object{
		"expectedCursor": expected,
		"targetSnapshot": targetValue,
		"delta":          deltaValue,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func performJSON(service *Service, method, path string, body []byte, key string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	return response
}

func TestSnapshotIngestReturnsFrozenAcceptedReceiptAndCanonicalFingerprint(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	store := &fakeStore{snapshot: snapshot}
	service := testService(t, store)

	response := performJSON(service, http.MethodPost, RouteSnapshotIngest, snapshotRequestBody(t, snapshot, nil), "snapshot-1")
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var receipt map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]any{
		"schema":                ReceiptSchema,
		"operation":             OperationSnapshotIngest,
		"status":                ReceiptAccepted,
		"idempotencyKey":        "snapshot-1",
		"scenarioInstanceId":    "scenario-1",
		"cursor":                "cursor-1",
		"snapshotIntegrityHash": snapshot.IntegrityHash,
	} {
		if receipt[key] != want {
			t.Fatalf("receipt[%s] = %#v, want %#v", key, receipt[key], want)
		}
	}
	fingerprint, ok := receipt["requestFingerprint"].(string)
	if !ok || !fingerprintPattern.MatchString(fingerprint) {
		t.Fatalf("invalid fingerprint %#v", receipt["requestFingerprint"])
	}
	if len(store.snapshotCommands) != 1 || store.snapshotCommands[0].Fingerprint != fingerprint {
		t.Fatal("store did not receive the returned fingerprint")
	}
	canonicalBody := snapshotRequestBody(t, snapshot, nil)
	expectedDigest := sha256.Sum256(append(
		[]byte("POST\n"+RouteSnapshotIngest+"\n"),
		canonicalBody...,
	))
	if fingerprint != fmt.Sprintf("sha256:%x", expectedDigest) {
		t.Fatalf("fingerprint = %s, want sha256:%x", fingerprint, expectedDigest)
	}
}

func TestDeltaIngestReturnsFrozenReceiptAndCanonicalArtifacts(t *testing.T) {
	target := testSnapshot(t, "cursor-2", "2026-07-30T11:00:00Z")
	delta, err := graph.SealDelta(graph.Delta{
		Schema:             graph.DeltaSchema,
		ScenarioInstanceID: target.ScenarioInstanceID,
		FromCursor:         "cursor-1",
		ToCursor:           target.Cursor,
		GeneratedAt:        target.GeneratedAt,
		UpsertNodes:        target.Nodes,
		CloseNodeIDs:       []string{},
		UpsertEdges:        []graph.Edge{},
		CloseEdgeIDs:       []string{},
		EvidenceRefs:       []string{"github:issue:42"},
	})
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{snapshot: target}
	service := testService(t, store)
	response := performJSON(
		service,
		http.MethodPost,
		RouteDeltaIngest,
		deltaRequestBody(t, "cursor-1", target, delta),
		"delta-1",
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"deltaIntegrityHash":"`+delta.IntegrityHash+`"`) {
		t.Fatalf("delta receipt = %s", response.Body.String())
	}
	if len(store.deltaCommands) != 1 ||
		string(store.deltaCommands[0].TargetCanonicalBytes) == "" ||
		string(store.deltaCommands[0].DeltaCanonicalBytes) == "" {
		t.Fatal("Store did not receive canonical target and delta bytes")
	}
}

func TestFingerprintUsesRecanonicalizedEnvelopeNotRawRequestBytes(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	snapshotBytes, err := graph.SerializeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{snapshot: snapshot}
	service := testService(t, store)
	canonical := snapshotRequestBody(t, snapshot, nil)
	reordered := append([]byte(`{ "snapshot" : `), snapshotBytes...)
	reordered = append(reordered, []byte(`, "expectedCursor" : null }`)...)

	first := performJSON(service, http.MethodPost, RouteSnapshotIngest, canonical, "canonical-1")
	second := performJSON(service, http.MethodPost, RouteSnapshotIngest, reordered, "canonical-2")
	if first.Code != http.StatusCreated || second.Code != http.StatusCreated {
		t.Fatalf("statuses = %d/%d", first.Code, second.Code)
	}
	if len(store.snapshotCommands) != 2 ||
		store.snapshotCommands[0].Fingerprint != store.snapshotCommands[1].Fingerprint {
		t.Fatalf("raw formatting changed fingerprint: %#v", store.snapshotCommands)
	}
}

func TestMutationBoundaryRejectsDuplicateUnknownAndOversizedJSONBeforeStore(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	store := &fakeStore{snapshot: snapshot}
	service := testService(t, store)
	valid := snapshotRequestBody(t, snapshot, nil)

	unknown := append([]byte(nil), valid[:len(valid)-1]...)
	unknown = append(unknown, []byte(`,"actor":"caller"}`)...)
	duplicate := []byte(`{"expectedCursor":null,"expectedCursor":null,"snapshot":{}}`)
	tests := []struct {
		name   string
		body   []byte
		status int
	}{
		{name: "unknown field", body: unknown, status: http.StatusUnprocessableEntity},
		{name: "duplicate key", body: duplicate, status: http.StatusUnprocessableEntity},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performJSON(service, http.MethodPost, RouteSnapshotIngest, test.body, "snapshot-1")
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, test.status, response.Body.String())
			}
		})
	}
	if len(store.snapshotCommands) != 0 {
		t.Fatalf("invalid requests reached Store: %d", len(store.snapshotCommands))
	}

	request := httptest.NewRequest(http.MethodPost, RouteSnapshotIngest, strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "snapshot-oversized")
	request.ContentLength = MaxRequestBodyBytes + 1
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized status = %d", response.Code)
	}
}

func TestMutationRequiresOneCanonicalIdempotencyHeader(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	store := &fakeStore{snapshot: snapshot}
	service := testService(t, store)
	body := snapshotRequestBody(t, snapshot, nil)

	for _, key := range []string{"", "contains space", strings.Repeat("a", 129)} {
		response := performJSON(service, http.MethodPost, RouteSnapshotIngest, body, key)
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("key %q status = %d", key, response.Code)
		}
	}

	request := httptest.NewRequest(http.MethodPost, RouteSnapshotIngest, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Add("Idempotency-Key", "one")
	request.Header.Add("Idempotency-Key", "two")
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("duplicate header status = %d", response.Code)
	}
	if len(store.snapshotCommands) != 0 {
		t.Fatal("invalid idempotency header reached Store")
	}
}

func TestAmbiguousCommitReturnsDurableReconciliationReceipt(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	token := "reconcile-1"
	receipt := Receipt{
		Operation:             OperationSnapshotIngest,
		Status:                ReceiptReconciliationRequired,
		ScenarioInstanceID:    snapshot.ScenarioInstanceID,
		Cursor:                snapshot.Cursor,
		Revision:              1,
		SnapshotIntegrityHash: snapshot.IntegrityHash,
		ReconciliationToken:   &token,
	}
	store := &fakeStore{
		snapshot:        snapshot,
		snapshotReceipt: &receipt,
	}
	service := testService(t, store)
	response := performJSON(service, http.MethodPost, RouteSnapshotIngest, snapshotRequestBody(t, snapshot, nil), "snapshot-ambiguous")
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"status":"reconciliation_required"`) ||
		!strings.Contains(response.Body.String(), `"reconciliationToken":"reconcile-1"`) {
		t.Fatalf("unexpected receipt: %s", response.Body.String())
	}
}

func TestStoreErrorsMapToFrozenHTTPStatuses(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	tests := []struct {
		code   StoreErrorCode
		status int
	}{
		{code: StoreNotFound, status: http.StatusNotFound},
		{code: StoreConflict, status: http.StatusConflict},
		{code: StoreIdempotencyConflict, status: http.StatusConflict},
		{code: StoreUnprocessable, status: http.StatusUnprocessableEntity},
		{code: StoreTooLarge, status: http.StatusRequestEntityTooLarge},
		{code: StoreUnavailable, status: http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		t.Run(string(test.code), func(t *testing.T) {
			store := &fakeStore{snapshot: snapshot, snapshotErr: &StoreError{Code: test.code}}
			response := performJSON(testService(t, store), http.MethodPost, RouteSnapshotIngest, snapshotRequestBody(t, snapshot, nil), "snapshot-error")
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, test.status, response.Body.String())
			}
		})
	}
}

func TestQueryExplainAndScenarioReadsUseCurrentVerifiedSnapshot(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	store := &fakeStore{
		snapshot: snapshot,
		scenarios: []Scenario{{
			ScenarioInstanceID:    snapshot.ScenarioInstanceID,
			Cursor:                snapshot.Cursor,
			SnapshotIntegrityHash: snapshot.IntegrityHash,
			Revision:              1,
			GeneratedAt:           snapshot.GeneratedAt,
		}},
	}
	service := testService(t, store)

	queryResponse := performJSON(service, http.MethodPost, RouteQuery, []byte(`{"scenarioInstanceId":"scenario-1"}`), "")
	if queryResponse.Code != http.StatusOK ||
		!strings.Contains(queryResponse.Body.String(), `"snapshotCursor":"cursor-1"`) {
		t.Fatalf("query status/body = %d %s", queryResponse.Code, queryResponse.Body.String())
	}

	explainBody := []byte(`{"scenarioInstanceId":"scenario-1","targetId":"` + snapshot.Nodes[0].ID + `"}`)
	explainResponse := performJSON(service, http.MethodPost, RouteExplain, explainBody, "")
	if explainResponse.Code != http.StatusOK ||
		!strings.Contains(explainResponse.Body.String(), `"targetKind":"node"`) {
		t.Fatalf("explain status/body = %d %s", explainResponse.Code, explainResponse.Body.String())
	}

	scenarioResponse := httptest.NewRecorder()
	service.Handler().ServeHTTP(scenarioResponse, httptest.NewRequest(http.MethodGet, RouteScenarios, nil))
	if scenarioResponse.Code != http.StatusOK ||
		!strings.Contains(scenarioResponse.Body.String(), `"schema":"openslack.graph_scenario_list.v1"`) {
		t.Fatalf("scenarios status/body = %d %s", scenarioResponse.Code, scenarioResponse.Body.String())
	}
}

func TestHealthVersionAndMetricsAreBoundedAndDatabaseAware(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	store := &fakeStore{
		snapshot: snapshot,
		metrics: StoreMetrics{
			PublishedScenarios:       1,
			PublishedHeadRevisionMax: 4,
			ReconciliationPending:    2,
		},
	}
	service := testService(t, store)

	for _, path := range []string{RouteLive, RouteReady, RouteVersion, RouteMetrics} {
		response := httptest.NewRecorder()
		service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body = %s", path, response.Code, response.Body.String())
		}
	}
	version := httptest.NewRecorder()
	service.Handler().ServeHTTP(version, httptest.NewRequest(http.MethodGet, RouteVersion, nil))
	if !strings.Contains(version.Body.String(), testServiceBuildSHA) {
		t.Fatalf("version body = %s", version.Body.String())
	}
	metrics := httptest.NewRecorder()
	service.Handler().ServeHTTP(metrics, httptest.NewRequest(http.MethodGet, RouteMetrics, nil))
	for _, name := range []string{
		"openslack_graph_http_requests_total",
		"openslack_graph_published_scenarios 1",
		"openslack_graph_published_head_revision_max 4",
		"openslack_graph_reconciliation_pending 2",
	} {
		if !strings.Contains(metrics.Body.String(), name) {
			t.Fatalf("metrics missing %q:\n%s", name, metrics.Body.String())
		}
	}
	if strings.Contains(metrics.Body.String(), "openslack_graph_shadow_backlog ") ||
		strings.Contains(metrics.Body.String(), "openslack_graph_shadow_lag_seconds ") ||
		strings.Contains(metrics.Body.String(), "openslack_graph_parity_mismatches_total 0") {
		t.Fatalf("metrics emitted unknown shadow observation as zero:\n%s", metrics.Body.String())
	}

	store.readyErr = errors.New("db unavailable")
	ready := httptest.NewRecorder()
	service.Handler().ServeHTTP(ready, httptest.NewRequest(http.MethodGet, RouteReady, nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready status = %d", ready.Code)
	}
	store.metricsErr = errors.New("db unavailable")
	unavailableMetrics := httptest.NewRecorder()
	service.Handler().ServeHTTP(unavailableMetrics, httptest.NewRequest(http.MethodGet, RouteMetrics, nil))
	if unavailableMetrics.Code != http.StatusServiceUnavailable {
		t.Fatalf("metrics status = %d", unavailableMetrics.Code)
	}
}

func TestMetricsNormalizeArbitraryHTTPMethodsToOther(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	store := &fakeStore{snapshot: snapshot}
	service := testService(t, store)
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest("ATTACKER-CONTROLLED", RouteLive, nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("unexpected method status = %d", response.Code)
	}
	metrics := httptest.NewRecorder()
	service.Handler().ServeHTTP(metrics, httptest.NewRequest(http.MethodGet, RouteMetrics, nil))
	if !strings.Contains(metrics.Body.String(), `method="other"`) {
		t.Fatalf("metrics did not normalize unknown method:\n%s", metrics.Body.String())
	}
	if strings.Contains(metrics.Body.String(), "ATTACKER-CONTROLLED") {
		t.Fatalf("metrics leaked attacker-controlled method:\n%s", metrics.Body.String())
	}
}

func TestScenarioListFailsClosedBeforeWritingOversizedResponse(t *testing.T) {
	identifier := strings.Repeat("x", graph.MaxIdentifierCharacters)
	scenarios := make([]Scenario, 10_000)
	for index := range scenarios {
		scenarios[index] = Scenario{
			ScenarioInstanceID:    identifier,
			Cursor:                identifier,
			SnapshotIntegrityHash: "sha256:" + strings.Repeat("0", 64),
			Revision:              1,
			GeneratedAt:           "2026-07-30T10:00:00Z",
		}
	}
	service := testService(t, &fakeStore{scenarios: scenarios})
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, RouteScenarios, nil))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body prefix = %.200s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"code":"GRAPH_REQUEST_TOO_LARGE"`) {
		t.Fatalf("unexpected oversized response: %s", response.Body.String())
	}
}

func TestScenarioListUsesCanonicalUTF16Ordering(t *testing.T) {
	hash := "sha256:" + strings.Repeat("0", 64)
	service := testService(t, &fakeStore{scenarios: []Scenario{
		{
			ScenarioInstanceID:    "\ue000-private",
			Cursor:                "cursor-private",
			SnapshotIntegrityHash: hash,
			Revision:              1,
			GeneratedAt:           "2026-07-30T10:00:00Z",
		},
		{
			ScenarioInstanceID:    "😀-non-bmp",
			Cursor:                "cursor-emoji",
			SnapshotIntegrityHash: hash,
			Revision:              1,
			GeneratedAt:           "2026-07-30T10:00:00Z",
		},
	}})
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, RouteScenarios, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	emoji := strings.Index(response.Body.String(), "😀-non-bmp")
	private := strings.Index(response.Body.String(), "\ue000-private")
	if emoji < 0 || private < 0 || emoji >= private {
		t.Fatalf("scenario list is not UTF-16 ordered: %s", response.Body.String())
	}
}

func TestStoreFailureLogsNeverIncludeRawCauseOrCredentials(t *testing.T) {
	const sentinel = "password-sentinel"
	var logs bytes.Buffer
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	store := &fakeStore{
		snapshot: snapshot,
		snapshotErr: &StoreError{
			Code:  StoreErrorCode("unexpected"),
			Cause: errors.New("postgres://graph:" + sentinel + "@db/graph"),
		},
	}
	service, err := New(Options{
		Store:        store,
		CursorSecret: []byte("0123456789abcdef0123456789abcdef"),
		BuildSHA:     testServiceBuildSHA,
		Logger:       slog.New(slog.NewJSONHandler(&logs, nil)),
		Clock:        fixedClock{value: time.UnixMilli(1_784_800_000_000).UTC()},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := performJSON(service, http.MethodPost, RouteSnapshotIngest, snapshotRequestBody(t, snapshot, nil), "snapshot-secret-test")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", response.Code)
	}
	if strings.Contains(logs.String(), sentinel) || strings.Contains(logs.String(), "postgres://") {
		t.Fatalf("logs exposed raw store error: %s", logs.String())
	}
}

func TestPostRoutesRejectUnknownFieldsAndQueryParameters(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	service := testService(t, &fakeStore{snapshot: snapshot})
	for _, test := range []struct {
		path string
		body string
	}{
		{path: RouteQuery, body: `{"scenarioInstanceId":"scenario-1","actor":"caller"}`},
		{path: RouteExplain, body: `{"scenarioInstanceId":"scenario-1","targetId":"x","policy":{}}`},
	} {
		response := performJSON(service, http.MethodPost, test.path, []byte(test.body), "")
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s status = %d", test.path, response.Code)
		}
	}
	response := performJSON(service, http.MethodPost, RouteQuery+"?initialize=true", []byte(`{"scenarioInstanceId":"scenario-1"}`), "")
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("query parameter status = %d", response.Code)
	}
}

func TestNewRejectsMissingDependenciesAndUnsafeCursorConfiguration(t *testing.T) {
	for _, options := range []Options{
		{BuildSHA: testServiceBuildSHA, CursorSecret: []byte(strings.Repeat("x", 32))},
		{Store: &fakeStore{}, BuildSHA: testServiceBuildSHA, CursorSecret: []byte("short")},
		{Store: &fakeStore{}, BuildSHA: testServiceBuildSHA, CursorSecret: []byte(strings.Repeat("x", 32)), PreviousCursorSecret: []byte("short")},
		{Store: &fakeStore{}, BuildSHA: testServiceBuildSHA, CursorSecret: []byte(strings.Repeat("x", 32)), PreviousCursorSecret: []byte(strings.Repeat("x", 32))},
		{Store: &fakeStore{}, BuildSHA: "development", CursorSecret: []byte(strings.Repeat("x", 32))},
	} {
		if _, err := New(options); err == nil {
			t.Fatalf("invalid options were accepted: %#v", options)
		}
	}
}

func TestRunPerformsBoundedGracefulShutdown(t *testing.T) {
	snapshot := testSnapshot(t, "cursor-1", "2026-07-30T10:00:00Z")
	service := testService(t, &fakeStore{snapshot: snapshot})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	go func() {
		done <- service.Run(ctx, "127.0.0.1:0", time.Second)
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run() did not complete graceful shutdown within its bound")
	}
}
