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
	WorkspaceID                       = "workspace-test"
	RunID                             = "run-test"
	persistentSchemaReadinessTimeout  = 30 * time.Second
	persistentSchemaReadinessInterval = 100 * time.Millisecond
	persistentSchemaPingTimeout       = 3 * time.Second
)

var schemaPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

// OpenPostgres creates an isolated schema, applies the complete migration
// chain, and
// returns a pool whose search path is pinned to that schema. Tests that need a
// live database skip explicitly when DATABASE_URL is absent.
func OpenPostgres(t testing.TB) *pgxpool.Pool {
	return OpenPostgresWithTracer(t, nil)
}

// OpenPostgresWithTracer is the query-observable variant used by bounded-I/O
// qualification tests. The tracer observes only the isolated test pool; the
// administrative connection remains outside the measurement.
func OpenPostgresWithTracer(t testing.TB, tracer pgx.QueryTracer) *pgxpool.Pool {
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
	config.ConnConfig.Tracer = tracer
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

	for _, migrationPath := range migrationPaths(t) {
		migration, err := os.ReadFile(migrationPath)
		if err != nil {
			t.Fatalf("read migration %s: %v", filepath.Base(migrationPath), err)
		}
		if _, err := pool.Exec(ctx, string(migration)); err != nil {
			t.Fatalf("apply migration %s: %v", filepath.Base(migrationPath), err)
		}
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
		// Persistent schemas intentionally survive a successful seed process, but
		// a failed seed must not leak them into the shared qualification database.
		// Register this immediately after CREATE so every later fatal path is
		// covered; the ordinary pool cleanup runs first because cleanups are LIFO.
		t.Cleanup(func() {
			if t.Failed() {
				DropSchema(t, schema)
			}
		})
	}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool := openReadyPersistentPool(t, config, "persistent PostgreSQL schema")
	if migrate {
		for _, migrationPath := range migrationPaths(t) {
			migration, err := os.ReadFile(migrationPath)
			if err != nil {
				pool.Close()
				admin.Close()
				t.Fatalf("read persistent migration %s: %v", filepath.Base(migrationPath), err)
			}
			if _, err := pool.Exec(ctx, string(migration)); err != nil {
				pool.Close()
				admin.Close()
				t.Fatalf("apply persistent migration %s: %v", filepath.Base(migrationPath), err)
			}
		}
	}
	t.Cleanup(func() {
		pool.Close()
		admin.Close()
	})
	return pool
}

func openReadyPersistentPool(t testing.TB, config *pgxpool.Config, label string) *pgxpool.Pool {
	t.Helper()
	deadline := time.Now().Add(persistentSchemaReadinessTimeout)
	var lastErr error
	for attempt := 1; ; attempt++ {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("%s was not ready within %s after %d attempts: %v", label, persistentSchemaReadinessTimeout, attempt-1, lastErr)
		}
		pingTimeout := persistentSchemaPingTimeout
		if pingTimeout > remaining {
			pingTimeout = remaining
		}
		pingCtx, cancel := context.WithTimeout(context.Background(), pingTimeout)
		pool, err := pgxpool.NewWithConfig(pingCtx, config.Copy())
		if err == nil {
			err = pool.Ping(pingCtx)
		}
		cancel()
		if err == nil {
			return pool
		}
		lastErr = err
		if pool != nil {
			pool.Close()
		}
		remaining = time.Until(deadline)
		if remaining <= 0 {
			t.Fatalf("%s was not ready within %s after %d attempts: %v", label, persistentSchemaReadinessTimeout, attempt, lastErr)
		}
		delay := persistentSchemaReadinessInterval
		if delay > remaining {
			delay = remaining
		}
		timer := time.NewTimer(delay)
		<-timer.C
	}
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

func migrationPaths(t testing.TB) []string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test support source path")
	}
	migrationRoot := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "migrations"))
	return []string{
		filepath.Join(migrationRoot, "000001_create_workflow_control_shadow.up.sql"),
		filepath.Join(migrationRoot, "000002_create_workflow_runner_runtime.up.sql"),
		filepath.Join(migrationRoot, "000003_create_workflow_control_authority.up.sql"),
		filepath.Join(migrationRoot, "000004_create_workflow_control_checkpoint_shadow.up.sql"),
		filepath.Join(migrationRoot, "000005_create_workflow_control_effect_shadow.up.sql"),
		filepath.Join(migrationRoot, "000006_create_workflow_control_budget_authority.up.sql"),
		filepath.Join(migrationRoot, "000007_integrate_workflow_runner_v2.up.sql"),
		filepath.Join(migrationRoot, "000008_deliver_workflow_runner_authority_bindings.up.sql"),
	}
}

func randomSchema(t testing.TB) string {
	t.Helper()
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		t.Fatalf("generate isolated PostgreSQL schema: %v", err)
	}
	return "workflow_control_shadow_test_" + hex.EncodeToString(raw)
}
