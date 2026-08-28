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
	loader := openapi3.NewLoader()
	document, err := loader.LoadFromFile(path)
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
		"/v2/runner/authority-bindings/receipts/{idempotencyKey}",
		"/v2/runner/authority-bindings/{bindingId}:ack-control",
		"/v2/runner/authority-bindings/{bindingId}:resolve",
		"/v2/runner/authority-bindings:stage",
		"/v2/runner/jobs",
		"/v2/runner/runtime-admissions:seal",
	}
	if fmt.Sprint(routes) != fmt.Sprint(expectedRoutes) {
		t.Fatalf("unexpected runner route set: %v", routes)
	}
	if document.Extensions["x-openslack-default-off"] != true ||
		document.Extensions["x-openslack-workspace-mode"] != "single" ||
		document.Extensions["x-openslack-workflow-authority"] != "typescript" ||
		document.Extensions["x-openslack-authority-eligible"] != false ||
		document.Extensions["x-openslack-v2-runtime-delivery-default-off"] != true ||
		document.Extensions["x-openslack-production-v2-submission"] != false ||
		document.Extensions["x-openslack-production-v2-routing"] != false ||
		document.Extensions["x-openslack-max-request-bytes"] != float64(1_048_576) ||
		document.Extensions["x-openslack-job-request-max-bytes"] != float64(65_536) ||
		document.Extensions["x-openslack-authority-binding-request-max-bytes"] != float64(1_048_576) ||
		fmt.Sprint(document.Extensions["x-openslack-go-authority"]) != "[job attempt lease fence cancel receipt runtime_admission authority_binding]" {
		t.Fatalf("runner authority boundary drifted: %+v", document.Extensions)
	}
	security := document.Components.SecuritySchemes["bearerAuth"]
	if security == nil || security.Value == nil || security.Value.Type != "http" || security.Value.Scheme != "bearer" {
		t.Fatalf("runner bearer security is missing: %+v", security)
	}
	for _, operation := range []*openapi3.Operation{
		document.Paths.Value("/v1/runner/jobs").Post,
		document.Paths.Value("/v2/runner/jobs").Post,
		document.Paths.Value("/v1/runner/jobs/{jobId}").Get,
		document.Paths.Value("/v1/runner/jobs/{jobId}/cancellations").Post,
		document.Paths.Value("/v2/runner/runtime-admissions:seal").Post,
		document.Paths.Value("/v2/runner/authority-bindings:stage").Post,
		document.Paths.Value("/v2/runner/authority-bindings/{bindingId}:resolve").Post,
		document.Paths.Value("/v2/runner/authority-bindings/{bindingId}:ack-control").Post,
		document.Paths.Value("/v2/runner/authority-bindings/receipts/{idempotencyKey}").Get,
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

func TestRunnerOpenAPIRuntimeAdmissionSealsDurableDisposition(t *testing.T) {
	document := loadRunnerOpenAPI(t)
	operation := document.Paths.Value("/v2/runner/runtime-admissions:seal").Post
	if operation == nil || operation.Extensions["x-openslack-qualification-only"] != true ||
		operation.Extensions["x-openslack-runtime-delivery-enable-required"] != true ||
		operation.Extensions["x-openslack-loopback-only"] != true ||
		operation.Extensions["x-openslack-canonical-json-lf"] != "required" ||
		operation.Extensions["x-openslack-replay-response"] != "exact-original" ||
		operation.Responses.Value("201") == nil || operation.Responses.Value("200") == nil ||
		operation.Responses.Value("202") != nil {
		t.Fatalf("runtime-admission response boundary drifted: %+v", operation)
	}
	hash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	admission := map[string]any{
		"schema": "openslack.workflow_runner_v2_runtime_admission.v1", "workspaceId": "workspace.test",
		"jobId": "job.test", "workflowRunId": "run.test", "attemptId": "attempt.test",
		"leaseId": "lease.test", "fencingToken": int64(1), "jobSpecHash": hash, "disposition": "resume",
	}
	schema := document.Components.Schemas["V2RuntimeAdmission"].Value
	if err := schema.VisitJSON(admission); err != nil {
		t.Fatalf("valid runtime admission rejected: %v", err)
	}
	invalid := cloneJSONMap(t, admission)
	invalid["disposition"] = "completed"
	if err := schema.VisitJSON(invalid); err == nil {
		t.Fatal("completed replay was accepted as a runtime disposition")
	}
	receipt := cloneJSONMap(t, admission)
	receipt["schema"] = "openslack.workflow_runner_v2_runtime_admission_receipt.v1"
	receipt["status"] = "accepted"
	receipt["idempotencyKey"] = "openslack.workflow-runner-v2-runtime-admission.v1." + hash
	receipt["requestFingerprint"] = "sha256:" + hash
	receipt["committedAt"] = "2026-08-22T00:00:00.000Z"
	if err := document.Components.Schemas["V2RuntimeAdmissionReceipt"].Value.VisitJSON(receipt); err != nil {
		t.Fatalf("valid runtime admission receipt rejected: %v", err)
	}
}

func TestRunnerOpenAPIV2QualificationAdmissionAndReceiptAreClosed(t *testing.T) {
	document := loadRunnerOpenAPI(t)
	operation := document.Paths.Value("/v2/runner/jobs").Post
	if operation == nil || operation.Extensions["x-openslack-qualification-only"] != true ||
		operation.Extensions["x-openslack-no-protocol-downgrade"] != true ||
		operation.Extensions["x-openslack-replay-response"] != "exact-original" ||
		operation.Responses.Value("201") == nil || operation.Responses.Value("200") == nil || operation.Responses.Value("202") == nil {
		t.Fatalf("v2 qualification response contract drifted: %+v", operation)
	}
	hash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	spec := map[string]any{
		"schema": "openslack.workflow_runner_job_spec.v2", "workspaceId": "workspace.test", "jobId": "job.test",
		"workflowRunId": "run.test", "correlationId": "correlation.test", "executionDescriptorRef": "descriptor.test",
		"executionDescriptorHash": hash, "workflowId": "workflow.test", "workflowVersion": "1.0.0",
		"workflowSourceHash": hash, "manifestHash": hash, "inputHash": hash, "wholeTimeoutMs": int64(60_000),
		"submittedAt": "2026-08-15T00:00:00.000Z", "requiredProtocolVersion": "openslack.workflow_runner.v2",
		"requiredCapabilities": []any{"cancel_ack", "effect_receipts", "lease_heartbeat"},
		"authorityRoute":       map[string]any{"backend": "ts-local", "authority": "typescript", "routingEpoch": int64(1), "authorityBuildHash": hash},
		"runRevision":          int64(1), "resumeGeneration": int64(0),
	}
	specSchema := document.Components.Schemas["V2JobSpec"].Value
	if err := specSchema.VisitJSON(spec); err != nil {
		t.Fatalf("valid v2 spec rejected: %v", err)
	}
	goRoute := cloneJSONMap(t, spec)
	goRoute["authorityRoute"] = map[string]any{
		"backend": "go", "authority": "workflow-control", "routingEpoch": int64(1), "authorityBuildHash": hash,
	}
	if err := specSchema.VisitJSON(goRoute); err != nil {
		t.Fatalf("valid default-off F2b qualification route rejected: %v", err)
	}
	crossSplicedRoute := cloneJSONMap(t, spec)
	crossSplicedRoute["authorityRoute"] = map[string]any{
		"backend": "go", "authority": "typescript", "routingEpoch": int64(1), "authorityBuildHash": hash,
	}
	if err := specSchema.VisitJSON(crossSplicedRoute); err == nil {
		t.Fatal("cross-spliced v2 authority route was accepted")
	}
	invalidVersion := cloneJSONMap(t, spec)
	invalidVersion["workflowVersion"] = "latest"
	if err := specSchema.VisitJSON(invalidVersion); err == nil {
		t.Fatal("non-semver v2 workflowVersion was accepted")
	}
	extra := cloneJSONMap(t, spec)
	extra["command"] = "node"
	if err := specSchema.VisitJSON(extra); err == nil {
		t.Fatal("v2 admission accepted an unknown launch field")
	}

	receiptSchema := document.Components.Schemas["V2JobReceipt"].Value
	accepted := map[string]any{
		"schema": "openslack.workflow_runner_job_receipt.v2", "status": "accepted", "workspaceId": "workspace.test",
		"jobId": "job.test", "workflowRunId": "run.test", "state": "queued", "revision": int64(1), "jobSpecHash": hash,
		"idempotencyKey": "openslack.workflow-runner-job.v2." + hash, "requestFingerprint": "sha256:" + hash,
		"committedAt": "2026-08-15T00:00:00.000Z", "reconciliationId": nil,
	}
	if err := receiptSchema.VisitJSON(accepted); err != nil {
		t.Fatalf("valid accepted v2 receipt rejected: %v", err)
	}
	reconciliation := cloneJSONMap(t, accepted)
	reconciliation["status"], reconciliation["state"], reconciliation["reconciliationId"] = "reconciliation_required", "reconciliation_required", "reconciliation.test"
	if err := receiptSchema.VisitJSON(reconciliation); err != nil {
		t.Fatalf("valid reconciliation v2 receipt rejected: %v", err)
	}
	for name, invalid := range map[string]map[string]any{
		"accepted with reconciliation": func() map[string]any {
			value := cloneJSONMap(t, accepted)
			value["reconciliationId"] = "unexpected"
			return value
		}(),
		"reconciliation without id": func() map[string]any {
			value := cloneJSONMap(t, reconciliation)
			value["reconciliationId"] = nil
			return value
		}(),
		"accepted wrong state": func() map[string]any {
			value := cloneJSONMap(t, accepted)
			value["state"] = "reconciliation_required"
			return value
		}(),
		"accepted wrong revision": func() map[string]any { value := cloneJSONMap(t, accepted); value["revision"] = int64(2); return value }(),
	} {
		t.Run(name, func(t *testing.T) {
			if err := receiptSchema.VisitJSON(invalid); err == nil {
				t.Fatal("invalid v2 receipt variant was accepted")
			}
		})
	}
}

func TestRunnerOpenAPIAuthorityBindingCompanionIsExactDefaultOffQualificationOnly(t *testing.T) {
	document := loadRunnerOpenAPI(t)
	for _, operation := range []*openapi3.Operation{
		document.Paths.Value("/v2/runner/authority-bindings:stage").Post,
		document.Paths.Value("/v2/runner/authority-bindings/{bindingId}:resolve").Post,
		document.Paths.Value("/v2/runner/authority-bindings/{bindingId}:ack-control").Post,
		document.Paths.Value("/v2/runner/authority-bindings/receipts/{idempotencyKey}").Get,
	} {
		if operation == nil || operation.Extensions["x-openslack-qualification-only"] != true ||
			operation.Extensions["x-openslack-runtime-delivery-enable-required"] != true ||
			operation.Extensions["x-openslack-loopback-only"] != true {
			t.Fatalf("authority-binding route widened beyond explicit qualification: %+v", operation)
		}
	}
	for _, route := range []string{
		"/v2/runner/authority-bindings:stage",
		"/v2/runner/authority-bindings/{bindingId}:resolve",
		"/v2/runner/authority-bindings/{bindingId}:ack-control",
	} {
		operation := document.Paths.Value(route).Post
		if operation.Extensions["x-openslack-canonical-json-lf"] != "required" ||
			operation.Extensions["x-openslack-replay-response"] != "exact-original" ||
			operation.Responses.Value("201") == nil || operation.Responses.Value("200") == nil || operation.Responses.Value("202") == nil {
			t.Fatalf("authority-binding mutation response contract drifted for %s: %+v", route, operation)
		}
	}
	for _, name := range []string{"AuthorityBindingStage", "AuthorityBindingResolution", "AuthorityBindingReceipt"} {
		if document.Components.Schemas[name] == nil || document.Components.Schemas[name].Value == nil {
			t.Fatalf("authority-binding exact schema %s was not resolved", name)
		}
	}
	version := document.Components.Schemas["Version"].Value
	if version.Properties["schemaVersion"].Value.Max == nil || *version.Properties["schemaVersion"].Value.Max != 8 ||
		version.Properties["v2RuntimeDeliveryQualification"] == nil ||
		version.Properties["productionRoutingActivated"].Value.Const != false {
		t.Fatalf("schema-8 runtime-delivery version surface drifted: %+v", version.Properties)
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
