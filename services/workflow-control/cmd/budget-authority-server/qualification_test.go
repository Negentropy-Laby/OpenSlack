package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	budgetpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

const (
	qualificationBearer    = "openslack-workflow-budget-gs9e-local-qualification"
	qualificationRunID     = "run-gs9e-budget"
	qualificationAccountID = "account-gs9e-budget"
)

var qualificationFixture = mustLoadQualificationFixture()
var qualificationBuildSHA = qualificationFixture["WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA"]
var qualificationPolicySHA = qualificationFixture["WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH"]
var qualificationCaller = qualificationFixture["WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID"]
var qualificationWorkspace = qualificationFixture["WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID"]
var qualificationEpoch = mustFixtureInt64("WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH")
var qualificationSeed = budgetstore.QualificationSeed{
	PolicyHash: qualificationPolicySHA,
	Limit: budgetstore.Quantities{
		Tokens:  qualificationFixture["WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS"],
		NanoUSD: qualificationFixture["WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD"],
		Calls:   qualificationFixture["WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS"],
	},
}

func mustLoadQualificationFixture() map[string]string {
	expected := []string{
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS",
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "gs9e-qualification.conf"))
	if err != nil {
		panic(err)
	}
	values := make(map[string]string, len(expected))
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || key == "" || value == "" || values[key] != "" {
			panic("GS9-E qualification fixture is malformed")
		}
		values[key] = value
	}
	if len(values) != len(expected) {
		panic("GS9-E qualification fixture is not closed")
	}
	for _, key := range expected {
		if values[key] == "" {
			panic("GS9-E qualification fixture is missing " + key)
		}
	}
	return values
}

func mustFixtureInt64(key string) int64 {
	value, err := strconv.ParseInt(qualificationFixture[key], 10, 64)
	if err != nil {
		panic(err)
	}
	return value
}

func TestGS9EQualification(t *testing.T) {
	if os.Getenv("WORKFLOW_CONTROL_GS9E_QUALIFICATION") != "1" {
		t.Skip("GS9-E2 PostgreSQL qualification is not enabled")
	}
	pool := testsupport.OpenPostgres(t)
	seedQualificationRun(t, pool, 4)
	service := qualificationService(t, budgetpostgres.New(pool))
	body := qualificationReserveBody(t, 0, 4, "1", "600")
	first := qualificationMutation(t, service.Handler(), "reserve", body)
	replay := qualificationMutation(t, service.Handler(), "reserve", body)
	if first.Code != http.StatusCreated || replay.Code != http.StatusOK || first.Body.String() != replay.Body.String() ||
		replay.Header().Get(budgetapp.HeaderReplay) != "true" || !strings.Contains(first.Body.String(), `"status":"reserved"`) ||
		!strings.Contains(first.Body.String(), `"status":"accepted"`) {
		t.Fatalf("reserve/replay drift: first=%d %s replay=%d %s", first.Code, first.Body.String(), replay.Code, replay.Body.String())
	}
	prepared := qualificationPrepared(t, "reserve", body)
	for label, path := range map[string]string{
		"account":     "/v1/authority/workflow-budgets/runs/" + qualificationRunID + "/account",
		"reservation": "/v1/authority/workflow-budgets/runs/" + qualificationRunID + "/reservations/reservation-1",
		"receipt":     "/v1/authority/workflow-budgets/receipts/" + prepared.IdempotencyKey,
	} {
		response := qualificationRead(t, service.Handler(), path)
		if response.Code != http.StatusOK {
			t.Fatalf("%s read failed: %d %s", label, response.Code, response.Body.String())
		}
	}
	reservation := qualificationRead(t, service.Handler(), "/v1/authority/workflow-budgets/runs/"+qualificationRunID+"/reservations/reservation-1")
	if !strings.Contains(reservation.Body.String(), `"status":"open"`) || !strings.Contains(reservation.Body.String(), `"terminalLedgerEntryId":null`) {
		t.Fatalf("open reservation read drifted: %s", reservation.Body.String())
	}
	reserveResponse, err := budgetstore.DecodeMutationResponse(first.Body.Bytes())
	if err != nil || reserveResponse.Record == nil {
		t.Fatalf("decode reserve response: %v", err)
	}
	decisionHash, err := budgetcontract.HashValue("reserve-decision", reserveResponse.Record.OperationalProjection)
	if err != nil {
		t.Fatal(err)
	}
	settlementBody := qualificationSettlementBody(t, 1, 5, decisionHash, reserveResponse.Receipt.OperationalProjection["committedAt"].(string))
	settlement := qualificationMutation(t, service.Handler(), "settle", settlementBody)
	if settlement.Code != http.StatusCreated || !strings.Contains(settlement.Body.String(), `"status":"settled"`) ||
		!strings.Contains(settlement.Body.String(), `"status":"accepted"`) {
		t.Fatalf("settlement drifted: %d %s", settlement.Code, settlement.Body.String())
	}
	closedReservation := qualificationRead(t, service.Handler(), "/v1/authority/workflow-budgets/runs/"+qualificationRunID+"/reservations/reservation-1")
	if closedReservation.Code != http.StatusOK || !strings.Contains(closedReservation.Body.String(), `"status":"settled"`) ||
		strings.Contains(closedReservation.Body.String(), `"terminalLedgerEntryId":null`) || strings.Contains(closedReservation.Body.String(), `"closedAt":null`) {
		t.Fatalf("settled reservation read drifted: %d %s", closedReservation.Code, closedReservation.Body.String())
	}
	settlementPrepared := qualificationPrepared(t, "settle", settlementBody)
	settlementReceipt := qualificationRead(t, service.Handler(), "/v1/authority/workflow-budgets/receipts/"+settlementPrepared.IdempotencyKey)
	if settlementReceipt.Code != http.StatusOK || settlementReceipt.Body.String() != settlement.Body.String() {
		t.Fatalf("settlement receipt read drifted: %d %s", settlementReceipt.Code, settlementReceipt.Body.String())
	}
	ready := qualificationReadUnprotected(t, service.Handler(), budgetapp.RouteReady)
	metrics := qualificationRead(t, service.Handler(), budgetapp.RouteMetrics)
	metricValues := qualificationMetricValues(t, metrics.Body.String())
	if ready.Code != http.StatusOK || metrics.Code != http.StatusOK || len(metricValues) != len(budgetapp.MetricNames()) {
		t.Fatalf("qualification probe drift: ready=%d %s metrics=%d %s", ready.Code, ready.Body.String(), metrics.Code, metrics.Body.String())
	}
}

func TestGS9ERestartQualification(t *testing.T) {
	phase := os.Getenv("WORKFLOW_CONTROL_GS9E_RESTART_PHASE")
	if phase == "" {
		t.Skip("GS9-E2 restart qualification is not enabled")
	}
	schema := os.Getenv("WORKFLOW_CONTROL_GS9E_RESTART_SCHEMA")
	body := qualificationReserveBody(t, 0, 4, "restart", "600")
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		seedQualificationRun(t, pool, 4)
		response := qualificationMutation(t, qualificationService(t, budgetpostgres.New(pool)).Handler(), "reserve", body)
		if response.Code != http.StatusCreated {
			t.Fatalf("restart seed failed: %d %s", response.Code, response.Body.String())
		}
		pool.Close()
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		repository := budgetpostgres.New(pool)
		service := qualificationService(t, repository)
		replay := qualificationMutation(t, service.Handler(), "reserve", body)
		if replay.Code != http.StatusOK || replay.Header().Get(budgetapp.HeaderReplay) != "true" || !strings.Contains(replay.Body.String(), `"status":"reserved"`) {
			t.Fatalf("restart replay failed: %d %s", replay.Code, replay.Body.String())
		}
		rebuilt, err := repository.RebuildAccount(context.Background(), qualificationWorkspace, qualificationRunID)
		head, headErr := repository.ReadAccount(context.Background(), qualificationWorkspace, qualificationRunID)
		if err != nil || headErr != nil || rebuilt.RecordHash != head.RecordHash || !bytes.Equal(rebuilt.ExactBytes, head.ExactBytes) {
			t.Fatalf("restart ledger fold=%#v head=%#v err=%v headErr=%v", rebuilt, head, err, headErr)
		}
		account := qualificationRead(t, service.Handler(), "/v1/authority/workflow-budgets/runs/"+qualificationRunID+"/account")
		metrics := qualificationRead(t, service.Handler(), budgetapp.RouteMetrics)
		metricValues := qualificationMetricValues(t, metrics.Body.String())
		if account.Code != http.StatusOK || !strings.Contains(account.Body.String(), `"accountRevision":1`) ||
			metrics.Code != http.StatusOK || metricValues["openslack_workflow_control_budget_ledger_entries"] != 1 {
			t.Fatalf("restart durable rebuild failed: account=%d %s metrics=%d %s", account.Code, account.Body.String(), metrics.Code, metrics.Body.String())
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown GS9-E2 restart phase %q", phase)
	}
}

func qualificationMetricValues(t testing.TB, body string) map[string]int64 {
	t.Helper()
	expectedNames := budgetapp.MetricNames()
	lines := strings.Split(strings.TrimSpace(body), "\n")
	if len(lines) != len(expectedNames)*2 {
		t.Fatalf("metric line count=%d, want %d: %q", len(lines), len(expectedNames)*2, body)
	}
	values := make(map[string]int64, len(expectedNames))
	for index, name := range expectedNames {
		typeFields := strings.Fields(lines[index*2])
		valueFields := strings.Fields(lines[index*2+1])
		if len(typeFields) != 4 || typeFields[0] != "#" || typeFields[1] != "TYPE" || typeFields[2] != name ||
			(typeFields[3] != "counter" && typeFields[3] != "gauge") || len(valueFields) != 2 || valueFields[0] != name {
			t.Fatalf("metric %q has invalid definition/value lines", name)
		}
		value, err := strconv.ParseInt(valueFields[1], 10, 64)
		if err != nil || value < 0 {
			t.Fatalf("metric %q value=%q err=%v", name, valueFields[1], err)
		}
		values[name] = value
	}
	return values
}

func TestGS9EImageDefaultOff(t *testing.T) {
	origin := strings.TrimRight(os.Getenv("WORKFLOW_CONTROL_GS9E_DEFAULT_ORIGIN"), "/")
	if origin == "" {
		t.Skip("GS9-E2 default-off image origin is not configured")
	}
	live := qualificationHTTPAfterStartup(t, http.MethodGet, origin+budgetapp.RouteLive, nil, nil)
	ready := qualificationHTTP(t, http.MethodGet, origin+budgetapp.RouteReady, nil, nil)
	version := qualificationHTTP(t, http.MethodGet, origin+budgetapp.RouteVersion, nil, nil)
	reserve := qualificationHTTP(t, http.MethodPost, origin+budgetapp.RouteReserve, []byte("{}\n"), map[string]string{"Content-Type": "application/json"})
	metrics := qualificationHTTP(t, http.MethodGet, origin+budgetapp.RouteMetrics, nil, nil)
	if live.status != http.StatusOK || string(live.body) != "{\"status\":\"live\"}\n" ||
		ready.status != http.StatusOK || string(ready.body) != "{\"status\":\"ready\"}\n" ||
		version.status != http.StatusOK || !strings.Contains(string(version.body), `"qualificationMode":false`) ||
		!strings.Contains(string(version.body), `"typescriptProductionWorkflowAuthority":true`) ||
		!strings.Contains(string(version.body), `"productionInitialBudgetPolicySourceDelivered":false`) ||
		reserve.status != http.StatusNotFound || metrics.status != http.StatusNotFound {
		t.Fatalf("default-off image drift: live=%d %s ready=%d %s version=%d %s reserve=%d %s metrics=%d %s",
			live.status, live.body, ready.status, ready.body, version.status, version.body,
			reserve.status, reserve.body, metrics.status, metrics.body)
	}
}

func qualificationService(t *testing.T, repository budgetstore.Repository) *budgetapp.Service {
	t.Helper()
	digest := sha256.Sum256([]byte(qualificationBearer))
	if hex.EncodeToString(digest[:]) != qualificationFixture["WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256"] {
		t.Fatal("qualification bearer digest drifted from the shared fixture")
	}
	service, err := budgetapp.New(budgetapp.Options{
		Repository: repository, QualificationMode: true, BuildSHA: qualificationBuildSHA,
		BearerTokenSHA256: hex.EncodeToString(digest[:]), WorkspaceID: qualificationWorkspace,
		CallerID: qualificationCaller, RoutingEpoch: qualificationEpoch, Seed: qualificationSeed,
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func seedQualificationRun(t testing.TB, pool *pgxpool.Pool, revision int64) {
	t.Helper()
	record := authoritystore.RunRecord{
		Schema: authoritystore.RunRecordSchema, WorkspaceID: qualificationWorkspace, RunID: qualificationRunID,
		WorkflowID: "workflow-budget-qualification", WorkflowVersion: "v1",
		WorkflowSourceHash: strings.Repeat("b", 64), ManifestHash: strings.Repeat("c", 64), InputHash: strings.Repeat("d", 64),
		Route: authoritystore.Route{Backend: budgetstore.Backend, Authority: budgetstore.Authority, RoutingEpoch: qualificationEpoch, AuthorityBuildHash: qualificationBuildSHA},
		State: authoritycontract.RunRunning, Revision: revision, ResumeGeneration: 0,
	}
	exact, err := canonicaljson.Encode(record)
	if err != nil {
		t.Fatal(err)
	}
	exact = append(exact, '\n')
	digest := sha256.Sum256(exact)
	if _, err := pool.Exec(context.Background(), `
INSERT INTO workflow_control_authority_epochs (workspace_id,routing_epoch,backend,authority,authority_build_hash)
VALUES ($1,$2,'go','workflow-control',$3);
INSERT INTO workflow_control_runs (
 workspace_id,run_id,workflow_id,workflow_version,workflow_source_hash,manifest_hash,input_hash,
 backend,authority,routing_epoch,authority_build_hash,state,revision,resume_generation,record_hash,canonical_record_bytes
) VALUES ($1,$4,$5,$6,$7,$8,$9,'go','workflow-control',$2,$3,'running',$10,0,$11,$12)`,
		qualificationWorkspace, qualificationEpoch, mustDecodeHash(qualificationBuildSHA), qualificationRunID,
		record.WorkflowID, record.WorkflowVersion, mustDecodeHash(record.WorkflowSourceHash), mustDecodeHash(record.ManifestHash),
		mustDecodeHash(record.InputHash), revision, digest[:], exact,
	); err != nil {
		t.Fatal(err)
	}
}

func qualificationReserveBody(t testing.TB, accountRevision, runRevision int64, occurrence, tokens string) []byte {
	t.Helper()
	nanoUSD, err := budgetcontract.ChargeNanoUSD(tokens, "10")
	if err != nil {
		t.Fatal(err)
	}
	request := budgetcontract.Record{
		"schema":          budgetcontract.SchemaReserveRequest,
		"contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
		"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"workspaceId": qualificationWorkspace, "runId": qualificationRunID, "accountId": qualificationAccountID,
		"reservationId": "reservation-" + occurrence, "callId": "call-" + occurrence, "providerAttempt": "1",
		"expectedProviderHash": "sha256:" + strings.Repeat("e", 64), "expectedModelHash": "sha256:" + strings.Repeat("f", 64),
		"expectedProviderRunHash": "sha256:" + strings.Repeat("1", 64), "correlationId": "correlation-" + occurrence,
		"policyHash":              qualificationSeed.PolicyHash,
		"route":                   budgetcontract.Record{"backend": budgetstore.Backend, "authority": budgetstore.Authority, "routingEpoch": qualificationEpoch, "authorityBuildHash": qualificationBuildSHA},
		"expectedAccountRevision": accountRevision, "expectedRunRevision": runRevision, "rateNanoUsdPerToken": "10",
		"requested": budgetcontract.Record{"tokens": tokens, "nanoUsd": nanoUSD, "calls": "1"}, "requestedAt": "2026-08-15T00:00:01.000Z",
	}
	prepared, err := budgetcontract.PrepareRequest("reserve", request, qualificationCaller)
	if err != nil {
		t.Fatal(err)
	}
	return []byte(prepared.Body)
}

func qualificationSettlementBody(t testing.TB, accountRevision, runRevision int64, decisionHash, requestedAt string) []byte {
	t.Helper()
	prefixedHash := "sha256:" + strings.Repeat("e", 64)
	modelHash := "sha256:" + strings.Repeat("f", 64)
	runHash := "sha256:" + strings.Repeat("1", 64)
	usage := budgetcontract.Record{
		"schema": budgetcontract.SchemaProviderUsage, "providerHash": prefixedHash, "modelHash": modelHash,
		"runHash": runHash, "attempt": "1", "calls": "1", "status": "reported",
		"inputTokens": "300", "outputTokens": "100", "totalTokens": "400",
		"outcome": "provider_response_accepted", "requestHash": "sha256:" + strings.Repeat("2", 64),
		"outcomeHash": "sha256:" + strings.Repeat("3", 64),
	}
	canonical, err := budgetcontract.CanonicalJSON(usage)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("openslack.provider-usage-receipt.v1\x00" + canonical))
	usage["receiptHash"] = "sha256:" + hex.EncodeToString(digest[:])
	usage, err = budgetcontract.ValidateProviderUsage(usage)
	if err != nil {
		t.Fatal(err)
	}
	request := budgetcontract.Record{
		"schema":          budgetcontract.SchemaSettlementRequest,
		"contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
		"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"workspaceId": qualificationWorkspace, "runId": qualificationRunID, "accountId": qualificationAccountID,
		"reservationId": "reservation-1", "callId": "call-1", "providerAttempt": "1",
		"expectedProviderHash": prefixedHash, "expectedModelHash": modelHash, "expectedProviderRunHash": runHash,
		"correlationId": "correlation-settlement", "policyHash": qualificationSeed.PolicyHash,
		"route":                   budgetcontract.Record{"backend": budgetstore.Backend, "authority": budgetstore.Authority, "routingEpoch": qualificationEpoch, "authorityBuildHash": qualificationBuildSHA},
		"expectedAccountRevision": accountRevision, "expectedRunRevision": runRevision, "reserveDecisionHash": decisionHash,
		"usageEvidenceStatus": "trusted", "usageReceiptHash": usage["receiptHash"], "providerUsage": usage,
		"rateNanoUsdPerToken": "10", "requestedAt": requestedAt,
	}
	prepared, err := budgetcontract.PrepareRequest("settle", request, qualificationCaller)
	if err != nil {
		t.Fatal(err)
	}
	return []byte(prepared.Body)
}

func qualificationPrepared(t testing.TB, operation string, body []byte) budgetcontract.PreparedRequest {
	t.Helper()
	value, err := budgetcontract.ParseBytes(body)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := budgetcontract.PrepareRequest(operation, value, qualificationCaller)
	if err != nil {
		t.Fatal(err)
	}
	return prepared
}

func qualificationMutation(t *testing.T, handler http.Handler, operation string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	path := budgetapp.RouteReserve
	if operation == "settle" {
		path = budgetapp.RouteSettle
	}
	prepared := qualificationPrepared(t, operation, body)
	headers := qualificationHeaders()
	headers["Content-Type"] = "application/json"
	headers["Idempotency-Key"] = prepared.IdempotencyKey
	headers[budgetapp.HeaderFingerprint] = prepared.RequestFingerprint
	return qualificationHandler(t, handler, http.MethodPost, path, body, headers)
}

func qualificationRead(t *testing.T, handler http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	return qualificationHandler(t, handler, http.MethodGet, path, nil, qualificationHeaders())
}

func qualificationReadUnprotected(t *testing.T, handler http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	return qualificationHandler(t, handler, http.MethodGet, path, nil, nil)
}

func qualificationHeaders() map[string]string {
	return map[string]string{
		"Authorization":          "Bearer " + qualificationBearer,
		budgetapp.HeaderCallerID: qualificationCaller, budgetapp.HeaderWorkspaceID: qualificationWorkspace,
		budgetapp.HeaderRoutingEpoch: strconv.FormatInt(qualificationEpoch, 10), budgetapp.HeaderExpectedBuildSHA: qualificationBuildSHA,
	}
}

func qualificationHandler(t *testing.T, handler http.Handler, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func mustDecodeHash(value string) []byte {
	decoded, err := hex.DecodeString(value)
	if err != nil {
		panic(err)
	}
	return decoded
}

type qualificationHTTPResult struct {
	status int
	body   []byte
	header http.Header
}

func qualificationHTTP(t *testing.T, method, url string, body []byte, headers map[string]string) qualificationHTTPResult {
	t.Helper()
	result, err := qualificationHTTPAttempt(method, url, body, headers, 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func qualificationHTTPAfterStartup(t *testing.T, method, url string, body []byte, headers map[string]string) qualificationHTTPResult {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatal("budget authority image did not accept connections within 15s")
		}
		result, err := qualificationHTTPAttempt(method, url, body, headers, min(remaining, time.Second))
		if err == nil {
			return result
		}
		var networkError *net.OpError
		if !errors.As(err, &networkError) {
			t.Fatalf("budget authority startup request failed: %v", err)
		}
		time.Sleep(min(100*time.Millisecond, remaining))
	}
}

func qualificationHTTPAttempt(method, url string, body []byte, headers map[string]string, timeout time.Duration) (qualificationHTTPResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return qualificationHTTPResult{}, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := (&http.Client{Timeout: timeout}).Do(request)
	if err != nil {
		return qualificationHTTPResult{}, err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return qualificationHTTPResult{}, err
	}
	return qualificationHTTPResult{status: response.StatusCode, body: responseBody, header: response.Header.Clone()}, nil
}
