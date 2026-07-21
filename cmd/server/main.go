// cmd/server is the rc_wsman binary entry point.
//
// B1/B2 scope: configuration loading, PostgreSQL pool setup, schema migrations
// with fail-closed version verification, HTTP server lifecycle, and graceful
// shutdown. Workers and business handlers are reserved for later batches.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5/pgxpool"

	"rc_wsman/internal/app"
	"rc_wsman/internal/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config_load_failed", "error", err)
		os.Exit(1)
	}
	logger.Info("config_loaded",
		"http_bind", cfg.HTTPBind,
		"metrics_path", cfg.MetricsPath,
		"active_pepper_id", cfg.ActivePepper.ID,
	)

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("db_pool_create_failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		logger.Error("db_ping_failed", "error", err)
		os.Exit(1)
	}
	logger.Info("db_pool_ready")

	if err := runMigrations(cfg.MigrationSource, cfg.DatabaseURL); err != nil {
		logger.Error("migration_failed", "error", err)
		os.Exit(1)
	}
	logger.Info("migrations_applied")

	// TODO(B3-B5): start workers and metrics collector, wire business handlers.

	srv := app.NewServer(cfg.HTTPBind, cfg.MetricsPath, pool, logger)
	srv.SetReady(func() bool {
		pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		return pool.Ping(pingCtx) == nil
	})

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := srv.Run(ctx, cfg.ShutdownDeadline); err != nil {
		logger.Error("server_run_failed", "error", err)
		os.Exit(1)
	}
	logger.Info("server_stopped")
}

// runMigrations applies all pending migrations and verifies the schema is not
// dirty. It fails closed: any migration error or dirty state aborts startup.
func runMigrations(source, databaseURL string) error {
	m, err := migrate.New("file://"+source, databaseURL)
	if err != nil {
		return fmt.Errorf("migrate init: %w", err)
	}
	defer func() { _, _ = m.Close() }()

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("migrate up: %w", err)
	}
	version, dirty, err := m.Version()
	if err != nil {
		return fmt.Errorf("migrate version: %w", err)
	}
	if dirty {
		return fmt.Errorf("schema dirty at version %d", version)
	}
	return nil
}
