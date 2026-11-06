//go:build sealed_worker_integration

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

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
// The workflow has one fixture-human D2 audit decision and no provider request.
func TestGS9F2SealedCheckpointResume(t *testing.T) {
	if strings.TrimSpace(os.Getenv("DATABASE_URL")) == "" {
		t.Fatal("sealed checkpoint qualification requires DATABASE_URL")
	}
	pool := testsupport.OpenPostgres(t)
	version := databaseready.CurrentSchemaVersion
	if _, err := pool.Exec(t.Context(), "CREATE TABLE schema_migrations(version BIGINT PRIMARY KEY,dirty BOOLEAN NOT NULL); INSERT INTO schema_migrations VALUES($1,false)", version); err != nil {
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
	budget, err := budgetapp.New(budgetapp.Options{Repository: budgetpostgres.New(pool), QualificationMode: true, BuildSHA: authorityBuild,
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
