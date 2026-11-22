//go:build sealed_worker_integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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
// Each scenario uses one fixture-human audit decision. The budget variant confines
// provider requests to the local stub.
func TestGS9F2SealedCheckpointResume(t *testing.T) {
	t.Run("checkpoint", func(t *testing.T) { testGS9F2SealedCheckpointResume(t, false) })
	t.Run("budget", func(t *testing.T) { testGS9F2SealedCheckpointResume(t, true) })
}

func testGS9F2SealedCheckpointResume(t *testing.T, withBudget bool) {
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
	budgetHTTP := httptest.NewServer(budget.Handler())
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
	const runID = "run.checkpoint.worker"
	var providerCalls atomic.Int32
	if withBudget {
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
			call := providerCalls.Add(1)
			phase, reserved, settled := "First", "1", "0"
			if call == 2 {
				phase, reserved, settled = "Done", "2", "1"
			}
			account, err := budgetRepository.ReadAccount(req.Context(), workspace, runID)
			if call > 2 || body.Messages[1].Content != "Budget fixture "+phase ||
				err != nil || account.Value["accountId"] != "checkpoint.fixture" ||
				account.Value["reserved"].(budgetcontract.Record)["calls"] != reserved ||
				account.Value["settled"].(budgetcontract.Record)["calls"] != settled {
				t.Errorf("loopback call %d has no matching budget reservation: %v", call, err)
				http.Error(w, "fixture reservation mismatch", http.StatusBadRequest)
				return
			}
			if err := json.NewEncoder(w).Encode(map[string]any{
				"choices": []any{map[string]any{"message": map[string]any{"content": "{\"phase\":\"" + phase + "\"}"}}},
				"usage":   map[string]int{"prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17},
			}); err != nil {
				t.Error(err)
			}
		}))
		defer provider.Close()
		driverConfig["localProviderOrigin"] = provider.URL
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
	if withBudget {
		if calls := providerCalls.Load(); calls != 2 {
			t.Fatalf("expected one local provider call in each generation, got %d", calls)
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
