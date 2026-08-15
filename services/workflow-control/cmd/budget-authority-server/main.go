// budget-authority-server is the separate GS9-E2 durable budget
// qualification entry point. Without the exact local qualification mode it
// starts health-only and never opens PostgreSQL or registers budget routes.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	budgetpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	configuration, err := config.LoadBudgetAuthority()
	if err != nil {
		logger.Error("workflow_control_budget_authority_config_failed", "code", "CONFIG_INVALID")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	options := budgetapp.Options{
		QualificationMode: configuration.QualificationMode, BuildSHA: configuration.ServiceBuildSHA,
		BearerTokenSHA256: configuration.BearerTokenSHA256, WorkspaceID: configuration.WorkspaceID,
		CallerID: configuration.CallerID, RoutingEpoch: configuration.RoutingEpoch,
		Seed: budgetstore.QualificationSeed{
			PolicyHash: configuration.PolicyHash,
			Limit: budgetstore.Quantities{
				Tokens: configuration.LimitTokens, NanoUSD: configuration.LimitNanoUSD, Calls: configuration.LimitCalls,
			},
		},
		Logger: logger,
	}
	var pool *pgxpool.Pool
	if configuration.QualificationMode {
		startup, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		pool, err = pgxpool.New(startup, configuration.DatabaseURL)
		if err != nil {
			logger.Error("workflow_control_budget_authority_pool_failed", "code", "DATABASE_POOL_CREATE_FAILED")
			os.Exit(1)
		}
		defer pool.Close()
		if err := databaseready.RequireCleanSchema(startup, pool, databaseready.BudgetProfile); err != nil {
			logger.Error("workflow_control_budget_authority_database_not_ready", "code", "DATABASE_OR_SCHEMA_NOT_READY")
			os.Exit(1)
		}
		options.Repository = budgetpostgres.New(pool)
	}
	service, err := budgetapp.New(options)
	if err != nil {
		logger.Error("workflow_control_budget_authority_http_invalid", "code", "COMPOSITION_INVALID")
		os.Exit(1)
	}
	logger.Info("workflow_control_budget_authority_starting",
		"http_bind", configuration.HTTPBind, "mode", configuration.Mode,
		"qualification_mode", configuration.QualificationMode, "build_sha", configuration.ServiceBuildSHA,
		"typescript_production_workflow_authority", true,
		"go_budget_authority", "qualification-only", "production_budget_authority", false,
		"qualification_seed_configured", configuration.QualificationMode,
		"production_initial_budget_policy_source_delivered", false,
		"runner_protocol_v2_delivered", false, "routing_activated", false,
		"canary_activated", false, "cutover_activated", false,
	)
	if err := service.Run(ctx, configuration.HTTPBind, configuration.ShutdownDeadline); err != nil {
		logger.Error("workflow_control_budget_authority_stopped_with_error", "code", "BUDGET_AUTHORITY_SERVER_FAILED")
		os.Exit(1)
	}
}
