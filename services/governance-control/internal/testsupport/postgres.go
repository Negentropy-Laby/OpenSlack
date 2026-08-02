// Package testsupport owns isolated PostgreSQL schemas for GS5 tests.
package testsupport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var schemaPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`)

func Open(t testing.TB) *pgxpool.Pool {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("DATABASE_URL is not configured")
	}
	return OpenSchema(t, randomSchema(t), true)
}

func OpenSchema(t testing.TB, schema string, migrate bool) *pgxpool.Pool {
	return openSchema(t, schema, migrate, migrate)
}

func OpenPersistentSchema(t testing.TB, schema string, migrate bool) *pgxpool.Pool {
	return openSchema(t, schema, migrate, false)
}

func DropSchema(t testing.TB, schema string) {
	t.Helper()
	if !schemaPattern.MatchString(schema) {
		t.Fatalf("unsafe test schema %q", schema)
	}
	admin, err := pgxpool.New(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err := admin.Exec(context.Background(), `DROP SCHEMA `+pgx.Identifier{schema}.Sanitize()+` CASCADE`); err != nil {
		t.Fatal(err)
	}
}

func openSchema(t testing.TB, schema string, migrate bool, cleanup bool) *pgxpool.Pool {
	t.Helper()
	if !schemaPattern.MatchString(schema) {
		t.Fatalf("unsafe test schema %q", schema)
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	if migrate {
		if _, err := admin.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize()); err != nil {
			admin.Close()
			t.Fatal(err)
		}
	}
	config, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	config.AfterConnect = func(ctx context.Context, connection *pgx.Conn) error {
		_, err := connection.Exec(ctx, `SET search_path TO `+pgx.Identifier{schema}.Sanitize())
		return err
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	if migrate {
		_, filename, _, _ := runtime.Caller(0)
		migrationPath := filepath.Join(filepath.Dir(filename), "..", "..", "migrations", "000001_create_governance_shadow.up.sql")
		raw, err := os.ReadFile(migrationPath)
		if err != nil {
			pool.Close()
			admin.Close()
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(raw)); err != nil {
			pool.Close()
			admin.Close()
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Close()
		if cleanup {
			_, _ = admin.Exec(context.Background(), `DROP SCHEMA `+pgx.Identifier{schema}.Sanitize()+` CASCADE`)
		}
		admin.Close()
	})
	return pool
}

func randomSchema(t testing.TB) string {
	t.Helper()
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("governance_shadow_test_%s", hex.EncodeToString(raw))
}
