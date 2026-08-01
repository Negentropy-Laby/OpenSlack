package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/app"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore"
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
	parentNodes := make(map[string]graph.Node, len(parent.Nodes))
	for _, node := range parent.Nodes {
		parentNodes[node.ID] = node
	}
	upsertNodes := make([]graph.Node, 0, len(target.Nodes))
	for _, node := range target.Nodes {
		parentNode, exists := parentNodes[node.ID]
		if !exists || !reflect.DeepEqual(parentNode, node) {
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

func TestQualificationDeltaReconstructsChangedExistingNodes(t *testing.T) {
	parent := qualificationSnapshot(
		t,
		"scenario-gs1c-delta-helper",
		"cursor-001",
		"2026-08-01T00:00:00Z",
		"1",
		"2",
	)
	target := qualificationSnapshot(
		t,
		parent.ScenarioInstanceID,
		"cursor-002",
		"2026-08-01T00:01:00Z",
		"1",
		"2",
		"3",
	)
	delta := qualificationDelta(t, parent, target)

	if len(delta.UpsertNodes) != len(target.Nodes) {
		t.Fatalf("upsert node count = %d, want %d", len(delta.UpsertNodes), len(target.Nodes))
	}
	if err := graphstore.ValidateDeltaTransition(parent, target, delta); err != nil {
		t.Fatalf("qualification delta does not reconstruct target: %v", err)
	}
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

type qualificationQueryEnvelope struct {
	ScenarioInstanceID string            `json:"scenarioInstanceId"`
	SnapshotCursor     string            `json:"snapshotCursor"`
	Nodes              []json.RawMessage `json:"nodes"`
	Edges              []json.RawMessage `json:"edges"`
	NextCursor         *string           `json:"nextCursor"`
	Truncation         struct {
		Truncated bool `json:"truncated"`
		NodeLimit bool `json:"nodeLimit"`
		EdgeLimit bool `json:"edgeLimit"`
		ByteLimit bool `json:"byteLimit"`
		Paginated bool `json:"paginated"`
	} `json:"truncation"`
}

func qualificationQueryResult(t testing.TB, response *httptest.ResponseRecorder) qualificationQueryEnvelope {
	t.Helper()
	var result qualificationQueryEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode bounded query response: %v", err)
	}
	return result
}

func qualificationResultIDs(t testing.TB, values []json.RawMessage) map[string]struct{} {
	t.Helper()
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		var identified struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(value, &identified); err != nil || identified.ID == "" {
			t.Fatalf("decode identified query item: %v", err)
		}
		if _, duplicate := result[identified.ID]; duplicate {
			t.Fatalf("query page contains duplicate id %q", identified.ID)
		}
		result[identified.ID] = struct{}{}
	}
	return result
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
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	request, err := http.NewRequestWithContext(context.Background(), method, server.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("execute qualification HTTP request: %v", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, int64(app.MaxResponseBodyBytes)+1))
	if err != nil {
		t.Fatalf("read qualification HTTP response: %v", err)
	}
	if len(responseBody) > app.MaxResponseBodyBytes {
		t.Fatalf("qualification HTTP response exceeded %d bytes", app.MaxResponseBodyBytes)
	}
	recorder := httptest.NewRecorder()
	recorder.Code = response.StatusCode
	_, _ = recorder.Body.Write(responseBody)
	return recorder
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
		{name: "clean version without service relations", makeTable: true, rows: [][2]any{{int64(2), false}}},
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
	t.Run("altered service column", func(t *testing.T) {
		schemaURL := testsupport.OpenMigrationSchemaURL(t)
		if err := testsupport.MigrateUp(schemaURL); err != nil {
			t.Fatal(err)
		}
		pool, err := pgxpool.New(context.Background(), schemaURL)
		if err != nil {
			t.Fatal(err)
		}
		defer pool.Close()
		if _, err := pool.Exec(context.Background(), `ALTER TABLE graph_heads ALTER COLUMN revision TYPE INTEGER`); err != nil {
			t.Fatal(err)
		}
		if err := checkDatabaseReady(context.Background(), pool); err == nil {
			t.Fatal("altered service column was reported ready")
		}
	})
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
		store := graphpostgres.New(pool)
		beforeReplay, err := store.ReadReceipt(context.Background(), restartScenario, restartIdempotencyKey)
		if err != nil {
			pool.Close()
			t.Fatalf("read durable restart receipt: %v", err)
		}
		head, current, err := store.Current(context.Background(), restartScenario)
		if err != nil {
			pool.Close()
			t.Fatalf("read durable restart head: %v", err)
		}
		if beforeReplay.ReceiptID == "" || beforeReplay.Status != graphstore.ReceiptAccepted ||
			beforeReplay.Cursor != restartCursor || beforeReplay.Revision != 1 ||
			head.Cursor != restartCursor || head.Revision != 1 ||
			current.Snapshot.IntegrityHash != beforeReplay.SnapshotIntegrityHash {
			pool.Close()
			t.Fatalf("durable restart receipt/head drifted: receipt=%+v head=%+v", beforeReplay, head)
		}
		service := qualificationService(t, pool)
		snapshot := qualificationSnapshot(t, restartScenario, restartCursor, "2026-08-01T01:00:00Z", "restart")
		replay := qualificationRequest(t, service, http.MethodPost, app.RouteSnapshotIngest, restartIdempotencyKey, qualificationSnapshotBody(t, nil, snapshot))
		query := qualificationRequest(t, service, http.MethodPost, app.RouteQuery, "", []byte(`{"scenarioInstanceId":"scenario-gs1c-restart"}`))
		afterReplay, err := store.ReadReceipt(context.Background(), restartScenario, restartIdempotencyKey)
		pool.Close()
		if replay.Code != http.StatusOK || !strings.Contains(replay.Body.String(), `"status":"duplicate"`) {
			t.Fatalf("restart replay status/body = %d %s", replay.Code, replay.Body.String())
		}
		if query.Code != http.StatusOK || !strings.Contains(query.Body.String(), `"snapshotCursor":"cursor-restart-001"`) {
			t.Fatalf("restart query status/body = %d %s", query.Code, query.Body.String())
		}
		if err != nil || !reflect.DeepEqual(afterReplay, beforeReplay) {
			t.Fatalf("restart replay changed durable receipt: before=%+v after=%+v err=%v", beforeReplay, afterReplay, err)
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
	head, persisted, err := graphpostgres.New(pool).Current(context.Background(), snapshot.ScenarioInstanceID)
	if err != nil {
		t.Fatalf("read persisted exact-bound graph: %v", err)
	}
	wantCanonicalBytes, err := graph.SerializeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if head.Cursor != snapshot.Cursor || head.Revision != 1 ||
		head.SnapshotIntegrityHash != snapshot.IntegrityHash ||
		persisted.Snapshot.IntegrityHash != snapshot.IntegrityHash ||
		!bytes.Equal(persisted.CanonicalBytes, wantCanonicalBytes) ||
		len(persisted.Snapshot.Nodes) != graph.MaxSnapshotNodes ||
		len(persisted.Snapshot.Edges) != graph.MaxSnapshotEdges {
		t.Fatalf(
			"persisted exact-bound graph drifted: head=%+v nodes=%d edges=%d",
			head,
			len(persisted.Snapshot.Nodes),
			len(persisted.Snapshot.Edges),
		)
	}
	queryBody := []byte(fmt.Sprintf(`{"scenarioInstanceId":"%s","maxNodes":%d,"maxEdges":%d,"maxResponseBytes":%d}`,
		snapshot.ScenarioInstanceID, graph.MaxNodes, graph.MaxEdges, graph.MaxResponseBytes))
	query := qualificationRequest(t, service, http.MethodPost, app.RouteQuery, "", queryBody)
	if query.Code != http.StatusOK || query.Body.Len() > graph.MaxResponseBytes {
		t.Fatalf("bounded query status/bytes = %d/%d", query.Code, query.Body.Len())
	}
	queryResult := qualificationQueryResult(t, query)
	if queryResult.ScenarioInstanceID != snapshot.ScenarioInstanceID ||
		queryResult.SnapshotCursor != snapshot.Cursor ||
		len(queryResult.Nodes) != graph.MaxNodes ||
		len(queryResult.Edges) != 0 ||
		queryResult.NextCursor == nil || *queryResult.NextCursor == "" ||
		!queryResult.Truncation.Truncated || !queryResult.Truncation.NodeLimit ||
		queryResult.Truncation.EdgeLimit || queryResult.Truncation.ByteLimit ||
		queryResult.Truncation.Paginated {
		t.Fatalf("bounded query envelope drifted: %+v", queryResult)
	}
	firstNodeIDs := qualificationResultIDs(t, queryResult.Nodes)
	secondQueryBody, err := json.Marshal(map[string]any{
		"scenarioInstanceId": snapshot.ScenarioInstanceID,
		"maxNodes":           graph.MaxNodes,
		"maxEdges":           graph.MaxEdges,
		"maxResponseBytes":   graph.MaxResponseBytes,
		"cursor":             *queryResult.NextCursor,
	})
	if err != nil {
		t.Fatal(err)
	}
	secondQuery := qualificationRequest(t, service, http.MethodPost, app.RouteQuery, "", secondQueryBody)
	if secondQuery.Code != http.StatusOK || secondQuery.Body.Len() > graph.MaxResponseBytes {
		t.Fatalf("second bounded query status/bytes = %d/%d", secondQuery.Code, secondQuery.Body.Len())
	}
	secondQueryResult := qualificationQueryResult(t, secondQuery)
	if len(secondQueryResult.Nodes) != graph.MaxNodes || len(secondQueryResult.Edges) != 0 ||
		secondQueryResult.NextCursor == nil || !secondQueryResult.Truncation.Truncated ||
		!secondQueryResult.Truncation.NodeLimit || !secondQueryResult.Truncation.Paginated {
		t.Fatalf("second bounded query envelope drifted: %+v", secondQueryResult)
	}
	for id := range qualificationResultIDs(t, secondQueryResult.Nodes) {
		if _, duplicate := firstNodeIDs[id]; duplicate {
			t.Fatalf("bounded query cursor repeated node %q", id)
		}
	}

	edgeQueryBody, err := json.Marshal(map[string]any{
		"scenarioInstanceId": snapshot.ScenarioInstanceID,
		"rootNodeIds":        []string{snapshot.Nodes[0].ID},
		"depth":              1,
		"maxNodes":           graph.MaxNodes,
		"maxEdges":           1,
		"maxResponseBytes":   graph.MaxResponseBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	edgeQuery := qualificationRequest(t, service, http.MethodPost, app.RouteQuery, "", edgeQueryBody)
	if edgeQuery.Code != http.StatusOK {
		t.Fatalf("edge query status/body = %d/%s", edgeQuery.Code, edgeQuery.Body.String())
	}
	edgeQueryResult := qualificationQueryResult(t, edgeQuery)
	if len(edgeQueryResult.Nodes) < 2 || len(edgeQueryResult.Edges) != 1 ||
		edgeQueryResult.NextCursor == nil || !edgeQueryResult.Truncation.Truncated ||
		!edgeQueryResult.Truncation.EdgeLimit || edgeQueryResult.Truncation.Paginated {
		t.Fatalf("edge query envelope drifted: %+v", edgeQueryResult)
	}
	firstEdgeIDs := qualificationResultIDs(t, edgeQueryResult.Edges)
	edgeNextBody, err := json.Marshal(map[string]any{
		"scenarioInstanceId": snapshot.ScenarioInstanceID,
		"rootNodeIds":        []string{snapshot.Nodes[0].ID},
		"depth":              1,
		"maxNodes":           graph.MaxNodes,
		"maxEdges":           1,
		"maxResponseBytes":   graph.MaxResponseBytes,
		"cursor":             *edgeQueryResult.NextCursor,
	})
	if err != nil {
		t.Fatal(err)
	}
	edgeNext := qualificationRequest(t, service, http.MethodPost, app.RouteQuery, "", edgeNextBody)
	if edgeNext.Code != http.StatusOK {
		t.Fatalf("edge query next status/body = %d/%s", edgeNext.Code, edgeNext.Body.String())
	}
	edgeNextResult := qualificationQueryResult(t, edgeNext)
	if len(edgeNextResult.Nodes) != 0 || len(edgeNextResult.Edges) != 1 ||
		!edgeNextResult.Truncation.Paginated {
		t.Fatalf("edge query next envelope drifted: %+v", edgeNextResult)
	}
	for id := range qualificationResultIDs(t, edgeNextResult.Edges) {
		if _, duplicate := firstEdgeIDs[id]; duplicate {
			t.Fatalf("edge query cursor repeated edge %q", id)
		}
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
