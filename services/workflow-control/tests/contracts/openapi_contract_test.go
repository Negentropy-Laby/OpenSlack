package contracts_test

import (
	"context"
	"path/filepath"
	"runtime"
	"sort"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestOpenAPIIsValidAndContainsOnlyShadowRoutes(t *testing.T) {
	_, filename, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(filename), "..", "..", "docs", "api", "openapi.yaml")
	loader := openapi3.NewLoader()
	document, err := loader.LoadFromFile(path)
	if err != nil {
		t.Fatalf("load OpenAPI: %v", err)
	}
	if err := document.Validate(context.Background(), openapi3.DisableSchemaPatternValidation()); err != nil {
		t.Fatalf("validate OpenAPI: %v", err)
	}
	var paths []string
	for route := range document.Paths.Map() {
		paths = append(paths, route)
	}
	sort.Strings(paths)
	expected := []string{
		"/health/live", "/health/ready", "/health/version", "/metrics",
		"/v1/shadow/workflow-control/observations",
		"/v1/shadow/workflow-control/runs/{runId}/projection",
	}
	if len(paths) != len(expected) {
		t.Fatalf("unexpected route count %d: %v", len(paths), paths)
	}
	for index := range expected {
		if paths[index] != expected[index] {
			t.Fatalf("unexpected route set: %v", paths)
		}
	}
	if document.Extensions["x-openslack-authority"] != "typescript" || document.Extensions["x-openslack-authority-eligible"] != false {
		t.Fatalf("authority boundary missing: %+v", document.Extensions)
	}
	receipt := document.Components.Schemas["Receipt"]
	if receipt == nil || receipt.Value == nil {
		t.Fatal("Receipt schema is missing")
	}
	value := receipt.Value
	if len(value.AllOf) != 2 || value.Properties["idempotencyKey"].Value.Pattern != `^openslack\.workflow-control-shadow\.v1\.[0-9a-f]{64}$` ||
		value.Properties["mismatchCode"].Value.Pattern != `^[a-z0-9][a-z0-9._:-]{0,255}$` {
		t.Fatalf("Receipt schema does not lock exact identifiers or conditional states: %+v", value)
	}
	statusBranch := value.AllOf[0].Value
	parityBranch := value.AllOf[1].Value
	if statusBranch == nil || statusBranch.If == nil || statusBranch.Then == nil || statusBranch.Else == nil ||
		statusBranch.Then.Value == nil || statusBranch.Then.Value.Not == nil ||
		statusBranch.Else.Value == nil || statusBranch.Else.Value.Not == nil ||
		parityBranch == nil || parityBranch.If == nil || parityBranch.Then == nil || parityBranch.Else == nil {
		t.Fatal("Receipt schema is missing reconciliation or mismatch conditional constraints")
	}
}
