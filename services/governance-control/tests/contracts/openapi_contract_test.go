package contracts_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/app"
)

func serviceRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}

func loadOpenAPI(t *testing.T) (*openapi3.T, string) {
	t.Helper()
	path := filepath.Join(serviceRoot(t), "docs", "api", "openapi.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = true
	document, err := loader.LoadFromFile(path)
	if err != nil {
		t.Fatalf("kin-openapi LoadFromFile: %v", err)
	}
	if err := document.Validate(context.Background(), openapi3.DisableSchemaPatternValidation()); err != nil {
		t.Fatalf("kin-openapi Validate: %v", err)
	}
	return document, string(raw)
}

func TestOpenAPI31LoadsAndClosesTheGS5AndGS6Surfaces(t *testing.T) {
	document, source := loadOpenAPI(t)
	if document.OpenAPI != "3.1.0" {
		t.Fatalf("OpenAPI = %q", document.OpenAPI)
	}
	for _, route := range []string{
		app.RouteObservation,
		app.RouteProjection,
		app.RouteLive,
		app.RouteReady,
		app.RouteVersion,
		app.RouteMetrics,
		app.RouteAuthorityAccept,
		"/v1/governance/plans/{planId}:claim-execution",
		"/v1/governance/plans/{planId}:complete-execution",
		"/v1/governance/plans/{planId}:cancel",
		"/v1/governance/plans/{planId}:expire",
		"/v1/governance/plans/{planId}:require-reconciliation",
		app.RouteAuthorityRead,
		app.RouteAuthorityReceipt,
		app.RouteAuthorityAudit,
		app.RouteAuthorityPendingAudit,
	} {
		if document.Paths.Find(route) == nil {
			t.Fatalf("OpenAPI missing route %s", route)
		}
	}
	for _, required := range []string{
		"openslack.governance_shadow_observation.v1",
		"../../internal/contractmirror/generated/v1/schemas/governed-plan.v1.schema.json",
		"../../internal/contractmirror/generated/v1/schemas/governed-plan-audit.v1.schema.json",
		"../../internal/contractmirror/generated/v1/schemas/governed-plan-read-model.v1.schema.json",
		"additionalProperties: false",
		"Idempotency-Key",
		"reconciliation_required",
		"presentedTokenHash",
		"openslack.governance_authority_receipt.v1",
		"openslack.governance_authority_audit_receipt.v1",
		"X-OpenSlack-Governance-Routing-Epoch",
		"local qualification",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("OpenAPI missing %q", required)
		}
	}
	if strings.Contains(source, "rawToken") {
		t.Fatal("OpenAPI exposes a raw confirmation capability")
	}
}

func TestOpenAPIAuthorityReceiptModesAndRuntimeResponsesCannotDrift(t *testing.T) {
	document, source := loadOpenAPI(t)
	mutationRoutes := []string{
		app.RouteAuthorityAccept,
		"/v1/governance/plans/{planId}:claim-execution",
		"/v1/governance/plans/{planId}:complete-execution",
		"/v1/governance/plans/{planId}:cancel",
		"/v1/governance/plans/{planId}:expire",
		"/v1/governance/plans/{planId}:require-reconciliation",
	}
	for _, route := range mutationRoutes {
		requireOpenAPIResponses(t, document.Paths.Find(route).Post.Responses,
			route, "200", "201", "202", "408", "409", "413", "415", "422", "500", "503")
	}
	for _, route := range mutationRoutes[1:] {
		requireOpenAPIResponses(t, document.Paths.Find(route).Post.Responses, route, "404")
	}
	requireOpenAPIResponses(t, document.Paths.Find(app.RouteAuthorityAudit).Post.Responses,
		app.RouteAuthorityAudit, "200", "201", "404", "408", "409", "413", "415", "422", "500", "503")
	for _, route := range []string{app.RouteAuthorityRead, app.RouteAuthorityReceipt} {
		requireOpenAPIResponses(t, document.Paths.Find(route).Get.Responses, route, "200", "404", "409", "422", "500", "503")
	}
	requireOpenAPIResponses(t, document.Paths.Find(app.RouteAuthorityPendingAudit).Get.Responses,
		app.RouteAuthorityPendingAudit, "200", "404", "409", "422", "500", "503")

	receipt := document.Components.Schemas["AuthorityReceipt"].Value
	if receipt == nil || len(receipt.OneOf) != 2 ||
		receipt.OneOf[0].Ref != "#/components/schemas/AuthorityAcceptedReceipt" ||
		receipt.OneOf[1].Ref != "#/components/schemas/AuthorityReconciliationReceipt" {
		t.Fatalf("AuthorityReceipt mode union drift: %#v", receipt)
	}
	accepted := document.Components.Schemas["AuthorityAcceptedReceipt"].Value
	reconciliation := document.Components.Schemas["AuthorityReconciliationReceipt"].Value
	for name, schema := range map[string]*openapi3.Schema{"accepted": accepted, "reconciliation": reconciliation} {
		if schema == nil || schema.AdditionalProperties.Has == nil || *schema.AdditionalProperties.Has {
			t.Fatalf("%s receipt branch is not closed", name)
		}
	}
	if status := accepted.Properties["status"].Value.Enum; len(status) != 2 || status[0] != "accepted" || status[1] != "duplicate" {
		t.Fatalf("accepted receipt status = %#v", status)
	}
	if reconciliation.Properties["status"].Value.Const != "reconciliation_required" {
		t.Fatalf("reconciliation receipt status = %#v", reconciliation.Properties["status"].Value.Const)
	}
	for _, forbidden := range []string{"targetRevision", "targetState", "reconciliationToken"} {
		if accepted.Properties[forbidden] != nil {
			t.Fatalf("accepted receipt exposes reconciliation field %s", forbidden)
		}
	}
	for _, forbidden := range []string{"acceptedRevision", "state", "record", "committedAt"} {
		if reconciliation.Properties[forbidden] != nil {
			t.Fatalf("reconciliation receipt exposes accepted field %s", forbidden)
		}
	}
	token := reconciliation.Properties["reconciliationToken"].Value
	if token.MinLength != 16 || token.MaxLength == nil || *token.MaxLength != 256 || token.Pattern != `^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$` {
		t.Fatalf("reconciliation token boundary drift: %#v", token)
	}
	for _, schema := range []*openapi3.Schema{accepted, reconciliation} {
		revision := schema.Properties["expectedRevision"].Value
		if revision.Max == nil || *revision.Max != 9007199254740990 {
			t.Fatalf("expectedRevision maximum drift: %#v", revision.Max)
		}
	}
	if !strings.Contains(source, "Authority commit result") && !strings.Contains(source, "Unknown commit result") {
		t.Fatal("OpenAPI does not describe the authority commit-unknown result")
	}
	pending := document.Components.Schemas["AuthorityPendingAudit"].Value
	if pending == nil || pending.AdditionalProperties.Has == nil || *pending.AdditionalProperties.Has ||
		len(pending.Required) != 9 || len(pending.Properties) != 9 || pending.Properties["status"].Value.Const != "pending" ||
		pending.Properties["record"] != nil || pending.Properties["state"] != nil {
		t.Fatalf("pending authority audit point-read schema drift: %#v", pending)
	}
	required := make(map[string]struct{}, len(pending.Required))
	for _, name := range pending.Required {
		required[name] = struct{}{}
	}
	for _, name := range []string{"schema", "status", "operation", "workspaceId", "planId", "revision", "route", "recordHash", "serviceBuildSha"} {
		if _, ok := required[name]; !ok || pending.Properties[name] == nil {
			t.Fatalf("pending authority audit schema omits %s", name)
		}
	}
	if operations := pending.Properties["operation"].Value.Enum; len(operations) != 6 {
		t.Fatalf("pending authority audit operation enum = %#v", operations)
	}
}

func requireOpenAPIResponses(t *testing.T, responses *openapi3.Responses, route string, statuses ...string) {
	t.Helper()
	if responses == nil {
		t.Fatalf("OpenAPI route %s has no responses", route)
	}
	for _, status := range statuses {
		if responses.Value(status) == nil {
			t.Fatalf("OpenAPI route %s omits runtime response %s", route, status)
		}
	}
}
