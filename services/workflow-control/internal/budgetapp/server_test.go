package budgetapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
)

const (
	testBuildSHA           = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testWorkspace          = "workspace.demo"
	testCaller             = "typescript:workflow-budget-qualification"
	testBearer             = "openslack-workflow-budget-gs9e-local-qualification"
	testRunID              = "run-gs9e-budget"
	testRoutingEpoch int64 = 9
)

type fakeRepository struct {
	reserve         func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error)
	settle          func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error)
	readAccount     func(context.Context, string, string) (budgetstore.Account, error)
	readReservation func(context.Context, string, string, string) (budgetstore.Reservation, error)
	readReceipt     func(context.Context, string, string) (budgetstore.Receipt, error)
	ready           func(context.Context) error
	statistics      func(context.Context) (budgetstore.Statistics, error)
}

func (repository *fakeRepository) Reserve(ctx context.Context, input budgetstore.MutationInput) (budgetstore.MutationResult, error) {
	if repository.reserve == nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorNotFound, "reserve", nil)
	}
	return repository.reserve(ctx, input)
}
func (repository *fakeRepository) Settle(ctx context.Context, input budgetstore.MutationInput) (budgetstore.MutationResult, error) {
	if repository.settle == nil {
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorNotFound, "settle", nil)
	}
	return repository.settle(ctx, input)
}
func (repository *fakeRepository) ReadAccount(ctx context.Context, workspace, run string) (budgetstore.Account, error) {
	if repository.readAccount == nil {
		return budgetstore.Account{}, budgetstore.Failure(budgetstore.ErrorNotFound, "read account", nil)
	}
	return repository.readAccount(ctx, workspace, run)
}
func (repository *fakeRepository) ReadReservation(ctx context.Context, workspace, run, reservation string) (budgetstore.Reservation, error) {
	if repository.readReservation == nil {
		return budgetstore.Reservation{}, budgetstore.Failure(budgetstore.ErrorNotFound, "read reservation", nil)
	}
	return repository.readReservation(ctx, workspace, run, reservation)
}
func (repository *fakeRepository) ReadReceipt(ctx context.Context, workspace, key string) (budgetstore.Receipt, error) {
	if repository.readReceipt == nil {
		return budgetstore.Receipt{}, budgetstore.Failure(budgetstore.ErrorNotFound, "read receipt", nil)
	}
	return repository.readReceipt(ctx, workspace, key)
}
func (repository *fakeRepository) Ready(ctx context.Context) error {
	if repository.ready != nil {
		return repository.ready(ctx)
	}
	return nil
}
func (repository *fakeRepository) Statistics(ctx context.Context) (budgetstore.Statistics, error) {
	if repository.statistics != nil {
		return repository.statistics(ctx)
	}
	return budgetstore.Statistics{}, nil
}

func TestBudgetServiceDefaultsToHealthOnlyWithoutMetrics(t *testing.T) {
	service, err := New(Options{BuildSHA: strings.Repeat("0", 64)})
	if err != nil {
		t.Fatal(err)
	}
	for path, body := range map[string]string{RouteLive: "{\"status\":\"live\"}\n", RouteReady: "{\"status\":\"ready\"}\n"} {
		response := perform(t, service.Handler(), http.MethodGet, path, nil, nil)
		if response.Code != http.StatusOK || response.Body.String() != body {
			t.Fatalf("disabled health %s drifted: %d %s", path, response.Code, response.Body.String())
		}
	}
	version := perform(t, service.Handler(), http.MethodGet, RouteVersion, nil, nil)
	if version.Code != http.StatusOK || !strings.Contains(version.Body.String(), `"typescriptProductionWorkflowAuthority":true`) ||
		!strings.Contains(version.Body.String(), `"goBudgetAuthority":"qualification-only"`) ||
		!strings.Contains(version.Body.String(), `"productionBudgetAuthority":false`) ||
		!strings.Contains(version.Body.String(), `"qualificationSeedConfigured":false`) ||
		!strings.Contains(version.Body.String(), `"productionInitialBudgetPolicySourceDelivered":false`) ||
		!strings.Contains(version.Body.String(), `"runnerProtocolV2Delivered":false`) ||
		!strings.Contains(version.Body.String(), `"routingActivated":false`) ||
		!strings.Contains(version.Body.String(), `"canaryActivated":false`) ||
		!strings.Contains(version.Body.String(), `"cutoverActivated":false`) {
		t.Fatalf("disabled version drifted: %d %s", version.Code, version.Body.String())
	}
	for _, path := range []string{RouteReserve, RouteSettle, RouteMetrics, "/v1/authority/workflow-budgets/runs/run/account"} {
		response := perform(t, service.Handler(), map[bool]string{true: http.MethodPost, false: http.MethodGet}[path == RouteReserve || path == RouteSettle], path, nil, nil)
		if response.Code != http.StatusNotFound {
			t.Fatalf("disabled service exposed %s: %d %s", path, response.Code, response.Body.String())
		}
	}
}

func TestBudgetServiceRejectsIncompleteComposition(t *testing.T) {
	if _, err := New(Options{BuildSHA: testBuildSHA, QualificationMode: true}); err == nil {
		t.Fatal("qualification service accepted missing bindings")
	}
	if _, err := New(Options{BuildSHA: testBuildSHA, Repository: &fakeRepository{}}); err == nil {
		t.Fatal("disabled service retained a repository")
	}
}

func TestBudgetServicePinsBearerAndAllQualificationBindings(t *testing.T) {
	repository := &fakeRepository{reserve: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
		t.Fatal("repository must not be called for invalid identity")
		return budgetstore.MutationResult{}, nil
	}}
	service := newQualificationService(t, repository)
	body := reserveBody(t, "100")
	headers := mutationHeaders(t, "reserve", body, false)
	if response := perform(t, service.Handler(), http.MethodPost, RouteReserve, body, headers); response.Code != http.StatusUnauthorized {
		t.Fatalf("missing bearer status=%d body=%s", response.Code, response.Body.String())
	}
	headers = mutationHeaders(t, "reserve", body, true)
	headers[HeaderWorkspaceID] = "workspace.other"
	if response := perform(t, service.Handler(), http.MethodPost, RouteReserve, body, headers); response.Code != http.StatusUnauthorized {
		t.Fatalf("workspace drift status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestBudgetServiceEnforcesCanonicalContentAndExactHeaders(t *testing.T) {
	service := newQualificationService(t, &fakeRepository{reserve: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
		t.Fatal("repository must not be called")
		return budgetstore.MutationResult{}, nil
	}})
	body := reserveBody(t, "100")
	for name, mutate := range map[string]func([]byte, map[string]string) ([]byte, map[string]string){
		"content type": func(body []byte, headers map[string]string) ([]byte, map[string]string) {
			headers["Content-Type"] = "application/json; charset=utf-8"
			return body, headers
		},
		"fingerprint": func(body []byte, headers map[string]string) ([]byte, map[string]string) {
			headers[HeaderFingerprint] = "sha256:" + strings.Repeat("b", 64)
			return body, headers
		},
		"noncanonical": func(body []byte, headers map[string]string) ([]byte, map[string]string) {
			return append([]byte(" "), body...), headers
		},
	} {
		t.Run(name, func(t *testing.T) {
			headers := mutationHeaders(t, "reserve", body, true)
			candidate, headers := mutate(append([]byte(nil), body...), headers)
			response := perform(t, service.Handler(), http.MethodPost, RouteReserve, candidate, headers)
			want := http.StatusUnprocessableEntity
			if name == "content type" {
				want = http.StatusUnsupportedMediaType
			}
			if response.Code != want {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestBudgetServiceReturnsClosedExactOriginalResponseOnReplay(t *testing.T) {
	body := reserveBody(t, "100")
	result := reserveResult(t, body, "100")
	calls := 0
	repository := &fakeRepository{reserve: func(_ context.Context, input budgetstore.MutationInput) (budgetstore.MutationResult, error) {
		calls++
		if input.Prepared.Body != string(body) || input.ServiceBuildHash != testBuildSHA {
			t.Fatalf("mutation input drifted: %+v", input)
		}
		copy := result
		copy.Replay = calls > 1
		return copy, nil
	}}
	service := newQualificationService(t, repository)
	headers := mutationHeaders(t, "reserve", body, true)
	first := perform(t, service.Handler(), http.MethodPost, RouteReserve, body, headers)
	replay := perform(t, service.Handler(), http.MethodPost, RouteReserve, body, headers)
	if first.Code != http.StatusCreated || replay.Code != http.StatusOK || first.Body.String() != replay.Body.String() ||
		replay.Header().Get(HeaderReplay) != "true" || !strings.Contains(first.Body.String(), `"schema":"openslack.workflow_control_budget_mutation_response.v1"`) ||
		!strings.Contains(first.Body.String(), `"status":"reserved"`) || !strings.Contains(first.Body.String(), `"status":"accepted"`) {
		t.Fatalf("exact replay drifted: first=%d %s replay=%d %s", first.Code, first.Body.String(), replay.Code, replay.Body.String())
	}
}

func TestBudgetServiceFreshRejectedReserveStillReturnsDurableCreatedResponse(t *testing.T) {
	body := reserveBody(t, "0")
	result := reserveResult(t, body, "0")
	service := newQualificationService(t, &fakeRepository{reserve: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
		return result, nil
	}})
	response := perform(t, service.Handler(), http.MethodPost, RouteReserve, body, mutationHeaders(t, "reserve", body, true))
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"status":"rejected"`) || !strings.Contains(response.Body.String(), `"status":"accepted"`) {
		t.Fatalf("durable rejection drifted: %d %s", response.Code, response.Body.String())
	}
}

func TestBudgetServiceClassifiesAllClosedFreshMutationStatuses(t *testing.T) {
	record := func(status string) *budgetstore.DurableRecord {
		return &budgetstore.DurableRecord{OperationalProjection: budgetcontract.Record{"status": status}}
	}
	receipt := func(status string) budgetstore.DurableRecord {
		return budgetstore.DurableRecord{OperationalProjection: budgetcontract.Record{"status": status}}
	}
	for name, test := range map[string]struct {
		operation string
		response  budgetstore.MutationResponse
		want      freshMutationOutcome
	}{
		"reserved":                {"reserve", budgetstore.MutationResponse{Record: record("reserved"), Receipt: receipt("accepted")}, freshReserveReserved},
		"rejected":                {"reserve", budgetstore.MutationResponse{Record: record("rejected"), Receipt: receipt("accepted")}, freshReserveRejected},
		"settled":                 {"settle", budgetstore.MutationResponse{Record: record("settled"), Receipt: receipt("accepted")}, freshSettlementSettled},
		"provider reconciliation": {"settle", budgetstore.MutationResponse{Record: record("reconciliation_required"), Receipt: receipt("provider_reconciliation_required")}, freshProviderReconciliation},
		"database reconciliation": {"reserve", budgetstore.MutationResponse{Receipt: receipt("database_reconciliation_required")}, freshDatabaseReconciliation},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := classifyFreshMutation(test.operation, test.response)
			if err != nil || got != test.want {
				t.Fatalf("fresh mutation classification drifted: got=%q err=%v want=%q", got, err, test.want)
			}
		})
	}
	if _, err := classifyFreshMutation("reserve", budgetstore.MutationResponse{Record: record("settled"), Receipt: receipt("accepted")}); err == nil {
		t.Fatal("invalid operation/status combination was accepted")
	}
}

func TestBudgetServiceReadEndpointsReturnExactDurableRecords(t *testing.T) {
	body := reserveBody(t, "100")
	result := reserveResult(t, body, "100")
	accountValue := result.Record["afterAccount"].(budgetcontract.Record)
	reservation := reservationForDecision(t, result.Record)
	repository := &fakeRepository{
		readAccount: func(_ context.Context, workspace, run string) (budgetstore.Account, error) {
			if workspace != testWorkspace || run != testRunID {
				t.Fatal("account identity drifted")
			}
			outer := durableRecord(t, budgetstore.RecordKindAccount, accountValue)
			return budgetstore.Account{Value: accountValue, Durable: outer, ExactBytes: durableBytes(t, outer)}, nil
		},
		readReservation: func(_ context.Context, workspace, run, id string) (budgetstore.Reservation, error) {
			if workspace != testWorkspace || run != testRunID || id != "reservation-1" {
				t.Fatal("reservation identity drifted")
			}
			outer := durableRecord(t, budgetstore.RecordKindReservation, reservation)
			return budgetstore.Reservation{Value: reservation, Durable: outer, ExactBytes: durableBytes(t, outer), Status: "open"}, nil
		},
		readReceipt: func(_ context.Context, workspace, key string) (budgetstore.Receipt, error) {
			if workspace != testWorkspace || key != result.Receipt["idempotencyKey"] {
				t.Fatal("receipt identity drifted")
			}
			return budgetstore.Receipt{Value: result.Receipt, Durable: result.DurableReceipt, Response: result.Response, ExactReceiptBytes: result.ExactReceiptBytes, ExactResponseBytes: result.ExactResponseBytes, ReceiptID: result.ReceiptID}, nil
		},
	}
	service := newQualificationService(t, repository)
	headers := readHeaders()
	paths := []string{
		"/v1/authority/workflow-budgets/runs/" + testRunID + "/account",
		"/v1/authority/workflow-budgets/runs/" + testRunID + "/reservations/reservation-1",
		"/v1/authority/workflow-budgets/receipts/" + result.Receipt["idempotencyKey"].(string),
	}
	for _, path := range paths {
		response := perform(t, service.Handler(), http.MethodGet, path, nil, headers)
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("read %s failed: %d %s", path, response.Code, response.Body.String())
		}
		if strings.HasSuffix(path, "/account") {
			want := append(durableBytes(t, durableRecord(t, budgetstore.RecordKindAccount, accountValue)), '\n')
			if !bytes.Equal(response.Body.Bytes(), want) {
				t.Fatalf("account read did not return exact canonical LF bytes")
			}
		}
	}
}

func TestBudgetServiceMapsStableStoreErrors(t *testing.T) {
	for code, want := range map[budgetstore.ErrorCode]int{
		budgetstore.ErrorInputInvalid:        http.StatusUnprocessableEntity,
		budgetstore.ErrorContentInvalid:      http.StatusUnprocessableEntity,
		budgetstore.ErrorConflict:            http.StatusConflict,
		budgetstore.ErrorIdempotencyConflict: http.StatusConflict,
		budgetstore.ErrorReconciliation:      http.StatusConflict,
		budgetstore.ErrorNotFound:            http.StatusNotFound,
		budgetstore.ErrorIntegrity:           http.StatusInternalServerError,
		budgetstore.ErrorDatabase:            http.StatusServiceUnavailable,
		budgetstore.ErrorCommitUnknown:       http.StatusInternalServerError,
	} {
		t.Run(string(code), func(t *testing.T) {
			service := newQualificationService(t, &fakeRepository{reserve: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
				return budgetstore.MutationResult{}, budgetstore.Failure(code, "test", errors.New("cause must not leak"))
			}})
			body := reserveBody(t, "100")
			response := perform(t, service.Handler(), http.MethodPost, RouteReserve, body, mutationHeaders(t, "reserve", body, true))
			if response.Code != want || !strings.Contains(response.Body.String(), `"code":"`+string(code)+`"`) || strings.Contains(response.Body.String(), "cause must not leak") {
				t.Fatalf("mapping drifted: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestBudgetQualificationRouteDriftReturnsRepositoryConflict(t *testing.T) {
	called := false
	service := newQualificationService(t, &fakeRepository{reserve: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
		called = true
		return budgetstore.MutationResult{}, budgetstore.Failure(budgetstore.ErrorConflict, "active route drifted", nil)
	}})
	request := reserveRequest("100")
	delete(request, "_testLimit")
	request["route"].(budgetcontract.Record)["routingEpoch"] = testRoutingEpoch + 1
	prepared, err := budgetcontract.PrepareRequest("reserve", request, testCaller)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(prepared.Body)
	response := perform(t, service.Handler(), http.MethodPost, RouteReserve, body, mutationHeaders(t, "reserve", body, true))
	if response.Code != http.StatusConflict || !called || !strings.Contains(response.Body.String(), `"code":"`+string(budgetstore.ErrorConflict)+`"`) {
		t.Fatalf("route drift response=%d %s called=%t", response.Code, response.Body.String(), called)
	}
}

func TestBudgetQualificationExactReplaySurvivesActiveBuildDrift(t *testing.T) {
	body := reserveBody(t, "100")
	stored := reserveResult(t, body, "100")
	stored.Replay = true
	activeBuild := strings.Repeat("9", 64)
	repository := &fakeRepository{reserve: func(_ context.Context, input budgetstore.MutationInput) (budgetstore.MutationResult, error) {
		if input.ServiceBuildHash != activeBuild {
			t.Fatalf("active service build was not passed to repository: %s", input.ServiceBuildHash)
		}
		return stored, nil
	}}
	bearerDigest := sha256.Sum256([]byte(testBearer))
	service, err := New(Options{
		Repository: repository, QualificationMode: true, BuildSHA: activeBuild,
		BearerTokenSHA256: hex.EncodeToString(bearerDigest[:]), WorkspaceID: testWorkspace,
		CallerID: testCaller, RoutingEpoch: testRoutingEpoch,
		Seed: budgetstore.QualificationSeed{PolicyHash: strings.Repeat("8", 64), Limit: budgetstore.Quantities{Tokens: "100", NanoUSD: "100", Calls: "100"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	headers := mutationHeaders(t, "reserve", body, true)
	headers[HeaderExpectedBuildSHA] = activeBuild
	response := perform(t, service.Handler(), http.MethodPost, RouteReserve, body, headers)
	if response.Code != http.StatusOK || response.Header().Get(HeaderReplay) != "true" || !bytes.Equal(response.Body.Bytes(), stored.ExactResponseBytes) {
		t.Fatalf("build-drift replay=%d %s", response.Code, response.Body.String())
	}
}

func TestBudgetQualificationReadinessIsLightweightAndMetricsAreTyped(t *testing.T) {
	readyCalls := 0
	repository := &fakeRepository{
		ready: func(context.Context) error { readyCalls++; return nil },
		statistics: func(context.Context) (budgetstore.Statistics, error) {
			return budgetstore.Statistics{Accounts: 1, Reservations: 2, OpenReservations: 1, LedgerEntries: 3, Receipts: 4, OpenDatabaseReconciliations: 5, ProviderReconciliations: 6}, nil
		},
	}
	service := newQualificationService(t, repository)
	ready := perform(t, service.Handler(), http.MethodGet, RouteReady, nil, nil)
	if ready.Code != http.StatusOK || readyCalls != 1 {
		t.Fatalf("readiness drifted: %d %s calls=%d", ready.Code, ready.Body.String(), readyCalls)
	}
	metrics := perform(t, service.Handler(), http.MethodGet, RouteMetrics, nil, readHeaders())
	values := parseBudgetMetricValues(t, metrics.Body.String(), MetricNames())
	if metrics.Code != http.StatusOK || metrics.Header().Get("Content-Type") != "text/plain; version=0.0.4" ||
		values["openslack_workflow_control_budget_accounts"] != 1 ||
		values["openslack_workflow_control_budget_provider_reconciliations"] != 6 {
		t.Fatalf("metrics drifted: %d %s", metrics.Code, metrics.Body.String())
	}
}

func parseBudgetMetricValues(t testing.TB, body string, expectedNames []string) map[string]int64 {
	t.Helper()
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
			t.Fatalf("metric %q has invalid definition/value lines: %q / %q", name, lines[index*2], lines[index*2+1])
		}
		value, err := strconv.ParseInt(valueFields[1], 10, 64)
		if err != nil || value < 0 {
			t.Fatalf("metric %q value=%q err=%v", name, valueFields[1], err)
		}
		values[name] = value
	}
	return values
}

func TestBudgetQualificationReadinessFailureReturns503(t *testing.T) {
	service := newQualificationService(t, &fakeRepository{ready: func(context.Context) error { return errors.New("offline") }})
	response := perform(t, service.Handler(), http.MethodGet, RouteReady, nil, nil)
	if response.Code != http.StatusServiceUnavailable || response.Body.String() != "{\"status\":\"not_ready\"}\n" {
		t.Fatalf("readiness failure drifted: %d %s", response.Code, response.Body.String())
	}
}

func TestBudgetAuthorityTimeoutBudgetsLeaveResponseSlack(t *testing.T) {
	if serverReadTimeout != 30*time.Second || serverWriteTimeout != 45*time.Second || serverWriteTimeout <= requestDeadline+10*time.Second {
		t.Fatalf("budget server timeouts drifted: read=%s request=%s write=%s", serverReadTimeout, requestDeadline, serverWriteTimeout)
	}
}

func newQualificationService(t *testing.T, repository budgetstore.Repository) *Service {
	t.Helper()
	digest := sha256.Sum256([]byte(testBearer))
	service, err := New(Options{
		Repository: repository, QualificationMode: true, BuildSHA: testBuildSHA,
		BearerTokenSHA256: hex.EncodeToString(digest[:]), WorkspaceID: testWorkspace,
		CallerID: testCaller, RoutingEpoch: testRoutingEpoch,
		Seed: budgetstore.QualificationSeed{PolicyHash: testBuildSHA, Limit: budgetstore.Quantities{Tokens: "100", NanoUSD: "100", Calls: "100"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func reserveRequest(limit string) budgetcontract.Record {
	hash := "sha256:" + testBuildSHA
	return budgetcontract.Record{
		"schema":          budgetcontract.SchemaReserveRequest,
		"contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
		"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"workspaceId": testWorkspace, "runId": testRunID, "accountId": "account-1",
		"reservationId": "reservation-1", "callId": "call-1", "providerAttempt": "1",
		"expectedProviderHash": hash, "expectedModelHash": hash, "expectedProviderRunHash": hash,
		"correlationId": "correlation-gs9e", "policyHash": testBuildSHA,
		"route":                   budgetcontract.Record{"backend": budgetstore.Backend, "authority": budgetstore.Authority, "routingEpoch": testRoutingEpoch, "authorityBuildHash": testBuildSHA},
		"expectedAccountRevision": int64(0), "expectedRunRevision": int64(1),
		"rateNanoUsdPerToken": "1", "requested": budgetcontract.Record{"tokens": "10", "nanoUsd": "10", "calls": "1"},
		"requestedAt": "2026-08-15T00:00:00.000Z", "_testLimit": limit,
	}
}

func reserveBody(t *testing.T, limit string) []byte {
	t.Helper()
	request := reserveRequest(limit)
	delete(request, "_testLimit")
	prepared, err := budgetcontract.PrepareRequest("reserve", request, testCaller)
	if err != nil {
		t.Fatal(err)
	}
	return []byte(prepared.Body)
}

func initialAccount(t *testing.T, limit string) budgetcontract.Record {
	t.Helper()
	zero := budgetcontract.Record{"tokens": "0", "nanoUsd": "0", "calls": "0"}
	value, err := budgetcontract.ValidateAccount(budgetcontract.Record{
		"schema":          budgetcontract.SchemaAccount,
		"contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
		"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"workspaceId": testWorkspace, "runId": testRunID, "accountId": "account-1", "policyHash": testBuildSHA,
		"route":           budgetcontract.Record{"backend": budgetstore.Backend, "authority": budgetstore.Authority, "routingEpoch": testRoutingEpoch, "authorityBuildHash": testBuildSHA},
		"accountRevision": int64(0), "runRevision": int64(1),
		"limit": budgetcontract.Record{"tokens": limit, "nanoUsd": limit, "calls": limit}, "reserved": zero, "settled": zero,
		"updatedAt": "2026-08-14T23:59:59.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func reserveResult(t *testing.T, body []byte, limit string) budgetstore.MutationResult {
	t.Helper()
	parsed, err := budgetcontract.ParseBytes(body)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := budgetcontract.PrepareRequest("reserve", parsed, testCaller)
	if err != nil {
		t.Fatal(err)
	}
	evaluation, err := budgetcontract.EvaluateReserve(initialAccount(t, limit), parsed, "2026-08-15T00:00:01.000Z")
	if err != nil {
		t.Fatal(err)
	}
	recordHash, err := budgetcontract.HashValue("reserve-decision", evaluation.Decision)
	if err != nil {
		t.Fatal(err)
	}
	ledgerHash, err := budgetcontract.HashValue("ledger-entry", evaluation.LedgerEntry)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := budgetcontract.ValidateReceipt(budgetcontract.Record{
		"schema":          budgetcontract.SchemaReceipt,
		"contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
		"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"operation": "reserve", "status": "accepted", "workspaceId": testWorkspace, "runId": testRunID,
		"accountId": "account-1", "reservationId": "reservation-1", "callId": "call-1",
		"expectedAccountRevision": int64(0), "acceptedAccountRevision": int64(1),
		"expectedRunRevision": int64(1), "acceptedRunRevision": int64(2),
		"idempotencyKey": prepared.IdempotencyKey, "requestFingerprint": prepared.RequestFingerprint,
		"requestHash": prepared.RequestHash, "recordHash": recordHash, "ledgerEntryHash": ledgerHash,
		"correlationId": "correlation-gs9e", "serviceBuildHash": testBuildSHA,
		"committedAt": "2026-08-15T00:00:01.000Z", "reconciliationToken": nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := budgetcontract.ValidateReceiptForResult(receipt, prepared, evaluation.Decision, evaluation.LedgerEntry, nil); err != nil {
		t.Fatal(err)
	}
	recordOuter := durableRecord(t, budgetstore.RecordKindReserveDecision, evaluation.Decision)
	ledgerOuter := durableRecord(t, budgetstore.RecordKindLedgerEntry, evaluation.LedgerEntry)
	receiptOuter := durableRecord(t, budgetstore.RecordKindReceipt, receipt)
	responseValue := budgetstore.MutationResponse{
		Schema: budgetstore.MutationResponseSchema, Operation: "reserve",
		Record: &recordOuter, Receipt: receiptOuter, Reconciliation: nil,
	}
	response, err := budgetstore.EncodeMutationResponse("reserve", &recordOuter, receiptOuter, nil)
	if err != nil {
		t.Fatal(err)
	}
	return budgetstore.MutationResult{
		Operation: "reserve", Status: evaluation.Decision["status"].(string),
		Record: evaluation.Decision, LedgerEntry: evaluation.LedgerEntry, Receipt: receipt,
		DurableRecord: &recordOuter, DurableLedgerEntry: &ledgerOuter, DurableReceipt: receiptOuter, Response: responseValue,
		ExactRecordBytes: durableBytes(t, recordOuter), ExactLedgerBytes: durableBytes(t, ledgerOuter),
		ExactReceiptBytes: durableBytes(t, receiptOuter), ExactResponseBytes: response,
		ReceiptID: "wf-budget-receipt-1", RecordedAt: time.Date(2026, 8, 15, 0, 0, 1, 0, time.UTC),
	}
}

func reservationForDecision(t *testing.T, decision budgetcontract.Record) budgetcontract.Record {
	t.Helper()
	request := decision["request"].(budgetcontract.Record)
	hash, err := budgetcontract.HashValue("reserve-decision", decision)
	if err != nil {
		t.Fatal(err)
	}
	value, err := budgetcontract.ValidateReservation(budgetcontract.Record{
		"schema":          budgetcontract.SchemaReservation,
		"contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
		"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"workspaceId": request["workspaceId"], "runId": request["runId"], "accountId": request["accountId"],
		"reservationId": request["reservationId"], "callId": request["callId"], "providerAttempt": request["providerAttempt"],
		"expectedProviderHash": request["expectedProviderHash"], "expectedModelHash": request["expectedModelHash"],
		"expectedProviderRunHash": request["expectedProviderRunHash"], "policyHash": request["policyHash"], "route": request["route"],
		"rateNanoUsdPerToken": request["rateNanoUsdPerToken"], "reserved": request["requested"], "reserveDecisionHash": hash,
		"openedAccountRevision": int64(1), "openedRunRevision": int64(2), "openedAt": "2026-08-15T00:00:01.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func canonicalBytes(t *testing.T, value budgetcontract.Record) []byte {
	t.Helper()
	encoded, err := budgetcontract.CanonicalJSON(value)
	if err != nil {
		t.Fatal(err)
	}
	return []byte(encoded)
}

func durableRecord(t *testing.T, kind string, value budgetcontract.Record) budgetstore.DurableRecord {
	t.Helper()
	record, err := budgetstore.NewDurableRecord(kind, value, testBuildSHA)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func durableBytes(t *testing.T, value budgetstore.DurableRecord) []byte {
	t.Helper()
	encoded, err := budgetstore.EncodeDurableRecord(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func mutationHeaders(t *testing.T, operation string, body []byte, bearer bool) map[string]string {
	t.Helper()
	parsed, err := budgetcontract.ParseBytes(body)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := budgetcontract.PrepareRequest(operation, parsed, testCaller)
	if err != nil {
		t.Fatal(err)
	}
	headers := readHeaders()
	headers["Content-Type"] = "application/json"
	headers["Idempotency-Key"] = prepared.IdempotencyKey
	headers[HeaderFingerprint] = prepared.RequestFingerprint
	if !bearer {
		delete(headers, "Authorization")
	}
	return headers
}

func readHeaders() map[string]string {
	return map[string]string{
		"Authorization": "Bearer " + testBearer,
		HeaderCallerID:  testCaller, HeaderWorkspaceID: testWorkspace,
		HeaderRoutingEpoch: strconv.FormatInt(testRoutingEpoch, 10), HeaderExpectedBuildSHA: testBuildSHA,
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
