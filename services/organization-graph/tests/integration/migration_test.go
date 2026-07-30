package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/testsupport"
)

func TestMigrationsUpDownAndReapply(t *testing.T) {
	databaseURL := testsupport.OpenMigrationSchemaURL(t)
	migrationURL, err := testsupport.MigrationURL(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	migrator, err := migrate.New(testsupport.MigrationsURL(), migrationURL)
	if err != nil {
		t.Fatalf("create migrator: %v", err)
	}
	defer func() { _, _ = migrator.Close() }()

	if err := migrator.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate up: %v", err)
	}
	version, dirty, err := migrator.Version()
	if err != nil || version != 1 || dirty {
		t.Fatalf("version after up=%d dirty=%v err=%v", version, dirty, err)
	}
	if err := migrator.Steps(-1); err != nil {
		t.Fatalf("step down: %v", err)
	}
	if _, _, err := migrator.Version(); !errors.Is(err, migrate.ErrNilVersion) {
		t.Fatalf("version after down: %v", err)
	}
	if err := migrator.Steps(1); err != nil {
		t.Fatalf("step reapply: %v", err)
	}
	version, dirty, err = migrator.Version()
	if err != nil || version != 1 || dirty {
		t.Fatalf("version after reapply=%d dirty=%v err=%v", version, dirty, err)
	}

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("open migrated database: %v", err)
	}
	defer pool.Close()
	for _, table := range []string{
		"graph_snapshots",
		"graph_deltas",
		"graph_heads",
		"graph_ingest_receipts",
	} {
		var found *string
		if err := pool.QueryRow(
			context.Background(),
			`SELECT to_regclass($1)::text`,
			table,
		).Scan(&found); err != nil {
			t.Fatalf("inspect %s: %v", table, err)
		}
		if found == nil || *found != table {
			t.Fatalf("migration did not create %s: %v", table, found)
		}
	}
}
