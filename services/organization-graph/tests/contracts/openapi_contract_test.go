package contracts

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers/gorillamux"
	"gopkg.in/yaml.v3"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/app"
)

func serviceRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(current), "..", ".."))
}

func openAPI(t *testing.T) string {
	t.Helper()
	path := filepath.Join(serviceRoot(t), "docs", "api", "openapi.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(body)
}

func loadOpenAPI(t *testing.T) *openapi3.T {
	t.Helper()
	path := filepath.Join(serviceRoot(t), "docs", "api", "openapi.yaml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateNoDuplicateYAMLKeys(body); err != nil {
		t.Fatalf("strict YAML validation failed: %v", err)
	}
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = true
	document, err := loader.LoadFromFile(path)
	if err != nil {
		t.Fatalf("kin-openapi LoadFromFile: %v", err)
	}
	// The exact-byte contract schemas use ECMAScript \uNNNN pattern escapes.
	// kin-openapi's document validator uses Go RE2, so structural OpenAPI
	// validation disables only its pattern compilation. The exchange filter
	// below supplies an explicit compiler for that frozen ECMAScript subset and
	// therefore still validates request/response pattern values.
	if err := document.Validate(context.Background(), openapi3.DisableSchemaPatternValidation()); err != nil {
		t.Fatalf("kin-openapi Validate: %v", err)
	}
	return document
}

var unicodeEscapePattern = regexp.MustCompile(`\\u([0-9A-Fa-f]{4})`)

func ecmaSubsetRegexCompiler(expression string) (openapi3.RegexMatcher, error) {
	translated := unicodeEscapePattern.ReplaceAllString(expression, `\x{$1}`)
	return regexp.Compile(translated)
}

func validateNoDuplicateYAMLKeys(body []byte) error {
	var document yaml.Node
	if err := yaml.Unmarshal(body, &document); err != nil {
		return err
	}
	return walkYAMLKeys(&document)
}

func walkYAMLKeys(node *yaml.Node) error {
	if node.Kind == yaml.MappingNode {
		seen := map[string]int{}
		for index := 0; index+1 < len(node.Content); index += 2 {
			key := node.Content[index]
			if firstLine, duplicate := seen[key.Value]; duplicate {
				return fmt.Errorf(
					"duplicate mapping key %q at line %d (first at line %d)",
					key.Value,
					key.Line,
					firstLine,
				)
			}
			seen[key.Value] = key.Line
			if err := walkYAMLKeys(node.Content[index+1]); err != nil {
				return err
			}
		}
		return nil
	}
	for _, child := range node.Content {
		if err := walkYAMLKeys(child); err != nil {
			return err
		}
	}
	return nil
}

func TestOpenAPI31FreezesEveryImplementedRoute(t *testing.T) {
	document := openAPI(t)
	if !strings.HasPrefix(document, "openapi: 3.1.0\n") {
		t.Fatal("OpenAPI document is not version 3.1.0")
	}
	for _, route := range []string{
		app.RouteSnapshotIngest,
		app.RouteDeltaIngest,
		app.RouteQuery,
		app.RouteExplain,
		app.RouteCanaryQuery,
		app.RouteCanaryExplain,
		app.RouteAuthoritySnapshotIngest,
		app.RouteAuthorityDeltaIngest,
		app.RouteAuthorityQuery,
		app.RouteAuthorityExplain,
		app.RouteScenarios,
		app.RouteLive,
		app.RouteReady,
		app.RouteVersion,
		app.RouteMetrics,
	} {
		if count := strings.Count(document, "  "+route+":\n"); count != 1 {
			t.Fatalf("route %s appears %d times in OpenAPI, want exactly once", route, count)
		}
	}
	if !strings.Contains(document, "x-openslack-max-request-body-bytes: 67108864") {
		t.Fatal("OpenAPI does not freeze the 64 MiB request body ceiling")
	}
	if !strings.Contains(document, "x-openslack-max-response-body-bytes: 8388608") {
		t.Fatal("OpenAPI does not freeze the 8 MiB response body ceiling")
	}
}

func TestOpenAPILoadsAndValidatesWithKinOpenAPI(t *testing.T) {
	document := loadOpenAPI(t)
	if document.OpenAPI != "3.1.0" {
		t.Fatalf("OpenAPI = %q", document.OpenAPI)
	}
}

func TestStrictYAMLValidatorRejectsDuplicateMappingKeys(t *testing.T) {
	err := validateNoDuplicateYAMLKeys([]byte("openapi: 3.1.0\ninfo:\n  title: one\n  title: two\n"))
	if err == nil || !strings.Contains(err.Error(), `duplicate mapping key "title"`) {
		t.Fatalf("duplicate key error = %v", err)
	}
}

func TestECMAScriptContractPatternCompilerPreservesControlRejection(t *testing.T) {
	matcher, err := ecmaSubsetRegexCompiler(`^[^\u0000-\u001f\u007f]+$`)
	if err != nil {
		t.Fatal(err)
	}
	if !matcher.MatchString("scenario-1") || matcher.MatchString("scenario\n1") {
		t.Fatal("ECMAScript subset compiler changed identifier pattern semantics")
	}
}

func TestOpenAPIFreezesExactFingerprintAndIdempotencyContract(t *testing.T) {
	document := openAPI(t)
	for _, required := range []string{
		`sha256("POST\n/v1/graph/snapshots:ingest\n" + canonicalBody)`,
		`sha256("POST\n/v1/graph/deltas:ingest\n" + canonicalBody)`,
		"`openslack.graph-shadow.v1.` followed by a lowercase hexadecimal digest",
		"duplicate or unknown JSON fields",
		"same key with a different fingerprint returns 409",
		"pattern: '^[A-Za-z0-9._:-]+$'",
	} {
		if !strings.Contains(document, required) {
			t.Fatalf("OpenAPI is missing fingerprint/idempotency contract %q", required)
		}
	}
}

func TestOpenAPIFreezesReceiptSchemaAndConditionalEvidence(t *testing.T) {
	document := openAPI(t)
	if !strings.Contains(document,
		"$id: https://schemas.openslack.dev/organization-graph/graph-ingest-receipt.v1.schema.json") {
		t.Fatal("receipt $id is not frozen")
	}
	for _, field := range []string{
		"schema",
		"operation",
		"status",
		"idempotencyKey",
		"requestFingerprint",
		"scenarioInstanceId",
		"cursor",
		"revision",
		"snapshotIntegrityHash",
	} {
		if !strings.Contains(document, "        - "+field+"\n") {
			t.Fatalf("receipt required field %s is not frozen", field)
		}
	}
	for _, token := range []string{
		"const: openslack.graph_ingest_receipt.v1",
		"enum: [snapshot_ingest, delta_ingest]",
		"enum: [accepted, duplicate, reconciliation_required]",
		"minimum: 1",
		"maximum: 9007199254740991",
		"description: Candidate target revision for reconciliation_required; not proof of commit.",
		"required: [deltaIntegrityHash]",
		"required: [committedAt]",
		"required: [reconciliationToken]",
	} {
		if !strings.Contains(document, token) {
			t.Fatalf("receipt conditional contract missing %q", token)
		}
	}
}

func TestOpenAPIFreezesFailureAndAmbiguousCommitMappings(t *testing.T) {
	document := openAPI(t)
	for _, status := range []string{"'404':", "'409':", "'413':", "'422':", "'503':"} {
		if !strings.Contains(document, status) {
			t.Fatalf("OpenAPI missing error mapping %s", status)
		}
	}
	for _, code := range []string{
		"GRAPH_NOT_FOUND",
		"GRAPH_CONFLICT",
		"GRAPH_REQUEST_TOO_LARGE",
		"GRAPH_UNPROCESSABLE",
		"GRAPH_UNAVAILABLE",
		"GRAPH_INTERNAL",
		"GRAPH_CANARY_NOT_CONFIGURED",
		"GRAPH_CANARY_ROUTE_MISMATCH",
		"GRAPH_AUTHORITY_NOT_CONFIGURED",
		"GRAPH_AUTHORITY_ROUTE_MISMATCH",
		"GRAPH_QUERY_CURSOR_INVALID",
		"GRAPH_QUERY_CURSOR_EXPIRED",
		"GRAPH_QUERY_CURSOR_MISMATCH",
	} {
		if !strings.Contains(document, "- "+code) {
			t.Fatalf("OpenAPI missing stable error code %s", code)
		}
	}
	if count := strings.Count(document, "'202':"); count != 4 {
		t.Fatalf("202 reconciliation response count = %d, want 4", count)
	}
	if !strings.Contains(document, "A durable reconciliation receipt because commit outcome is ambiguous") {
		t.Fatal("ambiguous commit is not frozen as a durable receipt")
	}
}

func TestOpenAPIReferencesExactByteGraphContractSchemas(t *testing.T) {
	document := openAPI(t)
	for _, reference := range []string{
		"../../../../packages/organization-graph/contracts/v1/schemas/graph-snapshot.v1.schema.json",
		"../../../../packages/organization-graph/contracts/v1/schemas/graph-delta.v1.schema.json",
	} {
		if !strings.Contains(document, reference) {
			t.Fatalf("OpenAPI missing generated contract reference %s", reference)
		}
		path := strings.Split(reference, "#")[0]
		resolved := filepath.Join(serviceRoot(t), "docs", "api", path)
		if _, err := os.Stat(resolved); err != nil {
			t.Fatalf("OpenAPI reference %s does not resolve: %v", reference, err)
		}
		body, err := os.ReadFile(resolved)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(body, []byte(`"pattern": "^[^\\u0000-\\u001f\\u007f]+$"`)) {
			t.Fatalf("external exact-byte contract %s lost its frozen ECMAScript pattern", reference)
		}
	}
}

func TestOpenAPIFilterValidatesSnapshotRequestReceiptAndErrorExchange(t *testing.T) {
	document := loadOpenAPI(t)
	router, err := gorillamux.NewRouter(document)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := contractSnapshot(t)
	snapshotBytes, err := graph.SerializeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	snapshotValue, err := graph.ParseCanonicalJSON(snapshotBytes, graph.DefaultJSONLimits())
	if err != nil {
		t.Fatal(err)
	}
	requestBody, err := graph.CanonicalJSON(graph.Object{
		"expectedCursor": nil,
		"snapshot":       snapshotValue,
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(
		http.MethodPost,
		"http://127.0.0.1:8080"+app.RouteSnapshotIngest,
		bytes.NewReader(requestBody),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "openslack.graph-shadow.v1."+strings.Repeat("a", 64))
	route, pathParameters, err := router.FindRoute(request)
	if err != nil {
		t.Fatal(err)
	}
	requestInput := &openapi3filter.RequestValidationInput{
		Request:    request,
		PathParams: pathParameters,
		Route:      route,
		Options: &openapi3filter.Options{
			RegexCompiler: ecmaSubsetRegexCompiler,
		},
	}
	if err := openapi3filter.ValidateRequest(context.Background(), requestInput); err != nil {
		t.Fatalf("snapshot request failed OpenAPI filter: %v", err)
	}

	receiptBody := []byte(fmt.Sprintf(
		`{"schema":"openslack.graph_ingest_receipt.v1","operation":"snapshot_ingest","status":"accepted","idempotencyKey":"openslack.graph-shadow.v1.%s","requestFingerprint":"sha256:%s","scenarioInstanceId":"scenario-contract","cursor":"cursor-1","revision":1,"snapshotIntegrityHash":%q,"committedAt":"2026-07-30T10:00:00Z"}`,
		strings.Repeat("a", 64),
		strings.Repeat("b", 64),
		snapshot.IntegrityHash,
	))
	responseInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: requestInput,
		Status:                 http.StatusCreated,
		Header:                 http.Header{"Content-Type": []string{"application/json"}},
		Body:                   io.NopCloser(bytes.NewReader(receiptBody)),
		Options: &openapi3filter.Options{
			IncludeResponseStatus: true,
			SchemaValidationOptions: []openapi3.SchemaValidationOption{
				openapi3.SetSchemaRegexCompiler(ecmaSubsetRegexCompiler),
			},
		},
	}
	if err := openapi3filter.ValidateResponse(context.Background(), responseInput); err != nil {
		t.Fatalf("accepted receipt failed OpenAPI filter: %v", err)
	}

	errorBody := []byte(`{"schema":"openslack.graph_error.v1","code":"GRAPH_UNPROCESSABLE","message":"graph contract validation failed"}`)
	errorInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: requestInput,
		Status:                 http.StatusUnprocessableEntity,
		Header:                 http.Header{"Content-Type": []string{"application/json"}},
		Body:                   io.NopCloser(bytes.NewReader(errorBody)),
		Options: &openapi3filter.Options{
			IncludeResponseStatus: true,
			SchemaValidationOptions: []openapi3.SchemaValidationOption{
				openapi3.SetSchemaRegexCompiler(ecmaSubsetRegexCompiler),
			},
		},
	}
	if err := openapi3filter.ValidateResponse(context.Background(), errorInput); err != nil {
		t.Fatalf("error response failed OpenAPI filter: %v", err)
	}
}

func contractSnapshot(t *testing.T) graph.Snapshot {
	t.Helper()
	authority := graph.AuthorityRef{
		Provider:   "github",
		ObjectType: "issue",
		ObjectID:   "42",
		Version:    "v1",
		ObservedAt: "2026-07-30T09:00:00Z",
	}
	nodeID, err := graph.DeriveNodeID("scenario-contract", "core.work_item", authority)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := graph.SealSnapshot(graph.Snapshot{
		Schema:             graph.SnapshotSchema,
		Cursor:             "cursor-1",
		ScenarioInstanceID: "scenario-contract",
		GeneratedAt:        time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC).Format(time.RFC3339),
		ProjectorVersion:   "projector-v1",
		Nodes: []graph.Node{{
			ID:                   nodeID,
			Type:                 "core.work_item",
			ScenarioDefinitionID: "software-delivery",
			ScenarioInstanceID:   "scenario-contract",
			Title:                "Issue 42",
			AuthorityRef:         authority,
			Owners:               []graph.ActorRef{},
			Properties:           graph.Object{},
			SourceEventIDs:       []string{},
			EvidenceRefs:         []string{"github:issue:42"},
			ProjectorVersion:     "projector-v1",
			ValidFrom:            "2026-07-30T09:00:00Z",
		}},
		Edges: []graph.Edge{},
		Completeness: graph.Completeness{
			SourcesRequested: []string{"github"},
			SourcesObserved:  []string{"github"},
			MissingSources:   []string{},
			Warnings:         []string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}
