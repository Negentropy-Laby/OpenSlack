package contracts_test

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func loadAuthorityOpenAPI(t *testing.T) *openapi3.T {
	t.Helper()
	_, filename, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(filename), "..", "..", "docs", "api", "authority-openapi.yaml")
	document, err := openapi3.NewLoader().LoadFromFile(path)
	if err != nil {
		t.Fatalf("load authority OpenAPI: %v", err)
	}
	if err := document.Validate(context.Background()); err != nil {
		t.Fatalf("validate authority OpenAPI: %v", err)
	}
	return document
}

func TestAuthorityOpenAPIContract(t *testing.T) {
	document := loadAuthorityOpenAPI(t)
	var routes []string
	for route := range document.Paths.Map() {
		routes = append(routes, route)
	}
	sort.Strings(routes)
	expected := []string{
		"/health/live", "/health/ready", "/health/version", "/metrics",
		"/v1/workflow-control/binding",
		"/v1/workflow-control/receipts/{idempotencyKey}",
		"/v1/workflow-control/runs/{runId}",
		"/v1/workflow-control/runs/{runId}/outbox/{revision}:pending",
		"/v1/workflow-control/runs/{runId}:transition",
		"/v1/workflow-control/runs:accept",
	}
	if fmt.Sprint(routes) != fmt.Sprint(expected) {
		t.Fatalf("authority route inventory drifted: %v", routes)
	}
	if document.Extensions["x-openslack-default-off"] != true ||
		fmt.Sprint(document.Extensions["x-openslack-modes"]) != "[disabled local-qualification-v1 new-record-canary-v1]" ||
		fmt.Sprint(document.Extensions["x-openslack-workflow-authority"]) != "[typescript workflow-control]" ||
		document.Extensions["x-openslack-routing-policy"] != "explicit-active-and-bounded-drain-epochs" ||
		document.Extensions["x-openslack-accept-new-records"] != "explicit-boolean-default-false" ||
		fmt.Sprint(document.Extensions["x-openslack-network-modes"]) != "[loopback]" {
		t.Fatalf("default-off canary authority declaration drifted: %+v", document.Extensions)
	}
	for _, route := range []string{"/health/live", "/health/ready", "/health/version"} {
		operation := document.Paths.Value(route).Get
		if operation == nil || operation.Security == nil || len(*operation.Security) != 0 {
			t.Fatalf("health route %s must have no credential dependency", route)
		}
	}
	protected := []*openapi3.Operation{
		document.Paths.Value("/v1/workflow-control/binding").Get,
		document.Paths.Value("/v1/workflow-control/runs:accept").Post,
		document.Paths.Value("/v1/workflow-control/runs/{runId}:transition").Post,
		document.Paths.Value("/v1/workflow-control/runs/{runId}").Get,
		document.Paths.Value("/v1/workflow-control/receipts/{idempotencyKey}").Get,
		document.Paths.Value("/v1/workflow-control/runs/{runId}/outbox/{revision}:pending").Get,
		document.Paths.Value("/metrics").Get,
	}
	for _, operation := range protected {
		if operation == nil || operation.Security == nil || len(*operation.Security) != 1 {
			t.Fatal("authority operation is missing exact bearer security")
		}
		if _, ok := (*operation.Security)[0]["bearerAuth"]; !ok {
			t.Fatal("authority operation does not require bearerAuth")
		}
		for _, name := range []string{
			"X-OpenSlack-Workflow-Control-Caller-ID", "X-OpenSlack-Workflow-Control-Workspace-ID",
			"X-OpenSlack-Workflow-Control-Routing-Epoch", "X-OpenSlack-Workflow-Control-Expected-Build-SHA",
		} {
			if !hasHeader(operation, name) {
				t.Fatalf("authority operation is missing %s", name)
			}
		}
	}
	for _, route := range []string{"/v1/workflow-control/runs:accept", "/v1/workflow-control/runs/{runId}:transition"} {
		operation := document.Paths.Value(route).Post
		if operation.Extensions["x-openslack-replay-response"] != "exact-original" ||
			operation.Responses.Value("201") == nil || operation.Responses.Value("200") == nil || operation.Responses.Value("202") == nil {
			t.Fatalf("mutation receipt semantics drifted at %s", route)
		}
	}
	for name, reference := range document.Components.Schemas {
		if reference == nil || reference.Value == nil || reference.Value.Type == nil || !reference.Value.Type.Is(openapi3.TypeObject) {
			continue
		}
		if reference.Value.AdditionalProperties.Has == nil || *reference.Value.AdditionalProperties.Has ||
			reference.Value.UnevaluatedProperties.Has == nil || *reference.Value.UnevaluatedProperties.Has {
			t.Fatalf("authority object schema %s is not closed", name)
		}
	}
}

func TestAuthorityOutboxSchemasRejectKeyAndPayloadDrift(t *testing.T) {
	document := loadAuthorityOpenAPI(t)
	hash := strings.Repeat("a", 64)
	outboxKey := "openslack.workflow-control-authority-outbox.v2." + hash
	keySchema := document.Components.Schemas["OutboxIdempotencyKey"].Value
	if err := keySchema.VisitJSON(outboxKey); err != nil {
		t.Fatalf("outbox idempotency key failed its schema: %v", err)
	}
	if err := keySchema.VisitJSON("openslack.workflow-control-authority.v2." + hash); err == nil {
		t.Fatal("mutation idempotency key matched the outbox key schema")
	}

	route := map[string]any{
		"backend": "go", "authority": "workflow-control", "routingEpoch": float64(9),
		"authorityBuildHash": hash,
	}
	valid := map[string]any{
		"schema":  "openslack.workflow_control_authority_outbox.v2",
		"eventId": "wca-event-contract", "receiptId": "wca-receipt-contract",
		"workspaceId": "workspace.contract", "runId": "run-contract",
		"expected": map[string]any{
			"revision": float64(0), "state": nil, "currentPhaseId": nil,
			"currentPhaseIndex": nil, "resumeGeneration": float64(0),
		},
		"record": map[string]any{
			"schema":      "openslack.workflow_control_authority_run_record.v2",
			"workspaceId": "workspace.contract", "runId": "run-contract",
			"workflowId": "workflow-contract", "workflowVersion": "v1",
			"workflowSourceHash": hash, "manifestHash": hash, "inputHash": hash,
			"route": route, "state": "created", "revision": float64(1),
			"currentPhaseId": nil, "currentPhaseIndex": nil, "resumeGeneration": float64(0),
		},
		"recordHash": hash, "correlationId": "correlation-contract",
	}
	payloadSchema := document.Components.Schemas["OutboxPayload"].Value
	if err := payloadSchema.VisitJSON(valid); err != nil {
		t.Fatalf("valid outbox payload failed its schema: %v", err)
	}

	missing := cloneJSONMap(t, valid)
	delete(missing, "eventId")
	extra := cloneJSONMap(t, valid)
	extra["unexpected"] = true
	wrongRecord := cloneJSONMap(t, valid)
	wrongRecord["record"].(map[string]any)["revision"] = "1"
	for name, value := range map[string]map[string]any{
		"missing field": missing, "additional field": extra, "wrong nested record": wrongRecord,
	} {
		if err := payloadSchema.VisitJSON(value); err == nil {
			t.Fatalf("%s unexpectedly matched OutboxPayload", name)
		}
	}
}

func cloneJSONMap(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var clone map[string]any
	if err := json.Unmarshal(body, &clone); err != nil {
		t.Fatal(err)
	}
	return clone
}

func hasHeader(operation *openapi3.Operation, name string) bool {
	for _, parameter := range operation.Parameters {
		if parameter.Value != nil && parameter.Value.In == "header" && parameter.Value.Name == name {
			return true
		}
		if parameter.Ref != "" {
			referenceName := filepath.Base(parameter.Ref)
			expected := map[string]string{
				"CallerHeader":    "X-OpenSlack-Workflow-Control-Caller-ID",
				"WorkspaceHeader": "X-OpenSlack-Workflow-Control-Workspace-ID",
				"EpochHeader":     "X-OpenSlack-Workflow-Control-Routing-Epoch",
				"BuildHeader":     "X-OpenSlack-Workflow-Control-Expected-Build-SHA",
			}
			if expected[referenceName] == name {
				return true
			}
		}
	}
	return false
}
