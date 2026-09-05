package contracts_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
)

func loadBudgetAuthorityOpenAPI(t *testing.T) *openapi3.T {
	t.Helper()
	_, filename, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(filename), "..", "..", "docs", "api", "budget-authority-openapi.yaml")
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = true
	contractRoot := filepath.Join(filepath.Dir(filename), "..", "..", "budgetcontract", "generated", "v1", "schemas")
	loader.ReadFromURIFunc = openapi3.ReadFromURIs(
		func(_ *openapi3.Loader, location *url.URL) ([]byte, error) {
			const prefix = "/contracts/workflow-budget-authority/v1/schemas/"
			if location.Scheme != "https" || location.Host != "openslack.dev" || !strings.HasPrefix(location.Path, prefix) {
				return nil, openapi3.ErrURINotSupported
			}
			name := strings.TrimPrefix(location.Path, prefix)
			if name == "" || name != filepath.Base(name) || !strings.HasSuffix(name, ".schema.json") {
				return nil, openapi3.ErrURINotSupported
			}
			return os.ReadFile(filepath.Join(contractRoot, name))
		},
		openapi3.ReadFromFile,
	)
	document, err := loader.LoadFromFile(path)
	if err != nil {
		t.Fatalf("load budget authority OpenAPI: %v", err)
	}
	if err := document.Validate(context.Background()); err != nil {
		t.Fatalf("validate budget authority OpenAPI: %v", err)
	}
	return document
}

func TestBudgetAuthorityOpenAPIContract(t *testing.T) {
	document := loadBudgetAuthorityOpenAPI(t)
	var routes []string
	for route := range document.Paths.Map() {
		routes = append(routes, route)
	}
	sort.Strings(routes)
	wantRoutes := []string{
		"/health/live", "/health/ready", "/health/version", "/metrics",
		"/v1/authority/workflow-budgets/receipts/{idempotencyKey}",
		"/v1/authority/workflow-budgets/runs/{runId}/account",
		"/v1/authority/workflow-budgets/runs/{runId}/reservations/{reservationId}",
		"/v1/authority/workflow-budgets:reserve",
		"/v1/authority/workflow-budgets:settle",
	}
	if fmt.Sprint(routes) != fmt.Sprint(wantRoutes) {
		t.Fatalf("budget authority route inventory drifted: %v", routes)
	}
	extensions := document.Extensions
	if extensions["x-openslack-default-off"] != true || extensions["x-openslack-mode"] != "local-qualification-v1" ||
		extensions["x-openslack-workflow-authority"] != "typescript" || extensions["x-openslack-budget-authority"] != "qualification-only" ||
		extensions["x-openslack-production-budget-authority"] != false ||
		extensions["x-openslack-production-initial-budget-policy-source-delivered"] != false ||
		extensions["x-openslack-runner-protocol-v2-delivered"] != false || extensions["x-openslack-routing-activated"] != false ||
		extensions["x-openslack-canary-activated"] != false || extensions["x-openslack-cutover-activated"] != false ||
		fmt.Sprint(extensions["x-openslack-network-modes"]) != "[loopback]" {
		t.Fatalf("budget authority negative production declaration drifted: %+v", extensions)
	}
	for _, route := range []string{"/health/live", "/health/ready", "/health/version"} {
		operation := document.Paths.Value(route).Get
		if operation == nil || operation.Security == nil || len(*operation.Security) != 0 {
			t.Fatalf("health route %s must have no credential dependency", route)
		}
	}
	protected := []*openapi3.Operation{
		document.Paths.Value("/v1/authority/workflow-budgets:reserve").Post,
		document.Paths.Value("/v1/authority/workflow-budgets:settle").Post,
		document.Paths.Value("/v1/authority/workflow-budgets/runs/{runId}/account").Get,
		document.Paths.Value("/v1/authority/workflow-budgets/runs/{runId}/reservations/{reservationId}").Get,
		document.Paths.Value("/v1/authority/workflow-budgets/receipts/{idempotencyKey}").Get,
		document.Paths.Value("/metrics").Get,
	}
	for _, operation := range protected {
		if operation == nil || operation.Security == nil || len(*operation.Security) != 1 {
			t.Fatal("budget authority operation is missing exact bearer security")
		}
		if _, ok := (*operation.Security)[0]["bearerAuth"]; !ok {
			t.Fatal("budget authority operation does not require bearerAuth")
		}
		for _, name := range []string{
			"X-OpenSlack-Workflow-Budget-Caller-ID", "X-OpenSlack-Workflow-Budget-Workspace-ID",
			"X-OpenSlack-Workflow-Budget-Routing-Epoch", "X-OpenSlack-Workflow-Budget-Expected-Build-SHA",
		} {
			if !hasHeader(operation, name) {
				t.Fatalf("budget authority operation is missing %s", name)
			}
		}
	}
	for _, route := range []string{"/v1/authority/workflow-budgets:reserve", "/v1/authority/workflow-budgets:settle"} {
		responses := document.Paths.Value(route).Post.Responses
		for _, status := range []string{"200", "201", "202", "401", "409", "413", "415", "422", "500", "503"} {
			if responses.Value(status) == nil {
				t.Fatalf("mutation route %s is missing %s", route, status)
			}
		}
	}
	for name, reference := range document.Components.Schemas {
		if reference == nil || reference.Value == nil || reference.Value.Type == nil || !reference.Value.Type.Is(openapi3.TypeObject) {
			continue
		}
		frozenProjection := strings.Contains(reference.Ref, "budgetcontract/generated/v1/schemas/")
		if reference.Value.AdditionalProperties.Has == nil || *reference.Value.AdditionalProperties.Has ||
			(!frozenProjection && (reference.Value.UnevaluatedProperties.Has == nil || *reference.Value.UnevaluatedProperties.Has)) {
			t.Fatalf("budget authority object schema %s is not closed", name)
		}
	}
	assertBudgetDurableBranches(t, document)
	assertBudgetOpenAPIInstances(t, document)
	assertBudgetErrorCodes(t, document)
}

func assertBudgetDurableBranches(t *testing.T, document *openapi3.T) {
	t.Helper()
	accepted := budgetcontract.AcceptedManifestSHA256()
	wantManifests := make([]any, 0, len(accepted))
	for index := len(accepted) - 1; index >= 0; index-- {
		wantManifests = append(wantManifests, accepted[index])
	}
	want := map[string]string{
		"DurableRecordAccountBranch": "account", "DurableRecordReserveDecisionBranch": "reserve_decision",
		"DurableRecordReservationBranch": "reservation", "DurableRecordSettlementBranch": "settlement",
		"DurableRecordLedgerEntryBranch": "ledger_entry", "DurableRecordReceiptBranch": "receipt",
		"DurableRecordReconciliationBranch": "reconciliation",
	}
	for name, kind := range want {
		schema := document.Components.Schemas[name].Value
		if schema == nil || schema.Properties["recordKind"].Value.Const != kind || schema.Properties["productionAuthority"].Value.Const != false ||
			schema.Properties["authorityMode"].Value.Const != "local-qualification-v1" ||
			!reflect.DeepEqual(schema.Properties["contractManifestSha256"].Value.Enum, wantManifests) {
			t.Fatalf("durable branch %s binding drifted", name)
		}
	}
	for _, name := range []string{"KnownReserveResponse", "KnownSettlementResponse", "DatabaseReconciliationResponse", "OpenReservationRead", "SettledReservationRead"} {
		schema := document.Components.Schemas[name].Value
		if schema == nil || schema.AdditionalProperties.Has == nil || *schema.AdditionalProperties.Has ||
			schema.UnevaluatedProperties.Has == nil || *schema.UnevaluatedProperties.Has {
			t.Fatalf("closed response variant %s drifted", name)
		}
	}
}

func assertBudgetOpenAPIInstances(t *testing.T, document *openapi3.T) {
	t.Helper()
	for component, record := range map[string]string{
		"ReserveRequestProjection":    "reserveRequest",
		"SettlementRequestProjection": "settlementRequest",
	} {
		instance := budgetGoldenRecord(t, record)
		route := instance["route"].(map[string]any)
		route["backend"], route["authority"] = "go", "workflow-control"
		schema := document.Components.Schemas[component].Value
		if err := schema.VisitJSON(instance); err != nil {
			t.Fatalf("valid %s failed OpenAPI: %v", component, err)
		}
		unknown := cloneBudgetJSON(t, instance)
		unknown["unexpected"] = true
		if err := schema.VisitJSON(unknown); err == nil {
			t.Fatalf("%s accepted an unknown E1 field", component)
		}
		wrongSchema := cloneBudgetJSON(t, instance)
		wrongSchema["schema"] = "openslack.workflow_budget_wrong.v1"
		if err := schema.VisitJSON(wrongSchema); err == nil {
			t.Fatalf("%s accepted the wrong E1 schema", component)
		}
		wrongRoute := cloneBudgetJSON(t, instance)
		wrongRoute["route"].(map[string]any)["backend"] = "ts-local"
		wrongRoute["route"].(map[string]any)["authority"] = "typescript"
		if err := schema.VisitJSON(wrongRoute); err == nil {
			t.Fatalf("%s accepted the TypeScript production route on the Go qualification endpoint", component)
		}
	}
	hash := strings.Repeat("a", 64)
	zero := budgetcontract.Record{"tokens": "0", "nanoUsd": "0", "calls": "0"}
	account, err := budgetcontract.ValidateAccount(budgetcontract.Record{
		"schema": budgetcontract.SchemaAccount, "contractVersion": budgetcontract.ContractVersion,
		"authority": budgetcontract.Authority, "writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"workspaceId": "workspace.contract", "runId": "run-contract", "accountId": "account-contract", "policyHash": hash,
		"route":           budgetcontract.Record{"backend": "go", "authority": "workflow-control", "routingEpoch": int64(9), "authorityBuildHash": hash},
		"accountRevision": int64(1), "runRevision": int64(2), "limit": budgetcontract.Record{"tokens": "100", "nanoUsd": "100", "calls": "10"},
		"reserved": zero, "settled": zero, "updatedAt": "2026-08-15T00:00:00.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	outer, err := budgetstore.NewDurableRecord(budgetstore.RecordKindAccount, account, hash)
	if err != nil {
		t.Fatal(err)
	}
	instance := jsonValue(t, outer)
	schema := document.Components.Schemas["DurableRecord"].Value
	if err := schema.VisitJSON(instance); err != nil {
		t.Fatalf("valid durable account failed OpenAPI: %v", err)
	}
	extra := instance.(map[string]any)
	extra["unexpected"] = true
	if err := schema.VisitJSON(extra); err == nil {
		t.Fatal("durable account schema accepted an additional outer field")
	}
	drifted := jsonValue(t, outer).(map[string]any)
	drifted["productionAuthority"] = true
	if err := schema.VisitJSON(drifted); err == nil {
		t.Fatal("durable record schema accepted a production authority claim")
	}
	wrongKind := jsonValue(t, outer).(map[string]any)
	wrongKind["recordKind"] = "reservation"
	if err := schema.VisitJSON(wrongKind); err == nil {
		t.Fatal("durable record schema accepted an account projection under the reservation kind")
	}
	unknownProjection := jsonValue(t, outer).(map[string]any)
	unknownProjection["operationalProjection"].(map[string]any)["unexpected"] = true
	if err := schema.VisitJSON(unknownProjection); err == nil {
		t.Fatal("durable record schema accepted an unknown E1 projection field")
	}
	wrongProjectionSchema := jsonValue(t, outer).(map[string]any)
	wrongProjectionSchema["operationalProjection"].(map[string]any)["schema"] = budgetcontract.SchemaReservation
	if err := schema.VisitJSON(wrongProjectionSchema); err == nil {
		t.Fatal("durable record schema accepted the wrong E1 projection schema")
	}
	version := map[string]any{
		"schema": "openslack.workflow_control_budget_authority_service_version.v1", "contractVersion": "v1", "buildSha": hash,
		"mode": "local-qualification-v1", "qualificationMode": true, "typescriptProductionWorkflowAuthority": true,
		"goBudgetAuthority": "qualification-only", "productionBudgetAuthority": false, "qualificationSeedConfigured": true,
		"productionInitialBudgetPolicySourceDelivered": false, "runnerProtocolV2Delivered": false,
		"routingActivated": false, "canaryActivated": false, "cutoverActivated": false,
	}
	if err := document.Components.Schemas["Version"].Value.VisitJSON(version); err != nil {
		t.Fatalf("version instance failed OpenAPI: %v", err)
	}
}

func assertBudgetErrorCodes(t *testing.T, document *openapi3.T) {
	t.Helper()
	want := []string{
		"WORKFLOW_BUDGET_AUTHORITY_DECIMAL_OVERFLOW", "WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH",
		"WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH", "WORKFLOW_BUDGET_AUTHORITY_INVALID",
		"WORKFLOW_BUDGET_AUTHORITY_INVALID_DECIMAL", "WORKFLOW_BUDGET_AUTHORITY_LEGACY_APPROVAL_NO_AUTHORITY",
		"WORKFLOW_BUDGET_AUTHORITY_LIMIT_EXCEEDED", "WORKFLOW_BUDGET_AUTHORITY_POLICY_DRIFT",
		"WORKFLOW_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED", "WORKFLOW_BUDGET_AUTHORITY_ROUTE_DRIFT",
		"WORKFLOW_BUDGET_AUTHORITY_STALE_REVISION", "WORKFLOW_BUDGET_AUTHORITY_UNKNOWN_FIELD",
		"WORKFLOW_CONTROL_BUDGET_COMMIT_OUTCOME_UNKNOWN", "WORKFLOW_CONTROL_BUDGET_CONFLICT",
		"WORKFLOW_CONTROL_BUDGET_CONTENT_INVALID", "WORKFLOW_CONTROL_BUDGET_DATABASE_ERROR",
		"WORKFLOW_CONTROL_BUDGET_IDEMPOTENCY_CONFLICT", "WORKFLOW_CONTROL_BUDGET_INPUT_INVALID",
		"WORKFLOW_CONTROL_BUDGET_INTEGRITY_ERROR", "WORKFLOW_CONTROL_BUDGET_INTERNAL",
		"WORKFLOW_CONTROL_BUDGET_NOT_FOUND", "WORKFLOW_CONTROL_BUDGET_READ_FAILED",
		"WORKFLOW_CONTROL_BUDGET_RECONCILIATION_REQUIRED", "WORKFLOW_CONTROL_BUDGET_TIMEOUT",
		"WORKFLOW_CONTROL_BUDGET_TOO_LARGE", "WORKFLOW_CONTROL_BUDGET_UNAUTHORIZED",
		"WORKFLOW_CONTROL_BUDGET_UNSUPPORTED_MEDIA_TYPE",
	}
	var got []string
	for _, value := range document.Components.Schemas["Error"].Value.Properties["code"].Value.Enum {
		got = append(got, value.(string))
	}
	sort.Strings(got)
	sort.Strings(want)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("budget authority error codes drifted:\n got %v\nwant %v", got, want)
	}
}

func budgetGoldenRecord(t *testing.T, name string) map[string]any {
	t.Helper()
	_, filename, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(filename), "..", "..", "budgetcontract", "generated", "v1", "golden-vectors.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var root map[string]any
	if err := json.Unmarshal(contents, &root); err != nil {
		t.Fatal(err)
	}
	vectors := root["vectors"].(map[string]any)
	records := vectors["records"].(map[string]any)
	if name == "settlementRequest" {
		settlement := records["settlementSettled"].(map[string]any)["value"].(map[string]any)
		return settlement["request"].(map[string]any)
	}
	entry, ok := records[name].(map[string]any)
	if !ok {
		t.Fatalf("golden budget record %s is absent", name)
	}
	return entry["value"].(map[string]any)
}

func cloneBudgetJSON(t *testing.T, value any) map[string]any {
	t.Helper()
	return jsonValue(t, value).(map[string]any)
}

func jsonValue(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}
