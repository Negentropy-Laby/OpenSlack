// authority-server is the separate Workflow Control authority entry point.
// It starts health-only unless an exact qualification or GS9-G new-record
// canary mode is configured; accepting new canary records remains separately
// default-off.
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
		AuthorityEnabled: configuration.AuthorityEnabled, QualificationMode: configuration.QualificationMode,
		CanaryMode: configuration.CanaryMode, AcceptNewRecords: configuration.AcceptNewRecords,
		DrainEpochs: configuration.DrainEpochs, BuildSHA: configuration.ServiceBuildSHA,
		BearerTokenSHA256: configuration.BearerTokenSHA256, WorkspaceID: configuration.WorkspaceID,
		CallerID: configuration.CallerID, RoutingEpoch: configuration.RoutingEpoch, Logger: logger,
	}
	var pool *pgxpool.Pool
	if configuration.AuthorityEnabled {
		startup, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		pool, err = pgxpool.New(startup, configuration.DatabaseURL)
		if err != nil {
			logger.Error("workflow_control_authority_pool_failed", "code", "DATABASE_POOL_CREATE_FAILED")
			os.Exit(1)
		}
		defer pool.Close()
		schemaVersion, schemaErr := databaseready.RequireCleanSchemaVersion(startup, pool, databaseready.AuthorityProfile)
		if schemaErr != nil {
			logger.Error("workflow_control_authority_database_not_ready", "code", "DATABASE_OR_SCHEMA_NOT_READY")
			os.Exit(1)
		}
		options.Repository = authoritypostgres.New(pool, schemaVersion)
	}
	service, err := authorityapp.New(options)
	if err != nil {
		logger.Error("workflow_control_authority_http_invalid", "code", "COMPOSITION_INVALID")
		os.Exit(1)
	}
	logger.Info("workflow_control_authority_starting",
		"http_bind", configuration.HTTPBind, "mode", configuration.Mode,
		"qualification_mode", configuration.QualificationMode, "build_sha", configuration.ServiceBuildSHA,
		"authority", map[bool]string{false: "typescript", true: "workflow-control"}[configuration.CanaryMode],
		"routing_activated", configuration.CanaryMode, "accept_new_records", configuration.CanaryMode && configuration.AcceptNewRecords,
	)
	if err := service.Run(ctx, configuration.HTTPBind, configuration.ShutdownDeadline); err != nil {
		logger.Error("workflow_control_authority_stopped_with_error", "code", "AUTHORITY_SERVER_FAILED")
		os.Exit(1)
	}
}
