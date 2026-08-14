// checkpoint-shadow-server is a separate, default-off GS9-C observation
// process. It never owns Workflow checkpoint or resume decisions.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointshadowapp"
	checkpointpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointshadowstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	configuration, err := config.LoadCheckpointShadow()
	if err != nil {
		logger.Error("workflow_checkpoint_shadow_config_failed", "code", "CONFIG_INVALID")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	options := checkpointshadowapp.Options{QualificationMode: configuration.QualificationMode, BuildSHA: configuration.ServiceBuildSHA, BearerTokenSHA256: configuration.BearerTokenSHA256, WorkspaceID: configuration.WorkspaceID, CallerID: configuration.CallerID, Logger: logger}
	var pool *pgxpool.Pool
	if configuration.QualificationMode {
		startup, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		pool, err = pgxpool.New(startup, configuration.DatabaseURL)
		if err != nil {
			logger.Error("workflow_checkpoint_shadow_pool_failed", "code", "DATABASE_POOL_CREATE_FAILED")
			os.Exit(1)
		}
		defer pool.Close()
		if err := databaseready.RequireCleanSchema(startup, pool, databaseready.CheckpointProfile); err != nil {
			logger.Error("workflow_checkpoint_shadow_database_not_ready", "code", "DATABASE_OR_SCHEMA_NOT_READY")
			os.Exit(1)
		}
		options.Store = checkpointpostgres.New(pool)
	}
	service, err := checkpointshadowapp.New(options)
	if err != nil {
		logger.Error("workflow_checkpoint_shadow_http_invalid", "code", "COMPOSITION_INVALID")
		os.Exit(1)
	}
	logger.Info("workflow_checkpoint_shadow_starting", "http_bind", configuration.HTTPBind, "mode", configuration.Mode, "authority", "typescript", "go_role", "observer_only", "checkpoint_authority", false, "resume_authority", false)
	if err := service.Run(ctx, configuration.HTTPBind, configuration.ShutdownDeadline); err != nil {
		logger.Error("workflow_checkpoint_shadow_stopped_with_error", "code", "CHECKPOINT_SHADOW_SERVER_FAILED")
		os.Exit(1)
	}
}
