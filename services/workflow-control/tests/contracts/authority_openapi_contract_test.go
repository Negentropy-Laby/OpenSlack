package contracts_test

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"sort"
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
	if err := document.Validate(context.Background(), openapi3.DisableSchemaPatternValidation()); err != nil {
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
		document.Extensions["x-openslack-mode"] != "local-qualification-v1" ||
		document.Extensions["x-openslack-workflow-authority"] != "typescript" ||
		document.Extensions["x-openslack-routing-activated"] != false ||
		document.Extensions["x-openslack-accept-new-records"] != false ||
		fmt.Sprint(document.Extensions["x-openslack-network-modes"]) != "[loopback]" {
		t.Fatalf("negative production authority declaration drifted: %+v", document.Extensions)
	}
	for _, route := range []string{"/health/live", "/health/ready", "/health/version"} {
		operation := document.Paths.Value(route).Get
		if operation == nil || operation.Security == nil || len(*operation.Security) != 0 {
			t.Fatalf("health route %s must have no credential dependency", route)
		}
	}
	protected := []*openapi3.Operation{
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
