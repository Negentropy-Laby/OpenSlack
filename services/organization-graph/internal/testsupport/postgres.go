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

func OpenPostgres(t testing.TB) *pgxpool.Pool {
	t.Helper()
	schemaURL := OpenMigrationSchemaURL(t)
	if err := MigrateUp(schemaURL); err != nil {
		t.Fatalf("migrate Organization Graph test schema: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, schemaURL)
	if err != nil {
		t.Fatalf("create Organization Graph test pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping Organization Graph test pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func OpenMigrationSchemaURL(t testing.TB) string {
	t.Helper()
	baseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if baseURL == "" {
		t.Skip("DATABASE_URL not set")
	}
	baseURL = NormalizePoolURL(t, baseURL)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, baseURL)
	if err != nil {
		t.Fatalf("create PostgreSQL admin pool: %v", err)
	}
	schema := fmt.Sprintf(
		"organization_graph_test_%d_%d",
		os.Getpid(),
		schemaSequence.Add(1),
	)
	if _, err := admin.Exec(
		ctx,
		"CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize(),
	); err != nil {
		admin.Close()
		t.Fatalf("create PostgreSQL test schema: %v", err)
	}
	t.Cleanup(func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer dropCancel()
		_, _ = admin.Exec(
			dropCtx,
			"DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE",
		)
		admin.Close()
	})
	return WithSearchPath(t, baseURL, schema)
}

func NormalizePoolURL(t testing.TB, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse PostgreSQL URL: %v", err)
	}
	if parsed.Scheme == "pgx5" {
		parsed.Scheme = "postgres"
	}
	if parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		t.Fatalf("unsupported PostgreSQL URL scheme %q", parsed.Scheme)
	}
	return parsed.String()
}

func WithSearchPath(t testing.TB, raw, schema string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse PostgreSQL URL: %v", err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func MigrationURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "postgres", "postgresql", "pgx5":
		parsed.Scheme = "pgx5"
	default:
		return "", fmt.Errorf("unsupported PostgreSQL URL scheme %q", parsed.Scheme)
	}
	return parsed.String(), nil
}

func MigrationsURL() string {
	_, file, _, _ := runtime.Caller(0)
	return "file://" + filepath.Join(filepath.Dir(file), "..", "..", "migrations")
}

func MigrateUp(databaseURL string) error {
	migrationURL, err := MigrationURL(databaseURL)
	if err != nil {
		return err
	}
	migrator, err := migrate.New(MigrationsURL(), migrationURL)
	if err != nil {
		return err
	}
	defer func() { _, _ = migrator.Close() }()
	if err := migrator.Up(); err != nil && err != migrate.ErrNoChange {
		return err
	}
	return nil
}
