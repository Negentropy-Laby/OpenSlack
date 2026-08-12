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

// Database is the narrow pgxpool surface needed for startup validation.
type Database interface {
	Ping(context.Context) error
	QueryRow(context.Context, string, ...any) pgx.Row
}

// RequireCleanSchema requires exactly one non-dirty migration row in range.
func RequireCleanSchema(ctx context.Context, database Database, supported Range) error {
	if database == nil || supported.Minimum < 1 || supported.Maximum < supported.Minimum {
		return fmt.Errorf("database schema range is invalid")
	}
	if err := database.Ping(ctx); err != nil {
		return fmt.Errorf("database ping: %w", err)
	}
	var count, version int64
	var dirty bool
	if err := database.QueryRow(ctx, `SELECT count(*), COALESCE(max(version), 0), COALESCE(bool_or(dirty), false) FROM schema_migrations`).Scan(&count, &version, &dirty); err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	if count != 1 || dirty || version < supported.Minimum || version > supported.Maximum {
		return fmt.Errorf("database schema version must be one clean row between %d and %d", supported.Minimum, supported.Maximum)
	}
	return nil
}
