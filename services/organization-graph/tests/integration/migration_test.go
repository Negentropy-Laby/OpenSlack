package integration_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/golang-migrate/migrate/v4"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/testsupport"
)

const migrationExactGeneratedAt = "2026-07-30T10:00:00.123456789Z"

func TestMigrationsUpgradeVersionOneDownAndReapply(t *testing.T) {
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

	if err := migrator.Steps(1); err != nil {
		t.Fatalf("apply version 1: %v", err)
	}
	assertMigrationVersion(t, migrator, 1)

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("open migrated database: %v", err)
	}
	defer pool.Close()
	insertVersionOneQualificationRows(t, pool)

	if err := migrator.Steps(1); err != nil {
		t.Fatalf("upgrade version 1 to version 2: %v", err)
	}
	assertMigrationVersion(t, migrator, 2)
	assertVersionTwoStorageContract(t, pool)

	if err := migrator.Steps(-1); err != nil {
		t.Fatalf("downgrade version 2 to version 1: %v", err)
	}
	assertMigrationVersion(t, migrator, 1)
	assertGeneratedAtType(t, pool, "graph_snapshots", "timestamp with time zone")

	if err := migrator.Steps(1); err != nil {
		t.Fatalf("reapply version 2: %v", err)
	}
	assertMigrationVersion(t, migrator, 2)
	assertVersionTwoStorageContract(t, pool)

	if err := migrator.Down(); err != nil {
		t.Fatalf("migrate all versions down: %v", err)
	}
	if _, _, err := migrator.Version(); !errors.Is(err, migrate.ErrNilVersion) {
		t.Fatalf("version after full down: %v", err)
	}
	if err := migrator.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("migrate all versions up: %v", err)
	}
	assertMigrationVersion(t, migrator, 2)

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
	for _, table := range []string{"graph_snapshots", "graph_deltas"} {
		assertGeneratedAtType(t, pool, table, "text")
	}
}

func insertVersionOneQualificationRows(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	canonical := []byte(`{"generatedAt":"` + migrationExactGeneratedAt + `"}`)
	if _, err := pool.Exec(
		context.Background(),
		`INSERT INTO graph_snapshots (
		    scenario_instance_id, cursor, revision, canonical_bytes,
		    integrity_hash, projector_version, generated_at
		 ) VALUES ($1, $2, 1, $3, $4, $5, $6::timestamptz)`,
		"migration-scenario",
		"migration-cursor",
		canonical,
		"sha256:"+strings.Repeat("1", 64),
		"migration-projector",
		migrationExactGeneratedAt,
	); err != nil {
		t.Fatalf("insert version 1 snapshot: %v", err)
	}
	if _, err := pool.Exec(
		context.Background(),
		`INSERT INTO graph_snapshots (
		    scenario_instance_id, cursor, revision, canonical_bytes,
		    integrity_hash, projector_version, generated_at
		 ) VALUES ($1, $2, 2, $3, $4, $5, $6::timestamptz)`,
		"migration-scenario",
		"migration-target",
		canonical,
		"sha256:"+strings.Repeat("2", 64),
		"migration-projector",
		migrationExactGeneratedAt,
	); err != nil {
		t.Fatalf("insert version 1 target snapshot: %v", err)
	}
	if _, err := pool.Exec(
		context.Background(),
		`INSERT INTO graph_deltas (
		    scenario_instance_id, from_cursor, to_cursor, revision,
		    canonical_bytes, integrity_hash, generated_at
		 ) VALUES ($1, $2, $3, 2, $4, $5, $6::timestamptz)`,
		"migration-scenario",
		"migration-cursor",
		"migration-target",
		canonical,
		"sha256:"+strings.Repeat("3", 64),
		migrationExactGeneratedAt,
	); err != nil {
		t.Fatalf("insert version 1 delta: %v", err)
	}
	if _, err := pool.Exec(
		context.Background(),
		`INSERT INTO graph_ingest_receipts (
		    receipt_id, operation, status, scenario_instance_id,
		    idempotency_key, request_fingerprint, previous_cursor,
		    cursor, revision, snapshot_integrity_hash,
		    reconciliation_token
		 ) VALUES (
		    'migration-receipt-a', 'snapshot_ingest',
		    'reconciliation_required', 'migration-scenario-a',
		    'migration-global-key', decode(repeat('00', 32), 'hex'), NULL,
		    'migration-cursor-a', 1, $1, 'migration-token-a'
		 )`,
		"sha256:"+strings.Repeat("4", 64),
	); err != nil {
		t.Fatalf("insert version 1 receipt: %v", err)
	}
}

func assertVersionTwoStorageContract(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	for _, table := range []string{"graph_snapshots", "graph_deltas"} {
		assertGeneratedAtType(t, pool, table, "text")
	}
	for _, query := range []string{
		`SELECT generated_at
		 FROM graph_snapshots
		 WHERE scenario_instance_id = 'migration-scenario'
		   AND cursor = 'migration-cursor'`,
		`SELECT generated_at
		 FROM graph_deltas
		 WHERE scenario_instance_id = 'migration-scenario'
		   AND from_cursor = 'migration-cursor'
		   AND to_cursor = 'migration-target'`,
	} {
		var generatedAt string
		if err := pool.QueryRow(context.Background(), query).Scan(&generatedAt); err != nil {
			t.Fatalf("read upgraded generated_at: %v", err)
		}
		if generatedAt != migrationExactGeneratedAt {
			t.Fatalf("upgraded generated_at = %q, want %q", generatedAt, migrationExactGeneratedAt)
		}
	}
	if _, err := pool.Exec(
		context.Background(),
		`INSERT INTO graph_ingest_receipts (
		    receipt_id, operation, status, scenario_instance_id,
		    idempotency_key, request_fingerprint, previous_cursor,
		    cursor, revision, snapshot_integrity_hash,
		    reconciliation_token
		 ) VALUES (
		    'migration-receipt-b', 'snapshot_ingest',
		    'reconciliation_required', 'migration-scenario-b',
		    'migration-global-key', decode(repeat('11', 32), 'hex'), NULL,
		    'migration-cursor-b', 1, $1, 'migration-token-b'
		 )`,
		"sha256:"+strings.Repeat("5", 64),
	); err == nil {
		t.Fatal("version 2 accepted a globally duplicate idempotency key")
	}
}

func assertGeneratedAtType(
	t *testing.T,
	pool *pgxpool.Pool,
	table string,
	want string,
) {
	t.Helper()
	var dataType string
	if err := pool.QueryRow(
		context.Background(),
		`SELECT data_type
		 FROM information_schema.columns
		 WHERE table_schema = current_schema()
		   AND table_name = $1
		   AND column_name = 'generated_at'`,
		table,
	).Scan(&dataType); err != nil {
		t.Fatalf("inspect %s.generated_at: %v", table, err)
	}
	if dataType != want {
		t.Fatalf("%s.generated_at type = %q, want %q", table, dataType, want)
	}
}

func assertMigrationVersion(t *testing.T, migrator *migrate.Migrate, want uint) {
	t.Helper()
	version, dirty, err := migrator.Version()
	if err != nil || version != want || dirty {
		t.Fatalf("migration version=%d dirty=%v err=%v, want %d/false", version, dirty, err, want)
	}
}
