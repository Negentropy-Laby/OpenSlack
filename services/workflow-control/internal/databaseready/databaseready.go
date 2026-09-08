// Package databaseready validates the single clean migration head required by
// Workflow Control service profiles.
package databaseready

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Range is the inclusive schema range supported by one service profile.
type Range struct {
	Minimum int64
	Maximum int64
}

const CurrentSchemaVersion int64 = 11

var (
	ShadowProfile                  = Range{Minimum: 1, Maximum: CurrentSchemaVersion}
	RunnerProfile                  = Range{Minimum: 2, Maximum: CurrentSchemaVersion}
	AuthorityProfile               = Range{Minimum: 3, Maximum: CurrentSchemaVersion}
	CheckpointProfile              = Range{Minimum: 4, Maximum: CurrentSchemaVersion}
	EffectProfile                  = Range{Minimum: 5, Maximum: CurrentSchemaVersion}
	BudgetProfile                  = Range{Minimum: 6, Maximum: CurrentSchemaVersion}
	RunnerV2FoundationProfile      = Range{Minimum: 7, Maximum: CurrentSchemaVersion}
	RunnerV2RuntimeDeliveryProfile = Range{Minimum: 10, Maximum: CurrentSchemaVersion}
)

func RunnerRange(checkpointShadow, effectShadow bool) Range {
	if effectShadow {
		return EffectProfile
	}
	if checkpointShadow {
		return CheckpointProfile
	}
	return RunnerProfile
}

// Database is the narrow pgxpool surface needed for startup validation.
type Database interface {
	Ping(context.Context) error
	QueryRow(context.Context, string, ...any) pgx.Row
}

// RequireCleanSchema requires exactly one non-dirty migration row in range.
func RequireCleanSchema(ctx context.Context, database Database, supported Range) error {
	_, err := RequireCleanSchemaVersion(ctx, database, supported)
	return err
}

// RequireCleanSchemaVersion returns the exact schema version after proving the
// database has one clean migration head in the supported range. Composition
// roots can pass this trusted startup fact to schema-aware repositories instead
// of probing catalog state on every mutation.
func RequireCleanSchemaVersion(ctx context.Context, database Database, supported Range) (int64, error) {
	if database == nil || supported.Minimum < 1 || supported.Maximum < supported.Minimum {
		return 0, fmt.Errorf("database schema range is invalid")
	}
	if err := database.Ping(ctx); err != nil {
		return 0, fmt.Errorf("database ping: %w", err)
	}
	var count, version int64
	var dirty bool
	if err := database.QueryRow(ctx, `SELECT count(*), COALESCE(max(version), 0), COALESCE(bool_or(dirty), false) FROM schema_migrations`).Scan(&count, &version, &dirty); err != nil {
		return 0, fmt.Errorf("read schema_migrations: %w", err)
	}
	if count != 1 || dirty || version < supported.Minimum || version > supported.Maximum {
		return 0, fmt.Errorf("database schema version must be one clean row between %d and %d", supported.Minimum, supported.Maximum)
	}
	return version, nil
}

// RequireRecoveryV3 proves the derived index is maintained by the installed
// source triggers. Only opt-in schema-11 reads depend on this capability.
func RequireRecoveryV3(ctx context.Context, database Database) error {
	var ready bool
	err := database.QueryRow(ctx, `WITH owner AS (
 SELECT relnamespace AS oid FROM pg_class WHERE oid=to_regclass('workflow_runner_jobs')),
 expected(table_name,trigger_name,function_name) AS (VALUES
 ('workflow_runner_jobs','workflow_runner_recovery_jobs','workflow_runner_refresh_recovery_version'),
 ('workflow_runner_leases','workflow_runner_recovery_leases','workflow_runner_refresh_recovery_version'),
 ('workflow_runner_authority_bindings','workflow_runner_recovery_bindings','workflow_runner_refresh_recovery_version'),
 ('workflow_runner_binding_settlements','workflow_runner_recovery_settlements','workflow_runner_refresh_recovery_version'),
 ('workflow_runner_recovery_pending','workflow_runner_recovery_flush','workflow_runner_flush_recovery_versions'))
 SELECT (SELECT count(*)=5 FROM expected e JOIN pg_class c ON c.relname=e.table_name AND c.relnamespace=(SELECT oid FROM owner)
 JOIN pg_trigger t ON t.tgrelid=c.oid AND t.tgname=e.trigger_name AND t.tgenabled='A'
 JOIN pg_proc p ON p.oid=t.tgfoid AND p.proname=e.function_name AND p.pronamespace=c.relnamespace
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE ('search_path=pg_catalog, '||quote_ident(n.nspname)||', pg_temp')=ANY(p.proconfig)
 AND (e.table_name<>'workflow_runner_recovery_pending' OR (t.tgdeferrable AND t.tginitdeferred)))
 AND (SELECT count(*)=4 FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
 WHERE c.relnamespace=(SELECT oid FROM owner) AND i.indisvalid AND i.indisready AND c.relname IN
 ('workflow_runner_recovery_versions_pkey','workflow_runner_recovery_records_pkey',
 'workflow_runner_recovery_binding_page_idx','workflow_runner_binding_keyset_idx'))`).Scan(&ready)
	if err != nil {
		return fmt.Errorf("read recovery v3 capabilities: %w", err)
	}
	if !ready {
		return fmt.Errorf("recovery v3 index or maintenance capability is missing")
	}
	return nil
}
