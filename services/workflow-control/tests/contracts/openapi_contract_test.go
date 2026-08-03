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
}
