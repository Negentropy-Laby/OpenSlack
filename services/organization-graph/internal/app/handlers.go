package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"time"
	"unicode/utf16"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

const maxSafeJSONInteger = int64(9_007_199_254_740_991)

const CanaryReadSchema = "openslack.graph_canary_read.v1"
const AuthorityReadSchema = "openslack.graph_authority_read.v1"

const (
	// The frozen maximum graph is about 16 MiB before PostgreSQL TOAST work.
	// These remain hard bounds while leaving enough budget for exact-bound
	// validation, durable commit, and verified readback on constrained runners.
	mutationDeadline = 2 * time.Minute
	readDeadline     = time.Minute
)

var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func (service *Service) handleSnapshotIngest(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	idempotencyKey, ok := service.requireIdempotencyKey(w, request)
	if !ok {
		return
	}
	value, err := readStrictJSON(request)
	if err != nil {
		writeMappedError(w, service.logger, err, OperationSnapshotIngest, service.counters)
		return
	}
	expectedCursor, snapshot, canonical, normalized, err := decodeSnapshotRequest(value)
	if err != nil {
		writeMappedError(w, service.logger, err, OperationSnapshotIngest, service.counters)
		return
	}
	fingerprint, err := requestFingerprint(request.Method, request.URL.Path, normalized)
	if err != nil {
		writeMappedError(w, service.logger, err, OperationSnapshotIngest, service.counters)
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), mutationDeadline)
	defer cancel()
	receipt, err := service.store.IngestSnapshot(ctx, SnapshotCommand{
		IdempotencyKey: idempotencyKey,
		Fingerprint:    fingerprint,
		ExpectedCursor: expectedCursor,
		Snapshot:       snapshot,
		CanonicalBytes: canonical,
	})
	if err != nil {
		if service.writeAmbiguousReceipt(w, err, OperationSnapshotIngest, idempotencyKey, fingerprint) {
			return
		}
		writeMappedError(w, service.logger, err, OperationSnapshotIngest, service.counters)
		return
	}
	service.writeReceipt(w, receipt, OperationSnapshotIngest, idempotencyKey, fingerprint)
}

func (service *Service) handleDeltaIngest(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	idempotencyKey, ok := service.requireIdempotencyKey(w, request)
	if !ok {
		return
	}
	value, err := readStrictJSON(request)
	if err != nil {
		writeMappedError(w, service.logger, err, OperationDeltaIngest, service.counters)
		return
	}
	expectedCursor, target, targetBytes, delta, deltaBytes, normalized, err := decodeDeltaRequest(value)
	if err != nil {
		writeMappedError(w, service.logger, err, OperationDeltaIngest, service.counters)
		return
	}
	fingerprint, err := requestFingerprint(request.Method, request.URL.Path, normalized)
	if err != nil {
		writeMappedError(w, service.logger, err, OperationDeltaIngest, service.counters)
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), mutationDeadline)
	defer cancel()
	receipt, err := service.store.IngestDelta(ctx, DeltaCommand{
		IdempotencyKey:       idempotencyKey,
		Fingerprint:          fingerprint,
		ExpectedCursor:       expectedCursor,
		TargetSnapshot:       target,
		TargetCanonicalBytes: targetBytes,
		Delta:                delta,
		DeltaCanonicalBytes:  deltaBytes,
	})
	if err != nil {
		if service.writeAmbiguousReceipt(w, err, OperationDeltaIngest, idempotencyKey, fingerprint) {
			return
		}
		writeMappedError(w, service.logger, err, OperationDeltaIngest, service.counters)
		return
	}
	service.writeReceipt(w, receipt, OperationDeltaIngest, idempotencyKey, fingerprint)
}

func (service *Service) handleQuery(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	value, err := readStrictJSON(request)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	input, err := decodeQuery(value)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	current, err := service.store.CurrentSnapshot(ctx, input.ScenarioInstanceID)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	result, err := graph.Query(current.Snapshot, input, graph.QueryOptions{
		CursorSecret:         append([]byte(nil), service.cursorSecret...),
		PreviousCursorSecret: append([]byte(nil), service.previousCursorSecret...),
		NowMS:                service.clock.Now().UnixMilli(),
	})
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	body, err := graph.SerializeQueryResult(result)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	if !writeCanonicalBytes(w, http.StatusOK, body) {
		writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "graph response exceeds a frozen service limit")
	}
}

func (service *Service) handleExplain(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	value, err := readStrictJSON(request)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	input, err := decodeExplain(value)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	current, err := service.store.CurrentSnapshot(ctx, input.ScenarioInstanceID)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	result, err := graph.Explain(current.Snapshot, input)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	body, err := graph.SerializeExplanation(result)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	if !writeCanonicalBytes(w, http.StatusOK, body) {
		writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "graph response exceeds a frozen service limit")
	}
}

func (service *Service) requireCanaryBinding(w http.ResponseWriter, request *http.Request) (int64, bool) {
	if service.canaryRoutingEpoch == nil {
		writeFailure(w, http.StatusServiceUnavailable, errorCanaryNotConfigured, "graph canary read authority is not configured")
		return 0, false
	}
	epochValues := request.Header.Values(HeaderCanaryRoutingEpoch)
	buildValues := request.Header.Values(HeaderExpectedBuildSHA)
	if len(epochValues) != 1 || len(buildValues) != 1 {
		writeFailure(w, http.StatusConflict, errorCanaryRouteMismatch, "graph canary routing binding did not match")
		return 0, false
	}
	epoch, err := strconv.ParseInt(epochValues[0], 10, 64)
	if err != nil || strconv.FormatInt(epoch, 10) != epochValues[0] ||
		epoch != *service.canaryRoutingEpoch || buildValues[0] != service.buildSHA {
		writeFailure(w, http.StatusConflict, errorCanaryRouteMismatch, "graph canary routing binding did not match")
		return 0, false
	}
	return epoch, true
}

func (service *Service) handleCanaryQuery(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	epoch, ok := service.requireCanaryBinding(w, request)
	if !ok {
		return
	}
	value, err := readStrictJSON(request)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	input, err := decodeQuery(value)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	current, err := service.store.CurrentSnapshot(ctx, input.ScenarioInstanceID)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	result, err := graph.Query(current.Snapshot, input, graph.QueryOptions{
		CursorSecret:         append([]byte(nil), service.cursorSecret...),
		PreviousCursorSecret: append([]byte(nil), service.previousCursorSecret...),
		RoutingEpoch:         &epoch,
		NowMS:                service.clock.Now().UnixMilli(),
	})
	if err != nil {
		writeCanaryQueryError(w, service.logger, err, service.counters)
		return
	}
	if !writeCanonical(w, http.StatusOK, graph.Object{
		"schema": CanaryReadSchema, "operation": "query", "backend": "go",
		"routingEpoch": float64(epoch), "serviceBuildSha": service.buildSHA,
		"generatedAt": current.Snapshot.GeneratedAt, "snapshotCursor": current.Snapshot.Cursor,
		"result": graph.QueryResultValue(result),
	}) {
		writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "graph response exceeds a frozen service limit")
	}
}

func (service *Service) handleCanaryExplain(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	epoch, ok := service.requireCanaryBinding(w, request)
	if !ok {
		return
	}
	value, err := readStrictJSON(request)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	input, err := decodeExplain(value)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	current, err := service.store.CurrentSnapshot(ctx, input.ScenarioInstanceID)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	result, err := graph.Explain(current.Snapshot, input)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	if !writeCanonical(w, http.StatusOK, graph.Object{
		"schema": CanaryReadSchema, "operation": "explain", "backend": "go",
		"routingEpoch": float64(epoch), "serviceBuildSha": service.buildSHA,
		"generatedAt": current.Snapshot.GeneratedAt, "snapshotCursor": current.Snapshot.Cursor,
		"result": graph.ExplanationValue(result),
	}) {
		writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "graph response exceeds a frozen service limit")
	}
}

func (service *Service) requireAuthorityBinding(w http.ResponseWriter, request *http.Request) (int64, bool) {
	if service.readAuthorityRoutingEpoch == nil {
		writeFailure(w, http.StatusServiceUnavailable, errorAuthorityNotConfigured, "graph read authority is not configured")
		return 0, false
	}
	epochValues := request.Header.Values(HeaderCanaryRoutingEpoch)
	buildValues := request.Header.Values(HeaderExpectedBuildSHA)
	tenantValues := request.Header.Values(HeaderAuthorityTenantID)
	if len(epochValues) != 1 || len(buildValues) != 1 || len(tenantValues) != 1 {
		writeFailure(w, http.StatusConflict, errorAuthorityRouteMismatch, "graph authority routing binding did not match")
		return 0, false
	}
	epoch, err := strconv.ParseInt(epochValues[0], 10, 64)
	if err != nil || strconv.FormatInt(epoch, 10) != epochValues[0] ||
		epoch != *service.readAuthorityRoutingEpoch || buildValues[0] != service.buildSHA ||
		tenantValues[0] != service.readAuthorityTenantID {
		writeFailure(w, http.StatusConflict, errorAuthorityRouteMismatch, "graph authority routing binding did not match")
		return 0, false
	}
	return epoch, true
}

func cloneRequestPath(request *http.Request, path string) *http.Request {
	clone := request.Clone(request.Context())
	urlCopy := *request.URL
	urlCopy.Path = path
	clone.URL = &urlCopy
	return clone
}

func (service *Service) handleAuthoritySnapshotIngest(w http.ResponseWriter, request *http.Request) {
	if _, ok := service.requireAuthorityBinding(w, request); !ok {
		return
	}
	service.handleSnapshotIngest(w, cloneRequestPath(request, RouteSnapshotIngest))
}

func (service *Service) handleAuthorityDeltaIngest(w http.ResponseWriter, request *http.Request) {
	if _, ok := service.requireAuthorityBinding(w, request); !ok {
		return
	}
	service.handleDeltaIngest(w, cloneRequestPath(request, RouteDeltaIngest))
}

func (service *Service) handleAuthorityQuery(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	epoch, ok := service.requireAuthorityBinding(w, request)
	if !ok {
		return
	}
	value, err := readStrictJSON(request)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	input, err := decodeQuery(value)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	current, err := service.store.CurrentSnapshot(ctx, input.ScenarioInstanceID)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	result, err := graph.Query(current.Snapshot, input, graph.QueryOptions{
		CursorSecret:         append([]byte(nil), service.cursorSecret...),
		PreviousCursorSecret: append([]byte(nil), service.previousCursorSecret...),
		RoutingEpoch:         &epoch,
		NowMS:                service.clock.Now().UnixMilli(),
	})
	if err != nil {
		writeCanaryQueryError(w, service.logger, err, service.counters)
		return
	}
	if !writeCanonical(w, http.StatusOK, graph.Object{
		"schema": AuthorityReadSchema, "operation": "query", "backend": "go",
		"routingEpoch": float64(epoch), "serviceBuildSha": service.buildSHA,
		"generatedAt": current.Snapshot.GeneratedAt, "snapshotCursor": current.Snapshot.Cursor,
		"result": graph.QueryResultValue(result),
	}) {
		writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "graph response exceeds a frozen service limit")
	}
}

func (service *Service) handleAuthorityExplain(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	epoch, ok := service.requireAuthorityBinding(w, request)
	if !ok {
		return
	}
	value, err := readStrictJSON(request)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	input, err := decodeExplain(value)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	current, err := service.store.CurrentSnapshot(ctx, input.ScenarioInstanceID)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	result, err := graph.Explain(current.Snapshot, input)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	if !writeCanonical(w, http.StatusOK, graph.Object{
		"schema": AuthorityReadSchema, "operation": "explain", "backend": "go",
		"routingEpoch": float64(epoch), "serviceBuildSha": service.buildSHA,
		"generatedAt": current.Snapshot.GeneratedAt, "snapshotCursor": current.Snapshot.Cursor,
		"result": graph.ExplanationValue(result),
	}) {
		writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "graph response exceeds a frozen service limit")
	}
}

func (service *Service) handleScenarios(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	scenarios, err := service.store.ListScenarios(ctx)
	if err != nil {
		writeMappedError(w, service.logger, err, "", service.counters)
		return
	}
	sort.Slice(scenarios, func(left, right int) bool {
		return utf16Less(
			scenarios[left].ScenarioInstanceID,
			scenarios[right].ScenarioInstanceID,
		)
	})
	items := make(graph.Array, len(scenarios))
	for index, scenario := range scenarios {
		if !validScenario(scenario) {
			service.logger.Error("graph_store_invalid_scenario_projection")
			writeFailure(w, http.StatusInternalServerError, errorInternal, "internal graph service failure")
			return
		}
		items[index] = graph.Object{
			"scenarioInstanceId":    scenario.ScenarioInstanceID,
			"cursor":                scenario.Cursor,
			"snapshotIntegrityHash": scenario.SnapshotIntegrityHash,
			"revision":              float64(scenario.Revision),
			"generatedAt":           scenario.GeneratedAt,
		}
	}
	body, err := graph.CanonicalJSON(graph.Object{
		"schema":    "openslack.graph_scenario_list.v1",
		"scenarios": items,
	})
	if err != nil {
		service.logger.Error("graph_scenario_list_encode_failed")
		writeFailure(w, http.StatusInternalServerError, errorInternal, "internal graph service failure")
		return
	}
	if !writeCanonicalBytes(w, http.StatusOK, body) {
		writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "graph scenario list exceeds a frozen response limit")
	}
}

func utf16Less(left, right string) bool {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	limit := len(leftUnits)
	if len(rightUnits) < limit {
		limit = len(rightUnits)
	}
	for index := 0; index < limit; index++ {
		if leftUnits[index] != rightUnits[index] {
			return leftUnits[index] < rightUnits[index]
		}
	}
	return len(leftUnits) < len(rightUnits)
}

func (service *Service) handleLive(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	writeCanonical(w, http.StatusOK, graph.Object{"status": "live"})
}

func (service *Service) handleReady(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	if err := service.store.CheckReady(ctx); err != nil {
		writeCanonical(w, http.StatusServiceUnavailable, graph.Object{"status": "not_ready"})
		return
	}
	writeCanonical(w, http.StatusOK, graph.Object{"status": "ready"})
}

func (service *Service) handleVersion(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	writeCanonical(w, http.StatusOK, graph.Object{
		"schema":          "openslack.graph_service_version.v1",
		"buildSha":        service.buildSHA,
		"contractVersion": "v1",
	})
}

func (service *Service) handleMetrics(w http.ResponseWriter, request *http.Request) {
	if !service.requireNoQuery(w, request) {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	metrics, err := service.store.Metrics(ctx)
	if err != nil || !validStoreMetrics(metrics) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("metrics unavailable\n"))
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(service.counters.render(metrics))
}

func (service *Service) requireNoQuery(w http.ResponseWriter, request *http.Request) bool {
	if request.URL.RawQuery == "" {
		return true
	}
	writeFailure(w, http.StatusUnprocessableEntity, errorUnprocessable, "query parameters are not accepted")
	return false
}

func (service *Service) requireIdempotencyKey(w http.ResponseWriter, request *http.Request) (string, bool) {
	values := request.Header.Values("Idempotency-Key")
	if len(values) != 1 || !idempotencyKeyPattern.MatchString(values[0]) {
		writeFailure(w, http.StatusUnprocessableEntity, errorUnprocessable, "Idempotency-Key must be one bounded canonical header value")
		return "", false
	}
	return values[0], true
}

func requestFingerprint(method, path string, normalized graph.Value) (string, error) {
	body, err := graph.CanonicalJSON(normalized)
	if err != nil {
		return "", err
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte(method))
	_, _ = digest.Write([]byte{'\n'})
	_, _ = digest.Write([]byte(path))
	_, _ = digest.Write([]byte{'\n'})
	_, _ = digest.Write(body)
	return "sha256:" + hex.EncodeToString(digest.Sum(nil)), nil
}

func (service *Service) writeAmbiguousReceipt(w http.ResponseWriter, err error, operation, key, fingerprint string) bool {
	var storeFailure *StoreError
	if !errors.As(err, &storeFailure) || storeFailure.Code != StoreAmbiguous {
		return false
	}
	if storeFailure.Receipt == nil {
		service.logger.Error("graph_store_ambiguous_without_receipt")
		writeFailure(w, http.StatusInternalServerError, errorInternal, "internal graph service failure")
		return true
	}
	service.writeReceipt(w, *storeFailure.Receipt, operation, key, fingerprint)
	return true
}

func (service *Service) writeReceipt(w http.ResponseWriter, receipt Receipt, operation, key, fingerprint string) {
	if !validateReceipt(receipt, operation) ||
		receipt.IdempotencyKey != key ||
		receipt.RequestFingerprint != fingerprint {
		service.logger.Error("graph_store_invalid_receipt", "operation", operation)
		writeFailure(w, http.StatusInternalServerError, errorInternal, "internal graph service failure")
		return
	}
	service.counters.recordIngest(operation, receipt.Status)
	writeCanonical(w, receiptHTTPStatus(receipt.Status), receiptValue(receipt))
}

func validScenario(value Scenario) bool {
	if !boundedIdentifier(value.ScenarioInstanceID) ||
		!boundedIdentifier(value.Cursor) ||
		!integrityPattern.MatchString(value.SnapshotIntegrityHash) ||
		value.Revision < 1 ||
		value.Revision > maxSafeJSONInteger {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, value.GeneratedAt)
	return err == nil
}

func validStoreMetrics(value StoreMetrics) bool {
	if value.PublishedScenarios < 0 ||
		value.PublishedHeadRevisionMax < 0 ||
		value.ReconciliationPending < 0 ||
		value.ShadowBacklog != nil && *value.ShadowBacklog < 0 ||
		value.ShadowLagSeconds != nil &&
			(*value.ShadowLagSeconds < 0 ||
				math.IsNaN(*value.ShadowLagSeconds) ||
				math.IsInf(*value.ShadowLagSeconds, 0)) ||
		value.ParityMismatchesTotal != nil && *value.ParityMismatchesTotal < 0 {
		return false
	}
	return true
}

func writeCanonicalBytes(w http.ResponseWriter, status int, body []byte) bool {
	if len(body) > MaxResponseBodyBytes {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
	return true
}
