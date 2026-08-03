// runner-server is the separate, explicitly enabled GS8-B runner lifecycle
// control entry point. The default credential-free cmd/server never starts it.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerconfig"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerscheduler"
	runnerpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/workerregistry"
)

const requiredSchemaVersion int64 = 2

const workspaceLockDomain = "openslack.workflow-runner.workspace-singleton.v1\x00"

var supervisorPrefixPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,215}$`)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := validateRuntimeOS(runtime.GOOS); err != nil {
		logger.Error("workflow_runner_control_platform_unsupported", "code", "PLATFORM_UNSUPPORTED")
		os.Exit(1)
	}
	config, err := runnerconfig.Load()
	if err != nil {
		logger.Error("workflow_runner_control_config_failed", "code", "CONFIG_INVALID")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(startup, config.DatabaseURL)
	if err != nil {
		logger.Error("workflow_runner_control_pool_failed", "code", "DATABASE_POOL_CREATE_FAILED")
		os.Exit(1)
	}
	defer pool.Close()
	if err := checkDatabaseReady(startup, pool); err != nil {
		logger.Error("workflow_runner_control_database_not_ready", "code", "DATABASE_OR_SCHEMA_NOT_READY")
		os.Exit(1)
	}
	workspaceLock, err := acquireWorkspaceLock(startup, func(ctx context.Context) (advisorySession, error) {
		return pool.Acquire(ctx)
	}, config.WorkspaceID)
	if err != nil {
		logger.Error("workflow_runner_control_workspace_locked", "code", "WORKSPACE_SINGLETON_UNAVAILABLE")
		os.Exit(1)
	}
	defer func() {
		releaseContext, releaseCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer releaseCancel()
		_ = workspaceLock.Release(releaseContext)
	}()
	bootInstanceID, err := newBootInstanceID(config.SupervisorInstanceID, rand.Reader)
	if err != nil {
		logger.Error("workflow_runner_control_boot_identity_failed", "code", "BOOT_IDENTITY_INVALID")
		os.Exit(1)
	}
	registry, err := workerregistry.Load(config.BundleRoot, config.BundleManifestSHA256, workerregistry.Runtime{
		WorkspaceID: config.WorkspaceID, WorkspaceRoot: config.WorkspaceRoot,
		DescriptorRoot: config.DescriptorRoot,
	})
	if err != nil {
		logger.Error("workflow_runner_control_bundle_invalid", "code", "WORKER_BUNDLE_INVALID")
		os.Exit(1)
	}
	supervisor, err := registry.NewSupervisor()
	if err != nil {
		logger.Error("workflow_runner_control_supervisor_invalid", "code", "SUPERVISOR_INVALID")
		os.Exit(1)
	}
	store := runnerpostgres.New(pool)
	session, err := runnerscheduler.NewSession(runnerscheduler.SessionConfig{
		Store: store, Launcher: runnerscheduler.SealedLauncher{Supervisor: supervisor},
		ControlBuildHash:  config.ServiceBuildSHA,
		HeartbeatInterval: config.HeartbeatInterval, LeaseOfferTimeout: config.LeaseOfferTimeout,
		CancelWindow: config.CancelWindow, CancelGrace: config.CancelGrace,
		TerminalExitGrace: config.TerminalExitGrace, PollInterval: config.PollInterval,
	})
	if err != nil {
		logger.Error("workflow_runner_control_session_invalid", "code", "COMPOSITION_INVALID")
		os.Exit(1)
	}
	scheduler, err := runnerscheduler.New(runnerscheduler.Config{
		Store: store, Session: session, WorkspaceID: config.WorkspaceID,
		SupervisorInstanceID: bootInstanceID, MaxProcesses: config.MaxProcesses,
		LeaseOfferTimeout: config.LeaseOfferTimeout, LeaseDuration: config.LeaseDuration,
		PollInterval: config.PollInterval, RecoveryInterval: config.RecoveryInterval,
	})
	if err != nil {
		logger.Error("workflow_runner_control_scheduler_invalid", "code", "COMPOSITION_INVALID")
		os.Exit(1)
	}
	service, err := runnerapp.New(runnerapp.Options{
		Store: store, BuildSHA: config.ServiceBuildSHA, WorkspaceID: config.WorkspaceID,
		BearerTokenSHA256: config.BearerTokenSHA256, Logger: logger,
	})
	if err != nil {
		logger.Error("workflow_runner_control_http_invalid", "code", "COMPOSITION_INVALID")
		os.Exit(1)
	}
	logger.Info("workflow_runner_control_starting",
		"http_bind", config.HTTPBind, "network_mode", config.NetworkMode,
		"workspace_id", config.WorkspaceID, "build_sha", config.ServiceBuildSHA,
		"worker_bundle_id", registry.BundleID(), "worker_build_hash", registry.RunnerBuildHash(),
	)
	if err := run(ctx, service, scheduler, config); err != nil {
		logger.Error("workflow_runner_control_stopped_with_error", "code", "RUNNER_CONTROL_FAILED")
		os.Exit(1)
	}
}

func validateRuntimeOS(goos string) error {
	if goos != "linux" && goos != "windows" {
		return fmt.Errorf("runner-server requires a proven parent-death process-tree platform")
	}
	return nil
}

func newBootInstanceID(prefix string, entropy io.Reader) (string, error) {
	if !supervisorPrefixPattern.MatchString(prefix) || entropy == nil {
		return "", fmt.Errorf("supervisor instance prefix is invalid")
	}
	random := make([]byte, 16)
	if _, err := io.ReadFull(entropy, random); err != nil {
		return "", fmt.Errorf("generate supervisor boot identity: %w", err)
	}
	result := prefix + ".boot." + hex.EncodeToString(random)
	if len(result) > 256 {
		return "", fmt.Errorf("supervisor boot identity exceeds the closed bound")
	}
	return result, nil
}

type advisorySession interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Release()
	Hijack() *pgx.Conn
}

type workspaceAdvisoryLock struct {
	session  advisorySession
	key      int64
	mu       sync.Mutex
	released bool
}

func acquireWorkspaceLock(ctx context.Context, acquire func(context.Context) (advisorySession, error), workspaceID string) (*workspaceAdvisoryLock, error) {
	if acquire == nil {
		return nil, fmt.Errorf("workspace advisory lock acquirer is required")
	}
	session, err := acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire dedicated workspace lock connection: %w", err)
	}
	key := workspaceAdvisoryLockKey(workspaceID)
	var acquired bool
	if err := session.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&acquired); err != nil {
		session.Release()
		return nil, fmt.Errorf("acquire workspace advisory lock: %w", err)
	}
	if !acquired {
		session.Release()
		return nil, fmt.Errorf("another runner-server already owns this workspace")
	}
	return &workspaceAdvisoryLock{session: session, key: key}, nil
}

func (lock *workspaceAdvisoryLock) Release(ctx context.Context) error {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if lock.released {
		return nil
	}
	lock.released = true
	var unlocked bool
	err := lock.session.QueryRow(ctx, `SELECT pg_advisory_unlock($1)`, lock.key).Scan(&unlocked)
	if err == nil && unlocked {
		lock.session.Release()
		return nil
	}
	// Never return a session with an uncertain advisory-lock state to the pool.
	connection := lock.session.Hijack()
	if connection != nil {
		_ = connection.Close(ctx)
	}
	if err != nil {
		return fmt.Errorf("release workspace advisory lock: %w", err)
	}
	return fmt.Errorf("workspace advisory lock was not owned during release")
}

func workspaceAdvisoryLockKey(workspaceID string) int64 {
	digest := sha256.Sum256(append([]byte(workspaceLockDomain), []byte(workspaceID)...))
	return int64(binary.BigEndian.Uint64(digest[:8]))
}

type httpService interface {
	Run(context.Context, string, time.Duration) error
}

type schedulerService interface {
	Run(context.Context) error
}

func run(ctx context.Context, service httpService, scheduler schedulerService, config runnerconfig.Config) error {
	runContext, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan error, 2)
	go func() { results <- service.Run(runContext, config.HTTPBind, config.ShutdownDeadline) }()
	go func() { results <- scheduler.Run(runContext) }()
	first := <-results
	cancel()
	second := <-results
	return errors.Join(first, second)
}

func checkDatabaseReady(ctx context.Context, pool *pgxpool.Pool) error {
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("database ping: %w", err)
	}
	rows, err := pool.Query(ctx, `SELECT version, dirty FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	defer rows.Close()
	count := 0
	var version int64
	var dirty bool
	for rows.Next() {
		count++
		if err := rows.Scan(&version, &dirty); err != nil {
			return fmt.Errorf("scan schema_migrations: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate schema_migrations: %w", err)
	}
	if count != 1 || version != requiredSchemaVersion || dirty {
		return fmt.Errorf("database schema version is not exactly %d clean", requiredSchemaVersion)
	}
	return nil
}
