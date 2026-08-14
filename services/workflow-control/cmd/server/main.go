// server is the private GS7-B Workflow Control shadow entry point.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/app"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
	shadowpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore/postgres"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("workflow_control_shadow_config_failed", "code", "CONFIG_INVALID")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(startup, cfg.DatabaseURL)
	if err != nil {
		logger.Error("workflow_control_shadow_pool_failed", "code", "DATABASE_POOL_CREATE_FAILED")
		os.Exit(1)
	}
	defer pool.Close()
	if err := databaseready.RequireCleanSchema(startup, pool, databaseready.ShadowProfile); err != nil {
		logger.Error("workflow_control_shadow_database_not_ready", "code", "DATABASE_OR_SCHEMA_NOT_READY")
		os.Exit(1)
	}
	service, err := app.New(app.Options{Store: shadowpostgres.New(pool), BuildSHA: cfg.ServiceBuildSHA, Logger: logger})
	if err != nil {
		logger.Error("workflow_control_shadow_composition_failed", "code", "COMPOSITION_INVALID")
		os.Exit(1)
	}
	logger.Info("workflow_control_shadow_starting", "http_bind", cfg.HTTPBind, "network_mode", cfg.NetworkMode, "build_sha", cfg.ServiceBuildSHA)
	if err := service.Run(ctx, cfg.HTTPBind, cfg.ShutdownDeadline); err != nil {
		logger.Error("workflow_control_shadow_stopped_with_error", "code", "HTTP_SERVER_FAILED")
		os.Exit(1)
	}
}
