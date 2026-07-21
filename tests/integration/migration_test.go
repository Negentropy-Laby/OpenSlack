package integration_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5/pgxpool"
)

// migrationsURL returns a file:// URL pointing to the module's migrations
// directory, regardless of the test package's working directory.
func migrationsURL() string {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..")
	return "file://" + filepath.Join(root, "migrations")
}

// TestMigrationsUpDown exercises golang-migrate against the PostgreSQL service
// configured by DATABASE_URL.  It verifies the B1 base migration can be
// applied, rolled back and re-applied idempotently.
func TestMigrationsUpDown(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping database: %v", err)
	}

	// golang-migrate pgx/v5 driver expects a pgx5:// scheme URL.
	migrateURL := dbURL
	if strings.HasPrefix(migrateURL, "postgres://") {
		migrateURL = "pgx5://" + strings.TrimPrefix(migrateURL, "postgres://")
	}

	m, err := migrate.New(migrationsURL(), migrateURL)
	if err != nil {
		t.Fatalf("migrate new: %v", err)
	}
	defer m.Close()

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up: %v", err)
	}

	version, dirty, err := m.Version()
	if err != nil {
		t.Fatalf("version after up: %v", err)
	}
	if version != 1 {
		t.Fatalf("version after up = %d, want 1", version)
	}
	if dirty {
		t.Fatal("migration marked dirty after up")
	}

	if err := m.Down(); err != nil {
		t.Fatalf("migrate down: %v", err)
	}

	if _, _, err := m.Version(); err != migrate.ErrNilVersion {
		t.Fatalf("expected NilVersion after down, got %v", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate re-up: %v", err)
	}

	version, dirty, err = m.Version()
	if err != nil {
		t.Fatalf("version after re-up: %v", err)
	}
	if version != 1 {
		t.Fatalf("version after re-up = %d, want 1", version)
	}
	if dirty {
		t.Fatal("migration marked dirty after re-up")
	}
}
