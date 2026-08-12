// authority-server is the separate GS9-B Workflow Control authority
// qualification entry point. Without the exact local qualification mode it
// starts health-only and never opens PostgreSQL or registers authority routes.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authorityapp"
	authoritypostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
)

const minimumSchemaVersion int64 = 3
const maximumSchemaVersion int64 = 4

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	configuration, err := config.LoadAuthority()
	if err != nil {
		logger.Error("workflow_control_authority_config_failed", "code", "CONFIG_INVALID")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	options := authorityapp.Options{
		QualificationMode: configuration.QualificationMode, BuildSHA: configuration.ServiceBuildSHA,
		BearerTokenSHA256: configuration.BearerTokenSHA256, WorkspaceID: configuration.WorkspaceID,
		CallerID: configuration.CallerID, RoutingEpoch: configuration.RoutingEpoch, Logger: logger,
	}
	var pool *pgxpool.Pool
	if configuration.QualificationMode {
		startup, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		pool, err = pgxpool.New(startup, configuration.DatabaseURL)
		if err != nil {
			logger.Error("workflow_control_authority_pool_failed", "code", "DATABASE_POOL_CREATE_FAILED")
			os.Exit(1)
		}
		defer pool.Close()
		if err := databaseready.RequireCleanSchema(startup, pool, databaseready.Range{Minimum: minimumSchemaVersion, Maximum: maximumSchemaVersion}); err != nil {
			logger.Error("workflow_control_authority_database_not_ready", "code", "DATABASE_OR_SCHEMA_NOT_READY")
			os.Exit(1)
		}
		options.Repository = authoritypostgres.New(pool)
	}
	service, err := authorityapp.New(options)
	if err != nil {
		logger.Error("workflow_control_authority_http_invalid", "code", "COMPOSITION_INVALID")
		os.Exit(1)
	}
	logger.Info("workflow_control_authority_starting",
		"http_bind", configuration.HTTPBind, "mode", configuration.Mode,
		"qualification_mode", configuration.QualificationMode, "build_sha", configuration.ServiceBuildSHA,
		"authority", "typescript", "routing_activated", false, "accept_new_records", false,
	)
	if err := service.Run(ctx, configuration.HTTPBind, configuration.ShutdownDeadline); err != nil {
		logger.Error("workflow_control_authority_stopped_with_error", "code", "AUTHORITY_SERVER_FAILED")
		os.Exit(1)
	}
}
