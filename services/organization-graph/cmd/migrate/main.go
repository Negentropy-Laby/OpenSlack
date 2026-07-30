// migrate applies the Organization Graph PostgreSQL schema and verifies exact
// version 1 with dirty=false.
package main

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/config"
)

const requiredSchemaVersion = 1

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.LoadMigration()
	if err != nil {
		logFailure(logger, "graph_migration_config_failed", "CONFIG_INVALID")
		os.Exit(1)
	}
	if err := run(cfg.MigrationSource, cfg.DatabaseURL); err != nil {
		logFailure(logger, "graph_migration_failed", "MIGRATION_OR_SCHEMA_CHECK_FAILED")
		os.Exit(1)
	}
	logger.Info("graph_migration_ready", "schema_version", requiredSchemaVersion)
}

func logFailure(logger *slog.Logger, event, code string) {
	logger.Error(event, "failure_code", code)
}

func run(source, databaseURL string) error {
	instance, err := migrate.New("file://"+source, migrationDatabaseURL(databaseURL))
	if err != nil {
		return fmt.Errorf("initialize migrations: %w", err)
	}
	defer func() { _, _ = instance.Close() }()

	if err := instance.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w", err)
	}
	version, dirty, err := instance.Version()
	if err != nil {
		return fmt.Errorf("read migration version: %w", err)
	}
	if version != requiredSchemaVersion || dirty {
		return fmt.Errorf(
			"schema_migrations must be version=%d dirty=false; found version=%d dirty=%t",
			requiredSchemaVersion,
			version,
			dirty,
		)
	}
	return nil
}

func migrationDatabaseURL(databaseURL string) string {
	if strings.HasPrefix(databaseURL, "postgres://") {
		return "pgx5://" + strings.TrimPrefix(databaseURL, "postgres://")
	}
	if strings.HasPrefix(databaseURL, "postgresql://") {
		return "pgx5://" + strings.TrimPrefix(databaseURL, "postgresql://")
	}
	return databaseURL
}
