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

func TestOpenAPI31LoadsAndClosesTheGS5Surface(t *testing.T) {
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
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("OpenAPI missing %q", required)
		}
	}
	if strings.Contains(source, "rawToken") {
		t.Fatal("OpenAPI exposes a raw confirmation capability")
	}
}
