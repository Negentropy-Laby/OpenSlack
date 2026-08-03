package testsupport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore"
)

const (
	WorkspaceID = "workspace-test"
	RunID       = "run-test"
)

var schemaPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

// OpenPostgres creates an isolated schema, applies the GS7-B migration, and
// returns a pool whose search path is pinned to that schema. Tests that need a
// live database skip explicitly when DATABASE_URL is absent.
func OpenPostgres(t testing.TB) *pgxpool.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}

	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL admin pool: %v", err)
	}
	schema := randomSchema(t)
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatalf("create isolated PostgreSQL schema: %v", err)
	}

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		_, _ = admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		admin.Close()
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		_, _ = admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		admin.Close()
		t.Fatalf("open isolated PostgreSQL pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		admin.Close()
	})

	migration, err := os.ReadFile(migrationPath(t))
	if err != nil {
		t.Fatalf("read GS7-B migration: %v", err)
	}
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("apply GS7-B migration: %v", err)
	}
	return pool
}

// OpenPersistentSchema creates or reopens a schema that survives between
// separate seed and verification test processes. The caller must drop it.
func OpenPersistentSchema(t testing.TB, schema string, migrate bool) *pgxpool.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	if !schemaPattern.MatchString(schema) {
		t.Fatalf("unsafe persistent PostgreSQL schema %q", schema)
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL admin pool: %v", err)
	}
	if migrate {
		if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
			admin.Close()
			t.Fatalf("create persistent PostgreSQL schema: %v", err)
		}
	}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	if migrate {
		migration, err := os.ReadFile(migrationPath(t))
		if err != nil {
			pool.Close()
			admin.Close()
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(migration)); err != nil {
			pool.Close()
			admin.Close()
			t.Fatalf("apply persistent GS7-B migration: %v", err)
		}
	}
	t.Cleanup(func() {
		pool.Close()
		admin.Close()
	})
	return pool
}

func DropSchema(t testing.TB, schema string) {
	t.Helper()
	if !schemaPattern.MatchString(schema) {
		t.Fatalf("unsafe persistent PostgreSQL schema %q", schema)
	}
	admin, err := pgxpool.New(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
		t.Fatal(err)
	}
}

func Envelope(t testing.TB, sequence int64, status workflowcontrol.RunState) workflowcontrol.ShadowEnvelope {
	t.Helper()
	started := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	observation := workflowcontrol.Observation{
		Schema:       workflowcontrol.ObservationSchema,
		Authority:    workflowcontrol.Authority,
		RunID:        RunID,
		WorkflowName: "tests/workflow.yaml",
		Mode:         workflowcontrol.ModeExecute,
		Status:       status,
		StartedAt:    started.Format("2006-01-02T15:04:05.000Z"),
		UpdatedAt:    started.Add(time.Duration(sequence-1) * time.Second).Format("2006-01-02T15:04:05.000Z"),
		ManifestHash: strings.Repeat("a", 64),
		Phases:       []workflowcontrol.PhaseObservation{},
		Approvals: workflowcontrol.ApprovalObservation{
			LegacyRunGate: workflowcontrol.LegacyRunGateApproval{
				Plane: "legacy-run-gate", Semantics: "run-gate-only",
			},
			EffectV2: workflowcontrol.EffectApprovalSummary{
				Plane: "workflow-effect-v2", Semantics: "effect-decision-only", Schema: workflowcontrol.EffectSchema,
			},
		},
		Budget: workflowcontrol.BudgetObservation{Warnings: []workflowcontrol.BudgetWarning{}},
	}
	projection, err := workflowcontrol.ProjectReadModel(observation)
	if err != nil {
		t.Fatalf("project test observation: %v", err)
	}
	return workflowcontrol.ShadowEnvelope{
		Schema: workflowcontrol.ShadowObservationSchema, Authority: workflowcontrol.Authority,
		Source:      workflowcontrol.ShadowSource{WorkspaceID: WorkspaceID, RunID: RunID, SourceSequence: sequence},
		Observation: observation, Projection: projection,
	}
}

func ObserveInput(t testing.TB, envelope workflowcontrol.ShadowEnvelope) shadowstore.ObserveInput {
	t.Helper()
	body, err := workflowcontrol.CanonicalShadowEnvelopeBytes(envelope)
	if err != nil {
		t.Fatalf("canonicalize test shadow envelope: %v", err)
	}
	prepared, err := shadowstore.PrepareObservation(body)
	if err != nil {
		t.Fatalf("prepare test shadow observation: %v", err)
	}
	return shadowstore.ObserveInput{
		IdempotencyKey:     shadowstore.ExpectedIdempotencyKey(prepared),
		RequestFingerprint: shadowstore.RequestFingerprint(prepared),
		ExactBody:          body,
	}
}

func migrationPath(t testing.TB) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test support source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "migrations", "000001_create_workflow_control_shadow.up.sql"))
}

func randomSchema(t testing.TB) string {
	t.Helper()
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		t.Fatalf("generate isolated PostgreSQL schema: %v", err)
	}
	return "workflow_control_shadow_test_" + hex.EncodeToString(raw)
}
