package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/config"
)

func main() {
	if err := run(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "workflow-control shadow migration failed")
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.LoadMigration()
	if err != nil {
		return err
	}
	source := "file://" + filepath.ToSlash(cfg.MigrationSource)
	migration, err := migrate.New(source, cfg.MigrationDatabaseURL)
	if err != nil {
		return fmt.Errorf("create migration: %w", err)
	}
	defer migration.Close()
	if err := migration.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migration: %w", err)
	}
	return nil
}
