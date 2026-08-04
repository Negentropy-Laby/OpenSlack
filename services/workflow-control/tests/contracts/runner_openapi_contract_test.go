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

func loadRunnerOpenAPI(t *testing.T) *openapi3.T {
	t.Helper()
	_, filename, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(filename), "..", "..", "docs", "api", "runner-openapi.yaml")
	document, err := openapi3.NewLoader().LoadFromFile(path)
	if err != nil {
		t.Fatalf("load runner OpenAPI: %v", err)
	}
	if err := document.Validate(context.Background(), openapi3.DisableSchemaPatternValidation()); err != nil {
		t.Fatalf("validate runner OpenAPI: %v", err)
	}
	return document
}

func TestRunnerOpenAPILocksRoutesSecurityAndDefaultOffAuthority(t *testing.T) {
	document := loadRunnerOpenAPI(t)
	var routes []string
	for route := range document.Paths.Map() {
		routes = append(routes, route)
	}
	sort.Strings(routes)
	expectedRoutes := []string{
		"/health/live", "/health/ready", "/health/version", "/metrics",
		"/v1/runner/jobs", "/v1/runner/jobs/{jobId}",
		"/v1/runner/jobs/{jobId}/cancellations",
	}
	if fmt.Sprint(routes) != fmt.Sprint(expectedRoutes) {
		t.Fatalf("unexpected runner route set: %v", routes)
	}
	if document.Extensions["x-openslack-default-off"] != true ||
		document.Extensions["x-openslack-workspace-mode"] != "single" ||
		document.Extensions["x-openslack-workflow-authority"] != "typescript" ||
		document.Extensions["x-openslack-authority-eligible"] != false ||
		fmt.Sprint(document.Extensions["x-openslack-go-authority"]) != "[job attempt lease fence cancel receipt]" {
		t.Fatalf("runner authority boundary drifted: %+v", document.Extensions)
	}
	security := document.Components.SecuritySchemes["bearerAuth"]
	if security == nil || security.Value == nil || security.Value.Type != "http" || security.Value.Scheme != "bearer" {
		t.Fatalf("runner bearer security is missing: %+v", security)
	}
	for _, operation := range []*openapi3.Operation{
		document.Paths.Value("/v1/runner/jobs").Post,
		document.Paths.Value("/v1/runner/jobs/{jobId}").Get,
		document.Paths.Value("/v1/runner/jobs/{jobId}/cancellations").Post,
		document.Paths.Value("/metrics").Get,
	} {
		if operation == nil || operation.Security == nil || len(*operation.Security) != 1 {
			t.Fatal("protected runner operation has no exact bearer requirement")
		}
		if _, ok := (*operation.Security)[0]["bearerAuth"]; !ok || !hasWorkspaceHeader(operation) {
			t.Fatal("protected runner operation is missing bearer or single-workspace binding")
		}
	}
	for _, route := range []string{"/health/live", "/health/ready", "/health/version"} {
		operation := document.Paths.Value(route).Get
		if operation == nil || operation.Security == nil || len(*operation.Security) != 0 {
			t.Fatalf("health route %s must explicitly carry no credential dependency", route)
		}
	}
}

func TestRunnerOpenAPIClosesAdmissionAndForbidsLaunchOrGS9Authority(t *testing.T) {
	document := loadRunnerOpenAPI(t)
	for name, reference := range document.Components.Schemas {
		if reference == nil || reference.Value == nil || reference.Value.Type == nil || !reference.Value.Type.Is(openapi3.TypeObject) {
			continue
		}
		if reference.Value.AdditionalProperties.Has == nil || *reference.Value.AdditionalProperties.Has ||
			reference.Value.UnevaluatedProperties.Has == nil || *reference.Value.UnevaluatedProperties.Has {
			t.Fatalf("object schema %s is not closed by both JSON Schema constraints", name)
		}
	}
	job := document.Components.Schemas["JobSpec"].Value
	cancel := document.Components.Schemas["CancelRequest"].Value
	expectedJobProperties := []string{
		"correlationId", "executionDescriptorHash", "executionDescriptorRef", "inputHash",
		"jobId", "manifestHash", "schema", "submittedAt", "wholeTimeoutMs", "workflowId",
		"workflowRunId", "workflowSourceHash", "workflowVersion", "workspaceId",
	}
	var actualJobProperties []string
	for name := range job.Properties {
		actualJobProperties = append(actualJobProperties, name)
	}
	sort.Strings(actualJobProperties)
	if fmt.Sprint(actualJobProperties) != fmt.Sprint(expectedJobProperties) {
		t.Fatalf("job specification is not exact hash-only admission: %v", actualJobProperties)
	}
	forbidden := []string{"command", "path", "args", "url", "prompt", "credential", "providerPayload", "approval", "budget", "checkpoint", "resume"}
	for _, field := range forbidden {
		if job.Properties[field] != nil || cancel.Properties[field] != nil {
			t.Fatalf("forbidden authority field %q entered runner admission", field)
		}
	}
	if fmt.Sprint(document.Extensions["x-openslack-forbidden-authority-fields"]) != fmt.Sprint(forbidden) {
		t.Fatalf("forbidden authority declaration drifted: %v", document.Extensions["x-openslack-forbidden-authority-fields"])
	}
	if job.Properties["executionDescriptorHash"].Ref != "#/components/schemas/Hash" ||
		job.Properties["workflowSourceHash"].Ref != "#/components/schemas/Hash" ||
		job.Properties["manifestHash"].Ref != "#/components/schemas/Hash" ||
		job.Properties["inputHash"].Ref != "#/components/schemas/Hash" {
		t.Fatal("job hash bindings are not exact full SHA-256 references")
	}
}

func TestRunnerOpenAPICancellationReplayKeepsOriginalReceipt(t *testing.T) {
	document := loadRunnerOpenAPI(t)
	operation := document.Paths.Value("/v1/runner/jobs/{jobId}/cancellations").Post
	if operation.Extensions["x-openslack-replay-response"] != "exact-original" {
		t.Fatalf("cancellation replay boundary is missing: %+v", operation.Extensions)
	}
	if operation.Responses.Value("202") == nil || operation.Responses.Value("200") != nil || operation.Responses.Value("201") != nil {
		t.Fatal("cancellation replay must retain the original 202 admission response")
	}
	receipt := document.Components.Schemas["CancelReceipt"].Value
	if receipt.Properties["status"].Value == nil || receipt.Properties["status"].Value.Const != "accepted" {
		t.Fatal("cancellation receipt status must remain accepted on replay")
	}
}

func hasWorkspaceHeader(operation *openapi3.Operation) bool {
	for _, parameter := range operation.Parameters {
		if parameter.Ref == "#/components/parameters/WorkspaceHeader" ||
			(parameter.Value != nil && parameter.Value.In == "header" && parameter.Value.Name == "X-OpenSlack-Workspace-ID") {
			return true
		}
	}
	return false
}
