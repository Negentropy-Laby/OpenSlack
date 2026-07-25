// Package testsupport owns infrastructure helpers shared by database tests.
package testsupport

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var schemaSequence atomic.Uint64

// OpenPostgres creates and migrates an isolated schema for one test. It avoids
// cross-package TRUNCATE/deadlock hazards and makes repeated test runs independent.
func OpenPostgres(t testing.TB) *pgxpool.Pool {
	t.Helper()
	baseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if baseURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	admin, err := pgxpool.New(ctx, baseURL)
	if err != nil {
		t.Fatalf("create admin pool: %v", err)
	}
	schema := fmt.Sprintf("rcwsman_test_%d_%d", os.Getpid(), schemaSequence.Add(1))
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatalf("create test schema: %v", err)
	}

	isolatedURL := withSearchPath(t, baseURL, schema)
	if err := migrateUp(isolatedURL); err != nil {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		admin.Close()
		t.Fatalf("migrate test schema: %v", err)
	}
	pool, err := pgxpool.New(ctx, isolatedURL)
	if err != nil {
		t.Fatalf("create isolated pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping isolated pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer dropCancel()
		_, _ = admin.Exec(dropCtx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		admin.Close()
	})
	return pool
}

// OpenMigrationSchemaURL creates an empty, disposable PostgreSQL schema and
// returns a connection URL whose search_path is confined to that schema. It is
// intentionally not migrated so migration matrix tests can exercise full
// down/up cycles without touching the base database's public schema.
func OpenMigrationSchemaURL(t testing.TB) string {
	t.Helper()
	baseURL := strings.TrimSpace(os.Getenv("MIGRATION_DATABASE_URL"))
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if baseURL == "" {
		t.Skip("MIGRATION_DATABASE_URL or DATABASE_URL not set")
	}
	baseURL = normalizePGXPoolURL(t, baseURL)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, baseURL)
	if err != nil {
		t.Fatalf("create migration admin pool: %v", err)
	}
	schema := fmt.Sprintf("rcwsman_migration_%d_%d", os.Getpid(), schemaSequence.Add(1))
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatalf("create migration schema: %v", err)
	}
	t.Cleanup(func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer dropCancel()
		_, _ = admin.Exec(dropCtx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		admin.Close()
	})
	return withSearchPath(t, baseURL, schema)
}

// normalizePGXPoolURL converts golang-migrate's pgx5 alias to a scheme pgxpool
// understands. CI intentionally exports MIGRATION_DATABASE_URL with pgx5 so
// migration commands select the correct driver, while the administrative pool
// still needs a regular PostgreSQL connection URL.
func normalizePGXPoolURL(t testing.TB, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse PostgreSQL URL: %v", err)
	}
	if u.Scheme == "pgx5" {
		u.Scheme = "postgres"
	}
	if u.Scheme != "postgres" && u.Scheme != "postgresql" {
		t.Fatalf("unsupported PostgreSQL URL scheme %q", u.Scheme)
	}
	return u.String()
}

func withSearchPath(t testing.TB, raw, schema string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	return u.String()
}

func migrateUp(databaseURL string) error {
	u, err := url.Parse(databaseURL)
	if err != nil {
		return err
	}
	u.Scheme = "pgx5"
	_, file, _, _ := runtime.Caller(0)
	source := "file://" + filepath.Join(filepath.Dir(file), "..", "..", "migrations")
	m, err := migrate.New(source, u.String())
	if err != nil {
		return err
	}
	defer func() { _, _ = m.Close() }()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return err
	}
	return nil
}
