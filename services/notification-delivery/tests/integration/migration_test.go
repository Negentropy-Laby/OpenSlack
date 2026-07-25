package integration_test

import (
	"context"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/testsupport"
)

// migrationsURL returns a file:// URL pointing to the module's migrations
// directory, regardless of the test package's working directory.
func migrationsURL() string {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Join(filepath.Dir(file), "..", "..")
	return "file://" + filepath.Join(root, "migrations")
}

func TestMigrationConstraintsRejectContractDrift(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO vendors (vendor_id, owning_scope, lifecycle) VALUES ('vendor-migration', 'team-a', 'active')`); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO endpoint_versions (
		vendor_id, config_version, canonical_url, method, transport_kind, auth_strategy,
		credential_ref_scheme, credential_ref_handle, created_by_actor, hostname, port
	) VALUES ('vendor-migration', 1, 'https://example.com/hook', 'POST', 'https_public', 'hmac', 'env', 'TOKEN', 'operator-1', 'example.com', 443)`)
	if err == nil {
		t.Fatal("database accepted non-bearer endpoint version")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_versions (
		vendor_id, config_version, config_schema_version, canonical_url, method, transport_kind, auth_strategy,
		response_policy, credential_ref_scheme, credential_ref_handle, credential_ref_version,
		created_by_actor, hostname, port
	) VALUES ('vendor-migration', 1, 2, 'https://example.com/hook', 'POST', 'https_public',
		'none', 'http_status_v1', NULL, NULL, NULL, 'operator-1', 'example.com', 443)`); err != nil {
		t.Fatalf("database rejected valid schema v2 none-auth endpoint: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_versions (
		vendor_id, config_version, config_schema_version, canonical_url, method, transport_kind, auth_strategy,
		response_policy, credential_ref_scheme, credential_ref_handle, created_by_actor, hostname, port
	) VALUES ('vendor-migration', 2, 2, 'https://example.com/hook', 'POST', 'https_public',
		'bearer', 'json_ack_v1', 'env', 'TOKEN', 'operator-1', 'example.com', 443)`); err != nil {
		t.Fatalf("database rejected valid schema v2 bearer json-ack endpoint: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_versions (
		vendor_id, config_version, config_schema_version, canonical_url, method, transport_kind, auth_strategy,
		response_policy, credential_ref_scheme, credential_ref_handle, created_by_actor, hostname, port
	) VALUES ('vendor-migration', 3, 1, 'https://example.com/hook', 'POST', 'https_public',
		'bearer', 'json_ack_v1', 'env', 'TOKEN', 'operator-1', 'example.com', 443)`); err == nil {
		t.Fatal("database accepted json_ack_v1 on schema v1")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_versions (
		vendor_id, config_version, config_schema_version, canonical_url, method, transport_kind, auth_strategy,
		response_policy, credential_ref_scheme, credential_ref_handle, created_by_actor, hostname, port
	) VALUES ('vendor-migration', 3, 2, 'https://example.com/hook', 'POST', 'https_public',
		'none', 'http_status_v1', 'env', 'TOKEN', 'operator-1', 'example.com', 443)`); err == nil {
		t.Fatal("database accepted credential columns with auth none")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO endpoint_versions (
		vendor_id, config_version, config_schema_version, canonical_url, method, transport_kind, auth_strategy,
		response_policy, credential_ref_scheme, credential_ref_handle, created_by_actor, hostname, port
	) VALUES ('vendor-migration', 3, 3, 'https://example.com/hook', 'POST', 'https_public',
		'bearer', 'http_status_v1', 'env', 'TOKEN', 'operator-1', 'example.com', 443)`); err == nil {
		t.Fatal("database accepted config schema version outside 1 or 2")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO notifications (
		notification_id, caller_id, vendor_id, idempotency_key, request_fingerprint, payload_bytes,
		state, version, attempt_count, delivery_cycle_started_at, created_at, updated_at
	) VALUES ('n-migration', 'caller-1', 'vendor-migration', 'key-1', decode('00','hex'), decode('7b7d','hex'), 'in_flight', 2, 0, now(), now(), now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delivery_attempts (
		notification_id, attempt_seq, event_kind, result_kind, outcome_class, http_status, reason
	) VALUES ('n-migration', 1, 'outcome', 'http_response', 'permanent_failure', 503, 'deadline_exceeded')`); err != nil {
		t.Fatalf("valid B-01 row rejected: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO delivery_attempts (
		notification_id, attempt_seq, event_kind, result_kind, outcome_class
	) VALUES ('n-migration', 2, 'outcome', 'transport_failure', 'retryable_failure')`); err == nil {
		t.Fatal("database accepted transport failure without error_code")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO admin_audit_events (
		vendor_id, owning_scope, actor_id, authorization_basis, operation, outcome,
		sanitized_request_digest, reject_reason
	) VALUES ('missing-vendor', NULL, 'operator-1', 'vendor_id', 'update_version', 'rejected',
		'0123456789abcdef', 'VENDOR_NOT_FOUND')`); err != nil {
		t.Fatalf("authorized not-found audit rejected: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO admin_audit_events (
		vendor_id, owning_scope, actor_id, authorization_basis, operation, outcome,
		sanitized_request_digest, reject_reason
	) VALUES ('missing-vendor', NULL, 'operator-1', 'vendor_id', 'update_version', 'rejected',
		'0123456789abcdef', 'FORBIDDEN')`); err == nil {
		t.Fatal("database accepted out-of-contract rejected audit reason")
	}
}

// TestMigrationsUpDown exercises clean install, upgrade from 000001, one-step
// rollback/reapply and full down/up against the configured PostgreSQL service.
// It also proves the bearer-only upgrade fails closed instead of silently
// converting an existing non-bearer endpoint.
func TestMigrationsUpDown(t *testing.T) {
	dbURL := testsupport.OpenMigrationSchemaURL(t)

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
	if err := m.Down(); err != nil {
		t.Fatalf("reset schema before migration matrix: %v", err)
	}
	if _, _, err := m.Version(); err != migrate.ErrNilVersion {
		t.Fatalf("expected NilVersion after down, got %v", err)
	}
	if err := m.Steps(1); err != nil {
		t.Fatalf("install migration 000001: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vendors (vendor_id, owning_scope, lifecycle)
		VALUES ('vendor-upgrade', 'team-a', 'draft');
		INSERT INTO endpoint_versions (
			vendor_id, config_version, canonical_url, method, transport_kind,
			auth_strategy, credential_ref_scheme, credential_ref_handle, created_by_actor
		) VALUES (
			'vendor-upgrade', 1, 'https://vendor.example/hook', 'POST', 'https_public',
			'hmac', 'env', 'VENDOR_TOKEN', 'operator-1'
		)`); err != nil {
		t.Fatalf("seed v1 non-bearer row: %v", err)
	}
	if err := m.Up(); err == nil || err == migrate.ErrNoChange {
		t.Fatal("upgrade silently accepted an existing non-bearer endpoint")
	}
	// The expected failure occurs inside migration 000003's explicit
	// transaction. Reopen the migration connection so PostgreSQL can discard
	// the aborted transaction before inspecting or repairing metadata.
	_, _ = m.Close()
	m, err = migrate.New(migrationsURL(), migrateURL)
	if err != nil {
		t.Fatalf("reopen migrate after expected upgrade failure: %v", err)
	}
	defer m.Close()
	version, dirty, err := m.Version()
	if err != nil {
		t.Fatalf("version after rejected upgrade: %v", err)
	}
	if version < 2 || version > 3 {
		t.Fatalf("rejected upgrade version=%d dirty=%v, want version 2 or 3", version, dirty)
	}
	if dirty {
		if err := m.Force(2); err != nil {
			t.Fatalf("restore migration metadata after expected failure: %v", err)
		}
	} else if version != 2 {
		t.Fatalf("expected clean rollback to version 2, got version=%d", version)
	}
	// endpoint_versions is append-only, so an operator must not mutate the bad
	// historical row in place. Reset this disposable test schema, then exercise
	// a valid upgrade from 000001 with a bearer row.
	if err := m.Down(); err != nil {
		t.Fatalf("reset after expected non-bearer upgrade rejection: %v", err)
	}
	if err := m.Steps(1); err != nil {
		t.Fatalf("reinstall migration 000001 for valid upgrade: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vendors (vendor_id, owning_scope, lifecycle)
		VALUES ('vendor-upgrade-valid', 'team-a', 'draft');
		INSERT INTO endpoint_versions (
			vendor_id, config_version, canonical_url, method, transport_kind,
			auth_strategy, credential_ref_scheme, credential_ref_handle, credential_ref_version, created_by_actor
		) VALUES (
			'vendor-upgrade-valid', 1, 'https://vendor.example/hook', 'POST', 'https_public',
			'bearer', 'env', 'VENDOR_TOKEN', 'v1', 'operator-1'
		)`); err != nil {
		t.Fatalf("seed v1 bearer row: %v", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("upgrade from 000001 after repair: %v", err)
	}
	version, dirty, err = m.Version()
	if err != nil {
		t.Fatalf("version after upgrade: %v", err)
	}
	if version != 9 {
		t.Fatalf("version after upgrade = %d, want 9", version)
	}
	if dirty {
		t.Fatal("migration marked dirty after valid upgrade")
	}

	if err := m.Steps(-1); err != nil {
		t.Fatalf("step down 000009: %v", err)
	}
	if version, dirty, err = m.Version(); err != nil || version != 8 || dirty {
		t.Fatalf("version after step down = %d dirty=%v err=%v, want clean 8", version, dirty, err)
	}
	if err := m.Steps(1); err != nil {
		t.Fatalf("step reapply 000009: %v", err)
	}
	if version, dirty, err = m.Version(); err != nil || version != 9 || dirty {
		t.Fatalf("version after step reapply = %d dirty=%v err=%v, want clean 9", version, dirty, err)
	}

	if err := m.Down(); err != nil {
		t.Fatalf("full migrate down: %v", err)
	}
	if _, _, err := m.Version(); err != migrate.ErrNilVersion {
		t.Fatalf("expected NilVersion after full down, got %v", err)
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		t.Fatalf("fresh re-install: %v", err)
	}
	if version, dirty, err = m.Version(); err != nil || version != 9 || dirty {
		t.Fatalf("version after fresh re-install = %d dirty=%v err=%v, want clean 9", version, dirty, err)
	}
}

func TestMigration000009AttemptConfigVersionAndDownGuard(t *testing.T) {
	dbURL := testsupport.OpenMigrationSchemaURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	migrateURL := strings.Replace(dbURL, "postgres://", "pgx5://", 1)
	m, err := migrate.New(migrationsURL(), migrateURL)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if err := m.Steps(9); err != nil {
		t.Fatalf("install through 000009: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vendors (vendor_id, owning_scope, lifecycle)
		VALUES ('vendor-000009', 'team-a', 'active');
		INSERT INTO notifications (
			notification_id, caller_id, vendor_id, idempotency_key, request_fingerprint,
			payload_bytes, state, version, attempt_count, delivery_cycle_started_at, created_at, updated_at
		) VALUES (
			'n-000009', 'caller-1', 'vendor-000009', 'key-000009', decode('00','hex'),
			decode('7b7d','hex'), 'delivered', 2, 1, now(), now(), now()
		);
		INSERT INTO delivery_attempts (
			notification_id, attempt_seq, event_kind, result_kind, outcome_class,
			http_status, config_version
		) VALUES (
			'n-000009', 1, 'outcome', 'http_response', 'success', 204, 1
		)`); err != nil {
		t.Fatalf("seed config-version evidence: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO delivery_attempts (
			notification_id, attempt_seq, event_kind, result_kind, outcome_class,
			http_status, config_version
		) VALUES (
			'n-000009', 2, 'outcome', 'http_response', 'success', 204, 0
		)`); err == nil {
		t.Fatal("000009 accepted non-positive config version")
	}
	if err := m.Steps(-1); err == nil {
		t.Fatal("000009 down accepted persisted config-version evidence")
	}
}

func TestMigration000007StorageContractAndDownGuard(t *testing.T) {
	dbURL := testsupport.OpenMigrationSchemaURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	defer pool.Close()
	migrateURL := dbURL
	if strings.HasPrefix(migrateURL, "postgres://") {
		migrateURL = "pgx5://" + strings.TrimPrefix(migrateURL, "postgres://")
	}
	m, err := migrate.New(migrationsURL(), migrateURL)
	if err != nil {
		t.Fatalf("migrate new: %v", err)
	}
	defer m.Close()
	if err := m.Steps(6); err != nil {
		t.Fatalf("install through 000006: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vendors (vendor_id, owning_scope, lifecycle)
		VALUES ('vendor-schema-v1', 'team-a', 'draft');
		INSERT INTO endpoint_versions (
			vendor_id, config_version, config_schema_version, canonical_url, method, hostname, port,
			transport_kind, auth_strategy, credential_ref_scheme, credential_ref_handle, credential_ref_version, created_by_actor
		) VALUES (
			'vendor-schema-v1', 1, 1, 'https://vendor.example/hook', 'POST', 'vendor.example', 443,
			'https_public', 'bearer', 'env', 'VENDOR_TOKEN', NULL, 'operator-1'
		)`); err != nil {
		t.Fatalf("seed schema v1: %v", err)
	}
	if err := m.Steps(1); err != nil {
		t.Fatalf("upgrade 6 to 7: %v", err)
	}
	var responsePolicy string
	if err := pool.QueryRow(ctx, `SELECT response_policy FROM endpoint_versions WHERE vendor_id='vendor-schema-v1'`).Scan(&responsePolicy); err != nil {
		t.Fatalf("read upgraded v1 row: %v", err)
	}
	if responsePolicy != "http_status_v1" {
		t.Fatalf("upgraded v1 response policy=%q", responsePolicy)
	}
	if err := m.Steps(-1); err != nil {
		t.Fatalf("v1-only 7 to 6 rollback: %v", err)
	}
	if err := m.Steps(1); err != nil {
		t.Fatalf("reapply 6 to 7: %v", err)
	}

	if _, err := pool.Exec(ctx, `
		INSERT INTO vendors (vendor_id, owning_scope, lifecycle)
		VALUES ('vendor-schema-v2', 'team-a', 'draft');
		INSERT INTO endpoint_versions (
			vendor_id, config_version, config_schema_version, canonical_url, method, hostname, port,
			transport_kind, auth_strategy, response_policy, credential_ref_scheme, credential_ref_handle,
			credential_ref_version, created_by_actor
		) VALUES (
			'vendor-schema-v2', 1, 2, 'https://vendor.example/hook', 'POST', 'vendor.example', 443,
			'https_public', 'none', 'http_status_v1', NULL, NULL, NULL, 'operator-1'
		)`); err != nil {
		t.Fatalf("seed valid schema v2 none-auth row: %v", err)
	}
	if err := m.Steps(-1); err == nil {
		t.Fatal("000007 down accepted v2-only endpoint data")
	}
}

func TestMigration000008ClosedCodesAndGuards(t *testing.T) {
	t.Run("historical anomaly blocks upgrade", func(t *testing.T) {
		dbURL := testsupport.OpenMigrationSchemaURL(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		pool, err := pgxpool.New(ctx, dbURL)
		if err != nil {
			t.Fatal(err)
		}
		defer pool.Close()
		migrateURL := strings.Replace(dbURL, "postgres://", "pgx5://", 1)
		m, err := migrate.New(migrationsURL(), migrateURL)
		if err != nil {
			t.Fatal(err)
		}
		defer m.Close()
		if err := m.Steps(7); err != nil {
			t.Fatalf("install through 000007: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO vendors (vendor_id, owning_scope, lifecycle)
			VALUES ('vendor-000008-bad', 'team-a', 'active');
			INSERT INTO notifications (
				notification_id, caller_id, vendor_id, idempotency_key, request_fingerprint,
				payload_bytes, state, version, attempt_count, delivery_cycle_started_at, created_at, updated_at
			) VALUES (
				'n-000008-bad', 'caller-1', 'vendor-000008-bad', 'key-000008-bad', decode('00','hex'),
				decode('7b7d','hex'), 'pending', 2, 1, now(), now(), now()
			);
			INSERT INTO delivery_attempts (
				notification_id, attempt_seq, event_kind, result_kind, outcome_class, http_status, error_code
			) VALUES (
				'n-000008-bad', 1, 'outcome', 'http_response', 'retryable_failure', 200, 'raw-vendor-secret'
			)`); err != nil {
			t.Fatalf("seed anomaly accepted by old broad contract: %v", err)
		}
		if err := m.Steps(1); err == nil {
			t.Fatal("000008 accepted incompatible historical error code")
		}
	})

	t.Run("closed constraint and down guard", func(t *testing.T) {
		dbURL := testsupport.OpenMigrationSchemaURL(t)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		pool, err := pgxpool.New(ctx, dbURL)
		if err != nil {
			t.Fatal(err)
		}
		defer pool.Close()
		migrateURL := strings.Replace(dbURL, "postgres://", "pgx5://", 1)
		m, err := migrate.New(migrationsURL(), migrateURL)
		if err != nil {
			t.Fatal(err)
		}
		defer m.Close()
		if err := m.Steps(8); err != nil {
			t.Fatalf("install through 000008: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO vendors (vendor_id, owning_scope, lifecycle)
			VALUES ('vendor-000008-good', 'team-a', 'active');
			INSERT INTO notifications (
				notification_id, caller_id, vendor_id, idempotency_key, request_fingerprint,
				payload_bytes, state, version, attempt_count, delivery_cycle_started_at, created_at, updated_at
			) VALUES (
				'n-000008-good', 'caller-1', 'vendor-000008-good', 'key-000008-good', decode('00','hex'),
				decode('7b7d','hex'), 'dead', 2, 1, now(), now(), now()
			);
			INSERT INTO delivery_attempts (
				notification_id, attempt_seq, event_kind, result_kind, outcome_class, http_status, reason
			) VALUES (
				'n-000008-good', 1, 'outcome', 'http_response', 'permanent_failure', 200, 'vendor_protocol_error'
			)`); err != nil {
			t.Fatalf("new sanitized terminal reason rejected: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO delivery_attempts (
				notification_id, attempt_seq, event_kind, result_kind, outcome_class, http_status, error_code
			) VALUES (
				'n-000008-good', 2, 'outcome', 'http_response', 'retryable_failure', 200, 'raw-vendor-secret'
			)`); err == nil {
			t.Fatal("closed constraint accepted unknown vendor error")
		}
		if err := m.Steps(-1); err == nil {
			t.Fatal("000008 down accepted v2 acknowledgement history")
		}
	})
}
