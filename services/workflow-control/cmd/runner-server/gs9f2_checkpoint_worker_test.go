//go:build sealed_worker_integration

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authorityapp"
	authoritypostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	budgetpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/processsupervisor"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerconfig"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerscheduler"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	runnerpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/storageproof"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/workerregistry"
)

// Uses the actual sealed Node worker, HTTP services and isolated PostgreSQL schema.
// The existing host PostgreSQL gate runs this cross-language integration explicitly;
// the Go-only container gate continues to require only its pinned Go toolchain.
// The budget and failure scenarios confine provider requests to loopback.
func TestGS9F2SealedCheckpointResume(t *testing.T) {
	for _, scenario := range []string{"checkpoint", "budget", "provider_failure_isolated", "reported_overrun", "first_budget_on_resume"} {
		t.Run(scenario, func(t *testing.T) { testGS9F2SealedCheckpointResume(t, scenario) })
	}
}

func testGS9F2SealedCheckpointResume(t *testing.T, scenario string) {
	if strings.TrimSpace(os.Getenv("DATABASE_URL")) == "" {
		t.Fatal("sealed checkpoint qualification requires DATABASE_URL")
	}
	pool := testsupport.OpenPostgres(t)
	version := databaseready.CurrentSchemaVersion
	if _, err := pool.Exec(t.Context(), "CREATE TABLE schema_migrations(version BIGINT PRIMARY KEY,dirty BOOLEAN NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), "INSERT INTO schema_migrations VALUES($1,false)", version); err != nil {
		t.Fatal(err)
	}
	_, file, _, _ := runtime.Caller(0)
	repositoryRoot := filepath.Clean(filepath.Join(filepath.Dir(file), "../../../.."))
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	node, err = filepath.EvalSymlinks(node)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	workspaceRoot := filepath.Join(root, "workspace")
	descriptorRoot := filepath.Join(workspaceRoot, ".openslack.local", "descriptors")
	journalRoot := filepath.Join(workspaceRoot, ".openslack.local", "delivery")
	for _, p := range []string{workspaceRoot, descriptorRoot, journalRoot} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	bundleRoot := filepath.Join(root, "bundle")
	stage := exec.CommandContext(t.Context(), bun, "scripts/qualification/workflow-runner-bundle.ts", "stage", "--bundle-root", bundleRoot, "--node-executable", node)
	stage.Dir = repositoryRoot
	if out, err := stage.CombinedOutput(); err != nil {
		t.Fatalf("stage sealed worker: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(bundleRoot, workerregistry.ManifestFilename))
	if err != nil {
		t.Fatal(err)
	}
	hash := func(s string) string { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:]) }
	workspace := "workspace.checkpoint.fixture"
	caller := "workflow-runner-v2"
	authorityBuild := strings.Repeat("1", 64)
	// Both Go HTTP planes are built from the same source revision. The sealed
	// worker build remains the independent entrypoint digest from its manifest.
	runnerBuild := authorityBuild
	authorityToken := strings.Repeat("a", 48)
	runnerToken := strings.Repeat("r", 48)
	authority, err := authorityapp.New(authorityapp.Options{Repository: authoritypostgres.New(pool, version),
		Mode: config.AuthorityModeNewRecordCanary, AcceptNewRecords: true, BuildSHA: authorityBuild,
		WorkspaceID: workspace, CallerID: caller, RoutingEpoch: 1, BearerTokenSHA256: hash(authorityToken)})
	if err != nil {
		t.Fatal(err)
	}
	authorityHTTP := httptest.NewServer(authority.Handler())
	defer authorityHTTP.Close()
	store := runnerpostgres.NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{}).WithReconciliationWriter(storageproof.NewClient(authorityHTTP.URL, authorityToken, workspace, caller, authorityBuild), caller)
	runner, err := runnerapp.New(runnerapp.Options{Store: store, V2Store: store, BindingStore: store, AdmissionStore: store,
		RecoveryStore: store, RecoveryV2Store: store, RecoveryV3Store: store, ReconciliationStore: store,
		SchemaVersion: version, BuildSHA: runnerBuild, WorkspaceID: workspace, BearerTokenSHA256: hash(runnerToken),
		RunAuthorityOrigin: authorityHTTP.URL, RunAuthorityCallerID: caller, RunAuthorityBuildSHA: authorityBuild, RunAuthorityTokenSHA256: hash(authorityToken)})
	if err != nil {
		t.Fatal(err)
	}
	runnerHTTP := httptest.NewServer(runner.Handler())
	defer runnerHTTP.Close()
	budgetToken := strings.Repeat("b", 48)
	budgetRepository := budgetpostgres.New(pool)
	budget, err := budgetapp.New(budgetapp.Options{Repository: budgetRepository, QualificationMode: true, BuildSHA: authorityBuild,
		WorkspaceID: workspace, CallerID: caller, RoutingEpoch: 1, BearerTokenSHA256: hash(budgetToken),
		Seed: budgetstore.QualificationSeed{PolicyHash: strings.Repeat("b", 64), Limit: budgetstore.Quantities{Tokens: "1000", NanoUSD: "1000", Calls: "2"}}})
	if err != nil {
		t.Fatal(err)
	}
	budgetHandler := budget.Handler()
	var expiryProbe atomic.Bool
	var reserveRequests atomic.Uint32
	budgetHTTP := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPost && request.URL.Path == budgetapp.RouteReserve {
			reserve := reserveRequests.Add(1)
			waitOnAccount := scenario == "budget" && reserve == 2
			if waitOnAccount || (scenario == "first_budget_on_resume" && reserve == 1) {
				expiryProbe.Store(true)
				if err := checkExpiredResumeBudgetLease(request, budgetHandler, pool, budgetRepository, workspace, waitOnAccount); err != nil {
					t.Error(err)
					http.Error(w, "resumed budget lease probe failed", http.StatusInternalServerError)
					return
				}
			}
		}
		budgetHandler.ServeHTTP(w, request)
	}))
	defer budgetHTTP.Close()
	registry, err := workerregistry.Load(bundleRoot, hash(string(raw)), workerregistry.Runtime{
		WorkspaceID: workspace, WorkspaceRoot: workspaceRoot, DescriptorRoot: descriptorRoot,
		V2RuntimeDelivery: &runnerconfig.V2RuntimeDeliveryRuntime{Origin: runnerHTTP.URL, BearerToken: runnerToken, BearerSHA256: hash(runnerToken), JournalRoot: journalRoot, BudgetOrigin: budgetHTTP.URL, BudgetToken: budgetToken, BudgetCallerID: caller},
		V2RunAuthority:    &runnerconfig.V2RunAuthorityRuntime{Origin: authorityHTTP.URL, BearerToken: authorityToken, BearerSHA256: hash(authorityToken), CallerID: caller, ExpectedBuild: authorityBuild}})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("sealed worker build=%s manifest_sha256=%s", registry.RunnerBuildHash(), hash(string(raw)))
	supervisor, err := registry.NewSupervisor()
	if err != nil {
		t.Fatal(err)
	}
	session, err := runnerscheduler.NewV2Session(runnerscheduler.V2SessionConfig{Store: store, Launcher: checkpointFixtureLauncher{supervisor, t}, ControlBuildHash: runnerBuild, ExpectedRunnerBuildHash: registry.RunnerBuildHash(), HeartbeatInterval: time.Second, LeaseOfferTimeout: 10 * time.Second, CancelGrace: 5 * time.Second, TerminalExitGrace: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := runnerscheduler.New(runnerscheduler.Config{Store: store, V2Session: checkpointFixtureSession{session, t}, AuthorityRecovery: store,
		WorkspaceID: workspace, SupervisorInstanceID: "runner.checkpoint.fixture", MaxProcesses: 1, LeaseOfferTimeout: 10 * time.Second, LeaseDuration: time.Minute, PollInterval: 100 * time.Millisecond, RecoveryInterval: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- scheduler.Run(ctx) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("sealed scheduler: %v", err)
		}
	}()
	driverConfig := map[string]string{"root": workspaceRoot, "descriptorRoot": descriptorRoot, "runnerOrigin": runnerHTTP.URL, "authorityOrigin": authorityHTTP.URL, "budgetOrigin": budgetHTTP.URL, "budgetToken": budgetToken, "workspaceId": workspace, "runnerToken": runnerToken, "authorityToken": authorityToken, "runnerBuild": runnerBuild, "authorityBuild": authorityBuild}
	const (
		runID       = "run.checkpoint.worker"
		failedRunID = "run.provider.failure"
	)
	startProvider := func(targetRunID, phase, reserved, settled string, status int) (string, *atomic.Int32) {
		calls := new(atomic.Int32)
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			var body struct {
				Model    string "json:\"model\""
				Messages []struct {
					Content string "json:\"content\""
				} "json:\"messages\""
			}
			if req.Method != http.MethodPost || req.URL.Path != "/chat/completions" ||
				req.Header.Get("Authorization") != "Bearer "+budgetToken ||
				json.NewDecoder(http.MaxBytesReader(w, req.Body, 64*1024)).Decode(&body) != nil ||
				body.Model != "fixture-budget-model" || len(body.Messages) != 2 {
				t.Error("invalid loopback budget provider request")
				http.Error(w, "invalid fixture request", http.StatusBadRequest)
				return
			}
			call := calls.Add(1)
			account, err := budgetRepository.ReadAccount(req.Context(), workspace, targetRunID)
			if call != 1 || body.Messages[1].Content != "Budget fixture "+phase ||
				err != nil || account.Value["accountId"] != "checkpoint.fixture" ||
				account.Value["reserved"].(budgetcontract.Record)["calls"] != reserved ||
				account.Value["settled"].(budgetcontract.Record)["calls"] != settled {
				t.Errorf("loopback %s call %d has no matching budget reservation: %v", phase, call, err)
				http.Error(w, "fixture reservation mismatch", http.StatusBadRequest)
				return
			}
			if status == http.StatusServiceUnavailable {
				w.WriteHeader(status)
				if _, err := w.Write([]byte(`{"error":{"message":"fixture gateway unavailable"}}`)); err != nil {
					t.Error(err)
				}
				return
			}
			totalTokens := 17
			if scenario == "reported_overrun" {
				reservedTokens, err := strconv.Atoi(account.Value["reserved"].(budgetcontract.Record)["tokens"].(string))
				if err != nil || reservedTokens < 5 {
					t.Errorf("invalid overrun fixture reservation: %d, %v", reservedTokens, err)
					http.Error(w, "invalid overrun fixture reservation", http.StatusBadRequest)
					return
				}
				totalTokens = reservedTokens + 1
			}
			if err := json.NewEncoder(w).Encode(map[string]any{
				"choices": []any{map[string]any{"message": map[string]any{"content": "{\"phase\":\"" + phase + "\"}"}}},
				"usage":   map[string]int{"prompt_tokens": totalTokens - 5, "completion_tokens": 5, "total_tokens": totalTokens},
			}); err != nil {
				t.Error(err)
			}
		}))
		t.Cleanup(provider.Close)
		return provider.URL, calls
	}
	var initialCalls, resumeCalls, failureCalls *atomic.Int32
	switch scenario {
	case "budget":
		driverConfig["localProviderOrigin"], initialCalls = startProvider(runID, "First", "1", "0", http.StatusOK)
		driverConfig["resumeProviderOrigin"], resumeCalls = startProvider(runID, "Done", "2", "1", http.StatusOK)
	case "first_budget_on_resume":
		driverConfig["resumeOnlyProviderOrigin"], resumeCalls = startProvider(runID, "Done", "1", "0", http.StatusOK)
	case "reported_overrun":
		driverConfig["failureProviderOrigin"], failureCalls = startProvider(failedRunID, "First", "1", "0", http.StatusOK)
	case "provider_failure_isolated":
		driverConfig["failureProviderOrigin"], failureCalls = startProvider(failedRunID, "First", "1", "0", http.StatusServiceUnavailable)
	}
	encoded, err := json.Marshal(driverConfig)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, "fixture.json")
	if err := os.WriteFile(configPath, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	driver := exec.CommandContext(t.Context(), bun, "scripts/qualification/workflow-checkpoint-resume.fixture.ts", configPath)
	driver.Dir = repositoryRoot
	output, err := driver.CombinedOutput()
	if err != nil {
		for _, table := range []string{"workflow_runner_jobs", "workflow_runner_attempts", "workflow_runner_authority_bindings", "workflow_control_runs"} {
			rows, queryErr := pool.Query(t.Context(), "SELECT to_jsonb(t)::text FROM "+table+" t")
			if queryErr != nil {
				t.Logf("fixture %s: %v", table, queryErr)
				continue
			}
			for rows.Next() {
				var detail string
				if rows.Scan(&detail) == nil {
					t.Logf("fixture %s: %s", table, detail)
				}
			}
			rows.Close()
		}
		t.Fatalf("sealed checkpoint resume: %v\n%s", err, output)
	}
	t.Logf("sealed checkpoint resume: %s", output)
	if failureCalls != nil {
		if calls := failureCalls.Load(); calls != 1 {
			t.Fatalf("expected one failing provider POST, got %d", calls)
		}
		wantReason := "provider_outcome_unknown"
		if scenario == "reported_overrun" {
			wantReason = "usage_overrun"
		}
		var state string
		var openReservations, providerReconciliations, healthyBudgetAccounts int
		if err := pool.QueryRow(t.Context(), `
SELECT state,
    (SELECT count(*) FROM workflow_control_budget_reservations WHERE workspace_id=$1 AND run_id=$2 AND status='open'),
    (SELECT count(*) FROM workflow_control_budget_reconciliations WHERE workspace_id=$1 AND run_id=$2 AND evidence_type='provider_outcome' AND reason_code=$4),
    (SELECT count(*) FROM workflow_control_budget_accounts WHERE workspace_id=$1 AND run_id=$3)
FROM workflow_control_runs WHERE workspace_id=$1 AND run_id=$2`, workspace, failedRunID, runID, wantReason).Scan(
			&state, &openReservations, &providerReconciliations, &healthyBudgetAccounts); err != nil {
			t.Fatal(err)
		}
		if state != "reconciliation_required" || openReservations != 1 || providerReconciliations != 1 || healthyBudgetAccounts != 0 {
			t.Fatalf("unexpected isolation facts: failed state=%s, open=%d, provider outcomes=%d, healthy accounts=%d",
				state, openReservations, providerReconciliations, healthyBudgetAccounts)
		}
	}
	if scenario == "first_budget_on_resume" {
		if !expiryProbe.Load() {
			t.Fatal("the first resumed reservation did not exercise lease expiry")
		}
		if got := resumeCalls.Load(); got != 1 {
			t.Fatalf("expected one POST after approval, got %d", got)
		}
		head, err := budgetRepository.ReadAccount(t.Context(), workspace, runID)
		if err != nil {
			t.Fatal(err)
		}
		if head.Value["accountRevision"] != int64(2) || head.Value["settled"].(budgetcontract.Record)["calls"] != "1" ||
			head.Value["settled"].(budgetcontract.Record)["tokens"] != "17" {
			t.Fatalf("unexpected resumed genesis head: %v", head.Value)
		}
		reopened, err := pgxpool.NewWithConfig(t.Context(), pool.Config())
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		rebuilt, err := budgetpostgres.New(reopened).RebuildAccount(t.Context(), workspace, runID)
		if err != nil || !bytes.Equal(head.ExactBytes, rebuilt.ExactBytes) {
			t.Fatalf("resumed genesis ledger rebuild drift: %v", err)
		}
		downPath := filepath.Join(repositoryRoot, "services", "workflow-control", "migrations", "000012_bind_workflow_budget_resume_continuation.down.sql")
		down, err := os.ReadFile(downPath)
		if err != nil {
			t.Fatal(err)
		}
		conn, err := pool.Acquire(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Release()
		_, downErr := conn.Exec(t.Context(), string(down))
		if _, err := conn.Exec(t.Context(), "ROLLBACK"); err != nil {
			t.Fatal(err)
		}
		if downErr == nil || !strings.Contains(downErr.Error(), "required for ledger replay") {
			t.Fatalf("schema 12 downgrade did not protect the resumed genesis proof: %v", downErr)
		}
	}
	if scenario == "budget" {
		if !expiryProbe.Load() {
			t.Fatal("the resumed reserve did not exercise expiry while waiting on the account")
		}
		if initial, resume := initialCalls.Load(), resumeCalls.Load(); initial != 1 || resume != 1 {
			t.Fatalf("expected one POST on each loopback origin: initial=%d resume=%d", initial, resume)
		}
		var continuations int
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM workflow_control_budget_resume_continuations WHERE workspace_id=$1 AND run_id=$2`,
			workspace, runID).Scan(&continuations); err != nil || continuations != 1 {
			t.Fatalf("budget continuation: count=%d err=%v", continuations, err)
		}
		reopenedPool, err := pgxpool.NewWithConfig(t.Context(), pool.Config())
		if err != nil {
			t.Fatal(err)
		}
		defer reopenedPool.Close()
		restartedBudget := budgetpostgres.New(reopenedPool)
		rebuilt, err := restartedBudget.RebuildAccount(t.Context(), workspace, runID)
		if err != nil {
			t.Fatal(err)
		}
		settled := rebuilt.Value["settled"].(budgetcontract.Record)
		if rebuilt.Value["accountId"] != "checkpoint.fixture" || rebuilt.Value["accountRevision"] != int64(4) ||
			settled["calls"] != "2" || settled["tokens"] != "34" || settled["nanoUsd"] != "34" {
			t.Fatalf("unexpected rebuilt budget account: %v", rebuilt.Value)
		}
		pointRead, err := restartedBudget.ReadAccount(t.Context(), workspace, runID)
		if err != nil || pointRead.RecordHash != rebuilt.RecordHash || string(pointRead.ExactBytes) != string(rebuilt.ExactBytes) {
			t.Fatalf("budget account point read differs from restarted ledger rebuild: %v", err)
		}
		// A completed continuation must survive an attempted downgrade.
		down, err := os.ReadFile(filepath.Join(repositoryRoot, "services/workflow-control/migrations/000012_bind_workflow_budget_resume_continuation.down.sql"))
		if err != nil {
			t.Fatal(err)
		}
		conn, err := reopenedPool.Acquire(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Release()
		_, err = conn.Exec(t.Context(), string(down))
		if _, rollbackErr := conn.Exec(t.Context(), "ROLLBACK"); rollbackErr != nil {
			t.Fatal(rollbackErr)
		}
		if err == nil || !strings.Contains(err.Error(), "resume continuations are required") {
			t.Fatalf("downgrade must preserve the resumed ledger: %v", err)
		}
	}
}

// Exercise the exact E1 request and F2 proof from the sealed Worker. Restore
// the synthetic lease only after the expired attempt is refused without writes.
func checkExpiredResumeBudgetLease(request *http.Request, handler http.Handler, pool *pgxpool.Pool, repository *budgetpostgres.Repository, workspace string, waitOnAccount bool) error {
	ctx, cancel := context.WithTimeout(request.Context(), 10*time.Second)
	defer cancel()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return err
	}
	request.Body = io.NopCloser(bytes.NewReader(body))
	probe := request.Clone(ctx)
	probe.Body = io.NopCloser(bytes.NewReader(body))

	var leaseID, runID string
	var offerExpires, originalExpiry time.Time
	if err := pool.QueryRow(ctx, `
SELECT l.lease_id, f.run_id, l.offer_expires_at, l.lease_expires_at
FROM workflow_runner_authority_bindings f JOIN workflow_runner_leases l USING (lease_id)
WHERE f.workspace_id=$1 AND f.operation='budget_reserve' AND f.state='resolved'
AND f.accepted_resume_generation=1 AND l.state='active'`, workspace).Scan(&leaseID, &runID, &offerExpires, &originalExpiry); err != nil {
		return fmt.Errorf("find the active resumed reserve lease: %w", err)
	}
	before, err := repository.Statistics(ctx)
	if err != nil {
		return err
	}
	const runHashSQL = `SELECT record_hash FROM workflow_control_runs WHERE workspace_id=$1 AND run_id=$2`
	var runHash []byte
	if err := pool.QueryRow(ctx, runHashSQL, workspace, runID).Scan(&runHash); err != nil {
		return err
	}
	var expiry time.Time
	if err := pool.QueryRow(ctx, `
UPDATE workflow_runner_leases
SET offer_expires_at=LEAST(offer_expires_at, statement_timestamp()+interval '2 seconds'),
    lease_expires_at=statement_timestamp()+interval '2 seconds'
WHERE lease_id=$1 RETURNING lease_expires_at`, leaseID).Scan(&expiry); err != nil {
		return fmt.Errorf("shorten the isolated lease for the lock wait: %w", err)
	}
	locker, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer locker.Rollback(context.Background())
	var lockerPID int32
	var expectedQuery string
	if waitOnAccount {
		expectedQuery = "%FROM workflow_control_budget_accounts%"
		err = locker.QueryRow(ctx, `
SELECT pg_backend_pid() FROM workflow_control_budget_accounts WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE`, workspace, runID).Scan(&lockerPID)
	} else {
		expectedQuery = "%FROM workflow_runner_authority_bindings f%"
		err = locker.QueryRow(ctx, `
SELECT pg_backend_pid() FROM workflow_runner_leases WHERE lease_id=$1 FOR UPDATE`, leaseID).Scan(&lockerPID)
	}
	if err != nil {
		return err
	}
	result := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.ServeHTTP(result, probe)
	}()
	defer func() {
		cancel()
		_ = locker.Rollback(context.Background())
		<-done
	}()

	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		var blocked, expired bool
		if err := pool.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE $3
), clock_timestamp()>=$2`, lockerPID, expiry, expectedQuery).Scan(&blocked, &expired); err != nil {
			return err
		}
		if expired {
			return fmt.Errorf("resumed reserve never reached the expected lock before expiry")
		}
		if blocked {
			break
		}
		select {
		case <-done:
			return fmt.Errorf("resumed reserve finished without waiting on the expected lock: HTTP %d", result.Code)
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
	}
	if !waitOnAccount {
		// Migration 12 takes ACCESS EXCLUSIVE on accounts before changing either
		// relation. The reserve must pin this schema even before an account exists.
		downgrade, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		_, lockErr := downgrade.Exec(ctx, `LOCK TABLE workflow_control_budget_accounts IN ACCESS EXCLUSIVE MODE NOWAIT`)
		_ = downgrade.Rollback(ctx)
		var pgErr *pgconn.PgError
		if !errors.As(lockErr, &pgErr) || pgErr.Code != "55P03" {
			return fmt.Errorf("the in-flight reserve did not exclude a schema 12 downgrade: %v", lockErr)
		}
	}
	if _, err := locker.Exec(ctx, `
SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM $1::timestamptz - clock_timestamp())))`, expiry); err != nil {
		return err
	}
	if err := locker.Commit(ctx); err != nil {
		return err
	}
	select {
	case <-done:
	case <-ctx.Done():
		return ctx.Err()
	}
	if result.Code != http.StatusConflict {
		return fmt.Errorf("expired resumed reserve returned HTTP %d, want 409", result.Code)
	}
	stats, err := repository.Statistics(ctx)
	if err != nil {
		return err
	}
	if stats != before {
		return fmt.Errorf("expired resumed reserve changed budget evidence: before=%+v after=%+v", before, stats)
	}
	var finalRunHash []byte
	if err := pool.QueryRow(ctx, runHashSQL, workspace, runID).Scan(&finalRunHash); err != nil {
		return err
	}
	if !bytes.Equal(finalRunHash, runHash) {
		return fmt.Errorf("expired resumed reserve advanced the run")
	}
	_, err = pool.Exec(ctx, `
UPDATE workflow_runner_leases SET offer_expires_at=$1, lease_expires_at=$2 WHERE lease_id=$3`,
		offerExpires, originalExpiry, leaseID)
	return err
}

type checkpointFixtureLauncher struct {
	supervisor *processsupervisor.Supervisor
	t          *testing.T
}

func (l checkpointFixtureLauncher) Start(ctx context.Context) (runnerscheduler.WorkerProcess, error) {
	p, err := l.supervisor.Start(ctx)
	if err != nil {
		return nil, err
	}
	return checkpointFixtureProcess{p, l.t}, nil
}

type checkpointFixtureProcess struct {
	*processsupervisor.Process
	t *testing.T
}

func (p checkpointFixtureProcess) Wait(ctx context.Context) (processsupervisor.Result, error) {
	r, err := p.Process.Wait(ctx)
	if len(r.Stderr.Bytes) > 0 {
		p.t.Logf("sealed worker stderr: %s", r.Stderr.Bytes)
	}
	return r, err
}

// Preserve the exact protocol failure in this isolated fixture; the scheduler
// correctly keeps failed admission separate from source execution.
type checkpointFixtureSession struct {
	session *runnerscheduler.V2Session
	t       *testing.T
}

func (s checkpointFixtureSession) Run(ctx context.Context, lease runnerstore.AttemptLease) error {
	err := s.session.Run(ctx, lease)
	if err != nil {
		s.t.Logf("sealed fixture session: %v", err)
	}
	return err
}
