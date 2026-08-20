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

const CurrentSchemaVersion int64 = 7

var (
	ShadowProfile             = Range{Minimum: 1, Maximum: CurrentSchemaVersion}
	RunnerProfile             = Range{Minimum: 2, Maximum: CurrentSchemaVersion}
	AuthorityProfile          = Range{Minimum: 3, Maximum: CurrentSchemaVersion}
	CheckpointProfile         = Range{Minimum: 4, Maximum: CurrentSchemaVersion}
	EffectProfile             = Range{Minimum: 5, Maximum: CurrentSchemaVersion}
	BudgetProfile             = Range{Minimum: 6, Maximum: CurrentSchemaVersion}
	RunnerV2FoundationProfile = Range{Minimum: 7, Maximum: CurrentSchemaVersion}
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
