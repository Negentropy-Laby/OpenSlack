package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/app"
	graphpostgres "github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/testsupport"
)

const (
	qualificationBuildSHA  = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	qualificationCursorKey = "qualification-cursor-secret-0123456789abcdef"
	restartScenario        = "scenario-gs1c-restart"
	restartCursor          = "cursor-restart-001"
	restartIdempotencyKey  = "gs1c-restart-snapshot"
)

var qualificationSchemaPattern = regexp.MustCompile(`^organization_graph_gs1c_restart_[a-z0-9]+$`)

func qualificationSnapshot(
	t testing.TB,
	scenarioInstanceID string,
	cursor string,
	generatedAt string,
	objectIDs ...string,
) graph.Snapshot {
	t.Helper()
	nodes := make([]graph.Node, 0, len(objectIDs))
	for _, objectID := range objectIDs {
		authority := graph.AuthorityRef{
			Provider: "openslack", ObjectType: "gs1c-work-item", ObjectID: objectID,
			Version: "v1", ObservedAt: generatedAt,
		}
		id, err := graph.DeriveNodeID(scenarioInstanceID, "core.work_item", authority)
		if err != nil {
			t.Fatal(err)
		}
		nodes = append(nodes, graph.Node{
			ID: id, Type: "core.work_item", ScenarioDefinitionID: "gs1c-qualification",
			ScenarioInstanceID: scenarioInstanceID, Title: "Work item " + objectID,
			AuthorityRef: authority, Owners: []graph.ActorRef{}, Properties: graph.Object{},
			SourceEventIDs: []string{}, EvidenceRefs: []string{}, ProjectorVersion: "gs1c-projector-v1",
			ValidFrom: generatedAt,
		})
	}
	snapshot, err := graph.SealSnapshot(graph.Snapshot{
		Schema: graph.SnapshotSchema, Cursor: cursor, ScenarioInstanceID: scenarioInstanceID,
		GeneratedAt: generatedAt, ProjectorVersion: "gs1c-projector-v1", Nodes: nodes,
		Edges: []graph.Edge{}, Completeness: graph.Completeness{
			SourcesRequested: []string{"openslack"}, SourcesObserved: []string{"openslack"},
			MissingSources: []string{}, Warnings: []string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func qualificationDelta(t testing.TB, parent, target graph.Snapshot) graph.Delta {
	t.Helper()
	parentNodes := make(map[string]struct{}, len(parent.Nodes))
	for _, node := range parent.Nodes {
		parentNodes[node.ID] = struct{}{}
	}
	upsertNodes := make([]graph.Node, 0, len(target.Nodes)-len(parent.Nodes))
	for _, node := range target.Nodes {
		if _, exists := parentNodes[node.ID]; !exists {
			upsertNodes = append(upsertNodes, node)
		}
	}
	delta, err := graph.SealDelta(graph.Delta{
		Schema: graph.DeltaSchema, ScenarioInstanceID: parent.ScenarioInstanceID,
		FromCursor: parent.Cursor, ToCursor: target.Cursor, GeneratedAt: target.GeneratedAt,
		UpsertNodes: upsertNodes, CloseNodeIDs: []string{},
		UpsertEdges: []graph.Edge{}, CloseEdgeIDs: []string{}, EvidenceRefs: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return delta
}

func qualificationCanonicalValue(t testing.TB, raw []byte) graph.Value {
	t.Helper()
	value, err := graph.ParseCanonicalJSON(raw, graph.DefaultJSONLimits())
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func qualificationSnapshotBody(t testing.TB, expectedCursor *string, snapshot graph.Snapshot) []byte {
	t.Helper()
	raw, err := graph.SerializeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	body, err := graph.CanonicalJSON(graph.Object{
		"expectedCursor": qualificationOptionalString(expectedCursor),
		"snapshot":       qualificationCanonicalValue(t, raw),
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func qualificationDeltaBody(t testing.TB, expectedCursor string, target graph.Snapshot, delta graph.Delta) []byte {
	t.Helper()
	targetRaw, err := graph.SerializeSnapshot(target)
	if err != nil {
		t.Fatal(err)
	}
	deltaRaw, err := graph.SerializeDelta(delta)
	if err != nil {
		t.Fatal(err)
	}
	body, err := graph.CanonicalJSON(graph.Object{
		"expectedCursor": expectedCursor,
		"targetSnapshot": qualificationCanonicalValue(t, targetRaw),
		"delta":          qualificationCanonicalValue(t, deltaRaw),
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func qualificationOptionalString(value *string) graph.Value {
	if value == nil {
		return nil
	}
	return *value
}

func qualificationRequest(
	t testing.TB,
	service *app.Service,
	method string,
	path string,
	key string,
	body []byte,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	return response
}

func qualificationService(t testing.TB, pool *pgxpool.Pool) *app.Service {
	t.Helper()
	service, err := app.New(app.Options{
		Store:        &storeAdapter{store: graphpostgres.New(pool), pool: pool},
		CursorSecret: []byte(qualificationCursorKey), BuildSHA: qualificationBuildSHA,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestGS1CHTTPPostgresCompositionQualification(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	if err := checkDatabaseReady(context.Background(), pool); err != nil {
		t.Fatalf("migrated database is not ready: %v", err)
	}
	service := qualificationService(t, pool)
	first := qualificationSnapshot(t, "scenario-gs1c-http", "cursor-001", "2026-08-01T00:00:00Z", "1")
	firstBody := qualificationSnapshotBody(t, nil, first)
	accepted := qualificationRequest(t, service, http.MethodPost, app.RouteSnapshotIngest, "gs1c-http-first", firstBody)
	if accepted.Code != http.StatusCreated {
		t.Fatalf("initial snapshot status/body = %d %s", accepted.Code, accepted.Body.String())
	}
	duplicate := qualificationRequest(t, service, http.MethodPost, app.RouteSnapshotIngest, "gs1c-http-first", firstBody)
	if duplicate.Code != http.StatusOK || !strings.Contains(duplicate.Body.String(), `"status":"duplicate"`) {
		t.Fatalf("duplicate status/body = %d %s", duplicate.Code, duplicate.Body.String())
	}

	second := qualificationSnapshot(t, first.ScenarioInstanceID, "cursor-002", "2026-08-01T00:01:00Z", "1", "2")
	full := qualificationRequest(t, service, http.MethodPost, app.RouteSnapshotIngest, "gs1c-http-full", qualificationSnapshotBody(t, &first.Cursor, second))
	if full.Code != http.StatusCreated {
		t.Fatalf("full snapshot CAS status/body = %d %s", full.Code, full.Body.String())
	}
	third := qualificationSnapshot(t, first.ScenarioInstanceID, "cursor-003", "2026-08-01T00:02:00Z", "1", "2", "3")
	delta := qualificationDelta(t, second, third)
	deltaResponse := qualificationRequest(t, service, http.MethodPost, app.RouteDeltaIngest, "gs1c-http-delta", qualificationDeltaBody(t, second.Cursor, third, delta))
	if deltaResponse.Code != http.StatusCreated {
		t.Fatalf("delta status/body = %d %s", deltaResponse.Code, deltaResponse.Body.String())
	}
	query := qualificationRequest(t, service, http.MethodPost, app.RouteQuery, "", []byte(`{"scenarioInstanceId":"scenario-gs1c-http"}`))
	if query.Code != http.StatusOK || !strings.Contains(query.Body.String(), `"snapshotCursor":"cursor-003"`) {
		t.Fatalf("query status/body = %d %s", query.Code, query.Body.String())
	}
}

func TestGS1CSchemaReadinessRejectsEveryIncompatibleState(t *testing.T) {
	if os.Getenv("GRAPH_GS1C_SCHEMA_QUALIFICATION") != "1" {
		t.Skip("set GRAPH_GS1C_SCHEMA_QUALIFICATION=1 for the single-run schema gate")
	}
	tests := []struct {
		name      string
		rows      [][2]any
		makeTable bool
	}{
		{name: "missing table"},
		{name: "old version", makeTable: true, rows: [][2]any{{int64(1), false}}},
		{name: "future version", makeTable: true, rows: [][2]any{{int64(3), false}}},
		{name: "dirty", makeTable: true, rows: [][2]any{{int64(2), true}}},
		{name: "multiple rows", makeTable: true, rows: [][2]any{{int64(2), false}, {int64(2), false}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			schemaURL := testsupport.OpenMigrationSchemaURL(t)
			pool, err := pgxpool.New(context.Background(), schemaURL)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			if test.makeTable {
				if _, err := pool.Exec(context.Background(), `CREATE TABLE schema_migrations (version BIGINT NOT NULL, dirty BOOLEAN NOT NULL)`); err != nil {
					t.Fatal(err)
				}
				for _, row := range test.rows {
					if _, err := pool.Exec(context.Background(), `INSERT INTO schema_migrations (version, dirty) VALUES ($1, $2)`, row[0], row[1]); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := checkDatabaseReady(context.Background(), pool); err == nil {
				t.Fatal("incompatible schema was reported ready")
			}
		})
	}
}

func TestGS1CRestartQualificationPhase(t *testing.T) {
	phase := os.Getenv("GRAPH_GS1C_RESTART_PHASE")
	if phase == "" {
		t.Skip("GRAPH_GS1C_RESTART_PHASE is not set")
	}
	schema := os.Getenv("GRAPH_GS1C_RESTART_SCHEMA")
	if !qualificationSchemaPattern.MatchString(schema) {
		t.Fatalf("unsafe restart qualification schema %q", schema)
	}
	baseURL := testsupport.NormalizePoolURL(t, os.Getenv("DATABASE_URL"))
	admin, err := pgxpool.New(context.Background(), baseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schemaURL := testsupport.WithSearchPath(t, baseURL, schema)

	switch phase {
	case "seed":
		if _, err := admin.Exec(context.Background(), "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
			t.Fatalf("create restart schema: %v", err)
		}
		if err := testsupport.MigrateUp(schemaURL); err != nil {
			t.Fatalf("migrate restart schema: %v", err)
		}
		pool, err := pgxpool.New(context.Background(), schemaURL)
		if err != nil {
			t.Fatal(err)
		}
		service := qualificationService(t, pool)
		snapshot := qualificationSnapshot(t, restartScenario, restartCursor, "2026-08-01T01:00:00Z", "restart")
		response := qualificationRequest(t, service, http.MethodPost, app.RouteSnapshotIngest, restartIdempotencyKey, qualificationSnapshotBody(t, nil, snapshot))
		pool.Close()
		if response.Code != http.StatusCreated {
			t.Fatalf("restart seed status/body = %d %s", response.Code, response.Body.String())
		}
	case "verify":
		pool, err := pgxpool.New(context.Background(), schemaURL)
		if err != nil {
			t.Fatal(err)
		}
		if err := checkDatabaseReady(context.Background(), pool); err != nil {
			pool.Close()
			t.Fatalf("database was not ready after restart: %v", err)
		}
		service := qualificationService(t, pool)
		snapshot := qualificationSnapshot(t, restartScenario, restartCursor, "2026-08-01T01:00:00Z", "restart")
		replay := qualificationRequest(t, service, http.MethodPost, app.RouteSnapshotIngest, restartIdempotencyKey, qualificationSnapshotBody(t, nil, snapshot))
		query := qualificationRequest(t, service, http.MethodPost, app.RouteQuery, "", []byte(`{"scenarioInstanceId":"scenario-gs1c-restart"}`))
		pool.Close()
		if replay.Code != http.StatusOK || !strings.Contains(replay.Body.String(), `"status":"duplicate"`) {
			t.Fatalf("restart replay status/body = %d %s", replay.Code, replay.Body.String())
		}
		if query.Code != http.StatusOK || !strings.Contains(query.Body.String(), `"snapshotCursor":"cursor-restart-001"`) {
			t.Fatalf("restart query status/body = %d %s", query.Code, query.Body.String())
		}
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Fatalf("drop restart schema: %v", err)
		}
	default:
		t.Fatalf("unknown restart qualification phase %q", phase)
	}
}

func TestGS1CLargeGraphQualification(t *testing.T) {
	if os.Getenv("GRAPH_GS1C_LARGE_QUALIFICATION") != "1" {
		t.Skip("set GRAPH_GS1C_LARGE_QUALIFICATION=1 for the single-run large graph gate")
	}
	snapshot := qualificationLargeSnapshot(t)
	pool := testsupport.OpenPostgres(t)
	service := qualificationService(t, pool)
	body := qualificationSnapshotBody(t, nil, snapshot)
	if int64(len(body)) > app.MaxRequestBodyBytes {
		t.Fatalf("exact-bound graph request is unexpectedly too large: %d", len(body))
	}
	response := qualificationRequest(t, service, http.MethodPost, app.RouteSnapshotIngest, "gs1c-large-exact", body)
	if response.Code != http.StatusCreated {
		t.Fatalf("exact-bound graph status/body = %d %s", response.Code, response.Body.String())
	}
	queryBody := []byte(fmt.Sprintf(`{"scenarioInstanceId":"%s","maxNodes":%d,"maxEdges":%d,"maxResponseBytes":%d}`,
		snapshot.ScenarioInstanceID, graph.MaxNodes, graph.MaxEdges, graph.MaxResponseBytes))
	query := qualificationRequest(t, service, http.MethodPost, app.RouteQuery, "", queryBody)
	if query.Code != http.StatusOK || query.Body.Len() > graph.MaxResponseBytes {
		t.Fatalf("bounded query status/bytes = %d/%d", query.Code, query.Body.Len())
	}
	overLimit := qualificationOverLimitSnapshotBody(t, snapshot)
	rejected := qualificationRequest(t, service, http.MethodPost, app.RouteSnapshotIngest, "gs1c-large-over-limit", overLimit)
	if rejected.Code != http.StatusUnprocessableEntity {
		t.Fatalf("over-limit graph status/body = %d %s", rejected.Code, rejected.Body.String())
	}
}

func qualificationLargeSnapshot(t testing.TB) graph.Snapshot {
	t.Helper()
	const scenario = "scenario-gs1c-large"
	const generatedAt = "2026-08-01T02:00:00Z"
	nodes := make([]graph.Node, 0, graph.MaxSnapshotNodes)
	for index := 0; index < graph.MaxSnapshotNodes; index++ {
		authority := graph.AuthorityRef{
			Provider: "openslack", ObjectType: "large-node", ObjectID: fmt.Sprintf("%05d", index),
			Version: "v1", ObservedAt: generatedAt,
		}
		id, err := graph.DeriveNodeID(scenario, "core.work_item", authority)
		if err != nil {
			t.Fatal(err)
		}
		nodes = append(nodes, graph.Node{
			ID: id, Type: "core.work_item", ScenarioDefinitionID: "gs1c-large",
			ScenarioInstanceID: scenario, Title: fmt.Sprintf("Node %05d", index), AuthorityRef: authority,
			Owners: []graph.ActorRef{}, Properties: graph.Object{}, SourceEventIDs: []string{},
			EvidenceRefs: []string{}, ProjectorVersion: "gs1c-projector-v1", ValidFrom: generatedAt,
		})
	}
	edges := make([]graph.Edge, 0, graph.MaxSnapshotEdges)
	for index := 0; index < graph.MaxSnapshotEdges; index++ {
		fromIndex := index % graph.MaxSnapshotNodes
		step := index/graph.MaxSnapshotNodes + 1
		toIndex := (fromIndex + step) % graph.MaxSnapshotNodes
		id, err := graph.DeriveEdgeID(scenario, "core.related", nodes[fromIndex].ID, nodes[toIndex].ID, nil)
		if err != nil {
			t.Fatal(err)
		}
		edges = append(edges, graph.Edge{
			ID: id, Type: "core.related", From: nodes[fromIndex].ID, To: nodes[toIndex].ID,
			ScenarioInstanceID: scenario, SourceEventIDs: []string{}, EvidenceRefs: []string{},
			ProjectorVersion: "gs1c-projector-v1", ValidFrom: generatedAt,
		})
	}
	snapshot, err := graph.SealSnapshot(graph.Snapshot{
		Schema: graph.SnapshotSchema, Cursor: "cursor-large-exact", ScenarioInstanceID: scenario,
		GeneratedAt: generatedAt, ProjectorVersion: "gs1c-projector-v1", Nodes: nodes, Edges: edges,
		Completeness: graph.Completeness{SourcesRequested: []string{"openslack"}, SourcesObserved: []string{"openslack"}, MissingSources: []string{}, Warnings: []string{}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func qualificationOverLimitSnapshotBody(t testing.TB, snapshot graph.Snapshot) []byte {
	t.Helper()
	raw, err := graph.SerializeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	value := qualificationCanonicalValue(t, raw)
	object, ok := value.(graph.Object)
	if !ok {
		t.Fatal("serialized snapshot was not an object")
	}
	nodes, ok := object["nodes"].(graph.Array)
	if !ok || len(nodes) != graph.MaxSnapshotNodes {
		t.Fatal("serialized snapshot nodes drifted")
	}
	object["nodes"] = append(append(graph.Array{}, nodes...), nodes[0])
	body, err := graph.CanonicalJSON(graph.Object{"expectedCursor": nil, "snapshot": object})
	if err != nil {
		t.Fatal(err)
	}
	return body
}
