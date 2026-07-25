// cmd/server is the rc_wsman binary entry point.
//
// B1/B2 scope: configuration loading, PostgreSQL pool setup, schema migrations
// with fail-closed version verification, HTTP server lifecycle, and graceful
// shutdown. B3 wires the caller access and vendor registry business handlers.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/app"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess"
	calleraccesspostgres "github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/delivery"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/leaserecovery"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore"
	notificationstorepostgres "github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/operationscontrol"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/reliability"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry"
	vendorregistrypostgres "github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry/postgres"
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

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
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

	// B3 business-layer dependencies.
	caRepo := calleraccesspostgres.New(pool)
	peppers := cfg.Peppers()
	if err := calleraccess.ValidateLoadedPepperGenerations(ctx, caRepo, peppers); err != nil {
		logger.Error("pepper_generation_validation_failed", "error", err)
		os.Exit(1)
	}
	authenticator := calleraccess.NewAuthenticator(caRepo, peppers)
	nsRepo := notificationstorepostgres.New(pool, logger)
	vrRepo := vendorregistrypostgres.New(pool)
	vrConfig, err := vendorregistry.LoadConfigFromEnvironment(os.Getenv)
	if err != nil {
		logger.Error("vendor_registry_config_failed", "error", err)
		os.Exit(1)
	}
	vrService, err := vendorregistry.NewValidatedService(ctx, vrRepo, vrConfig, vendorregistry.SecurityEventFunc(func(event vendorregistry.SecurityEvent) {
		logger.Warn(event.Name, "operation", event.Operation, "failure_code", event.FailureCode)
	}))
	if err != nil {
		logger.Error("vendor_registry_config_preflight_failed", "error", err)
		os.Exit(1)
	}
	operationsService, err := operationscontrol.New(nsRepo)
	if err != nil {
		logger.Error("operations_control_init_failed", "error", err)
		os.Exit(1)
	}
	reliabilityService, err := reliability.New(nsRepo, cfg.MetricsCollectionTimeout)
	if err != nil {
		logger.Error("reliability_init_failed", "error", err)
		os.Exit(1)
	}
	recoveryCtx, cancelRecovery := context.WithCancel(context.Background())
	workerCtx, cancelWorker := context.WithCancel(context.Background())
	serverCtx, cancelServer := context.WithCancel(context.Background())
	defer cancelRecovery()
	defer cancelWorker()
	defer cancelServer()
	var workerDone <-chan error

	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "unknown-instance"
	}
	recoveryActor := notificationstore.ActorContext{
		Kind: notificationstore.ActorSystem, ActorID: "lease-recovery:" + hostname,
		VendorScope: []string{"*"}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityRecoverExpiredLeases},
	}
	recoveryHealth := make(chan leaserecovery.HealthEvent, 16)
	recoveryRunner, err := leaserecovery.New(nsRepo, recoveryActor, cfg.RecoveryInterval, cfg.RecoveryBatchSize, recoveryHealth)
	if err != nil {
		logger.Error("lease_recovery_init_failed", "error", err)
		os.Exit(1)
	}
	recoveryDone := make(chan error, 1)
	go func() { recoveryDone <- recoveryRunner.Run(recoveryCtx) }()
	go func() {
		for {
			select {
			case <-recoveryCtx.Done():
				return
			case event := <-recoveryHealth:
				logger.Warn("lease_recovery_health_event", "error_code", event.ErrorCode, "occurred_at", event.OccurredAt)
			}
		}
	}()
	logger.Info("lease_recovery_started", "interval", cfg.RecoveryInterval, "batch_size", cfg.RecoveryBatchSize)

	// B4 delivery worker wiring. The worker claims from the Store and delivers to
	// Registry-approved endpoints with SSRF-safe outbound HTTP.
	if len(cfg.WorkerVendorScope) > 0 {
		deliveryConfig := delivery.DefaultConfig()
		deliveryConfig.LeaseTTL = cfg.LeaseDuration
		addressPolicy, err := delivery.NewAddressPolicy(deliveryConfig.DefaultAllowedPorts, deliveryConfig.DefaultForbiddenCIDRs)
		if err != nil {
			logger.Error("delivery_policy_failed", "error", err)
			os.Exit(1)
		}
		resolver := delivery.NewEnvCredentialResolver(cfg.EnvCredentialAllowlist)
		runner, err := delivery.NewRunner(
			deliveryConfig,
			nsRepo,
			vrService,
			resolver,
			delivery.NetResolver{},
			delivery.NewSafeTransport(),
			addressPolicy,
			delivery.RealClock{},
			delivery.CryptoRNG{},
		)
		if err != nil {
			logger.Error("delivery_runner_failed", "error", err)
			os.Exit(1)
		}
		workerActor := notificationstore.ActorContext{
			Kind:         notificationstore.ActorWorker,
			ActorID:      "worker-1",
			VendorScope:  cfg.WorkerVendorScope,
			Capabilities: []notificationstore.Capability{notificationstore.CapabilityClaimDelivery, notificationstore.CapabilityRecordDeliveryResult},
		}
		healthEvents := make(chan delivery.HealthEvent, 64)
		worker, err := delivery.NewWorker(runner, workerActor, cfg.WorkerInterval, cfg.WorkerConcurrency, healthEvents)
		if err != nil {
			logger.Error("delivery_worker_failed", "error", err)
			os.Exit(1)
		}
		done := make(chan error, 1)
		workerDone = done
		go func() { done <- worker.Run(workerCtx) }()
		go func() {
			for {
				select {
				case <-workerCtx.Done():
					return
				case event := <-healthEvents:
					logger.Warn("delivery_health_event",
						"worker_id", event.WorkerID,
						"error_code", event.ErrorCode,
						"occurred_at", event.Time,
					)
				}
			}
		}()
		logger.Info("delivery_worker_started", "vendor_scope", cfg.WorkerVendorScope)
	} else {
		logger.Warn("delivery_worker_disabled", "reason", "WORKER_VENDOR_SCOPE empty")
	}

	srv := app.NewServer(cfg.HTTPBind, cfg.MetricsPath, cfg.DeploymentDigest, pool, logger)
	srv.SetDeps(app.Deps{
		Store:          nsRepo,
		Authenticator:  authenticator,
		VendorRegistry: vrService,
		Operations:     operationsService,
		Reliability:    reliabilityService,
	})
	var accepting atomic.Bool
	accepting.Store(true)
	srv.SetReady(func() bool {
		if !accepting.Load() {
			return false
		}
		pingCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return pool.Ping(pingCtx) == nil
	})

	serverDone := make(chan error, 1)
	go func() { serverDone <- srv.Run(serverCtx, cfg.ShutdownDeadline) }()
	var serverErr error
	serverFinished := false
	select {
	case <-ctx.Done():
	case serverErr = <-serverDone:
		serverFinished = true
		stop()
	}

	// Ordered shutdown: first withdraw readiness and stop accepting/claiming,
	// then let bounded sent attempts and their Store result writes finish. Lease
	// recovery remains live until workers have drained, and the pool closes last.
	accepting.Store(false)
	cancelServer()
	cancelWorker()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownDeadline)
	defer cancelShutdown()
	if !serverFinished {
		select {
		case serverErr = <-serverDone:
		case <-shutdownCtx.Done():
			serverErr = shutdownCtx.Err()
			logger.Error("http_server_shutdown_timeout")
		}
	}
	if workerDone != nil {
		select {
		case err := <-workerDone:
			if err != nil && !errors.Is(err, context.Canceled) {
				logger.Error("delivery_worker_run_failed", "error", err)
			}
		case <-shutdownCtx.Done():
			logger.Error("delivery_worker_shutdown_timeout")
		}
	}
	cancelRecovery()
	select {
	case err := <-recoveryDone:
		if err != nil && !errors.Is(err, context.Canceled) {
			logger.Error("lease_recovery_run_failed", "error", err)
		}
	case <-shutdownCtx.Done():
		logger.Error("lease_recovery_shutdown_timeout")
	}
	if serverErr != nil {
		logger.Error("server_run_failed", "error", serverErr)
		os.Exit(1)
	}
	logger.Info("server_stopped")
}

// runMigrations applies all pending migrations and verifies the schema is not
// dirty. It fails closed: any migration error or dirty state aborts startup.
func runMigrations(source, databaseURL string) error {
	// The migrate pgx/v5 driver is registered under the pgx5 URL scheme while
	// the runtime pool deliberately uses the conventional postgres scheme.
	migrationURL := databaseURL
	if strings.HasPrefix(migrationURL, "postgres://") {
		migrationURL = "pgx5://" + strings.TrimPrefix(migrationURL, "postgres://")
	} else if strings.HasPrefix(migrationURL, "postgresql://") {
		migrationURL = "pgx5://" + strings.TrimPrefix(migrationURL, "postgresql://")
	}
	m, err := migrate.New("file://"+source, migrationURL)
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
