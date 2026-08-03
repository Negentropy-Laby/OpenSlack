package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/processsupervisor"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerscheduler"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	runnerpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/workerregistry"
)

const (
	gs8bQualificationWorkspace = "workspace.gs8b.qualification"
	gs8bQualificationBuild     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	gs8bQualificationToken     = "0123456789abcdef0123456789abcdef"
)

var errGS8BUnknownEffectOutcome = errors.New("GS8-B qualification: simulated true unknown effect outcome")

// TestGS8BQualification is deliberately environment-gated. When enabled it
// uses a real PostgreSQL schema, the externally anchored sealed worker bundle,
// and real TypeScript child processes. Its strongest claim is LOCAL_PASS.
func TestGS8BQualification(t *testing.T) {
	if os.Getenv("WORKFLOW_RUNNER_GS8B_QUALIFICATION") != "1" {
		t.Skip("GS8-B real PostgreSQL/TypeScript worker qualification is not enabled")
	}
	bundleRoot := strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS8B_BUNDLE_ROOT"))
	bundleHash := strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS8B_BUNDLE_MANIFEST_SHA256"))
	if bundleRoot == "" || bundleHash == "" {
		t.Fatal("GS8-B qualification was enabled without sealed worker bundle root and external manifest SHA-256")
	}
	if err := validateRuntimeOS(runtimeGOOS()); err != nil {
		t.Skipf("GS8-B real process qualification is unsupported on this platform: %v", err)
	}

	pool := testsupport.OpenPostgres(t)
	workspaceRoot := filepath.Clean(t.TempDir())
	descriptorRoot := filepath.Join(workspaceRoot, ".runner-descriptors")
	prepareDescriptorRoot(t, descriptorRoot)
	assertQualificationBundle(t, bundleRoot)
	registry, err := workerregistry.Load(bundleRoot, bundleHash, workerregistry.Runtime{
		WorkspaceID: gs8bQualificationWorkspace, WorkspaceRoot: workspaceRoot,
		DescriptorRoot: descriptorRoot,
	})
	if err != nil {
		t.Fatalf("load externally anchored sealed worker bundle: %v", err)
	}
	supervisor, err := registry.NewSupervisor()
	if err != nil {
		t.Fatal(err)
	}

	repository := runnerpostgres.New(pool)
	service := qualificationRunnerApp(t, repository)
	stop := startQualificationScheduler(t, repository, supervisor, "runner.qualification.normal")
	t.Cleanup(stop)

	completed := createQualificationJob(t, workspaceRoot, descriptorRoot, "completed", `
export async function run(runtime) {
  runtime.phase("Run");
  return { status: "completed", qualification: "local" };
}
`)
	first := submitQualificationJob(t, service.Handler(), completed)
	duplicate := submitQualificationJob(t, service.Handler(), completed)
	if first.Code != http.StatusCreated || duplicate.Code != first.Code || duplicate.Body.String() != first.Body.String() {
		t.Fatalf("exact submission replay drift: first=%d %q replay=%d %q", first.Code, first.Body.String(), duplicate.Code, duplicate.Body.String())
	}
	completedView := waitQualificationJob(t, repository, completed.Spec.JobID, func(view runnerstore.JobView) bool {
		return view.State == runnerstore.JobTerminal
	})
	if completedView.TerminalStatus == nil || *completedView.TerminalStatus != "completed" || completedView.ResultHash == nil {
		t.Fatalf("real TypeScript worker did not receipt-prove completion: %+v", completedView)
	}
	assertReceiptProvenProcess(t, pool, completed.Spec.JobID)

	cancellable := createQualificationJob(t, workspaceRoot, descriptorRoot, "cancel", `
export async function run(runtime) {
  runtime.phase("Run");
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    runtime.phase("Run");
  }
}
`)
	if response := submitQualificationJob(t, service.Handler(), cancellable); response.Code != http.StatusCreated {
		t.Fatalf("submit cancellable job: %d %s", response.Code, response.Body.String())
	}
	running := waitQualificationJob(t, repository, cancellable.Spec.JobID, func(view runnerstore.JobView) bool {
		return view.State == runnerstore.JobRunning && view.AttemptID != nil && view.LeaseID != nil
	})
	cancelResponse := cancelQualificationJob(t, service.Handler(), running)
	if cancelResponse.Code != http.StatusAccepted || !strings.Contains(cancelResponse.Body.String(), `"status":"accepted"`) {
		t.Fatalf("bound cancellation was not accepted: %d %s", cancelResponse.Code, cancelResponse.Body.String())
	}
	cancelled := waitQualificationJob(t, repository, cancellable.Spec.JobID, func(view runnerstore.JobView) bool {
		return view.State == runnerstore.JobTerminal
	})
	if cancelled.TerminalStatus == nil || *cancelled.TerminalStatus != "cancelled" {
		t.Fatalf("real worker cancellation was not receipt-proven: %+v", cancelled)
	}
	stop()

	var injected atomic.Bool
	ambiguousRepository := runnerpostgres.NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		var kind string
		err := tx.QueryRow(ctx, `
SELECT kind FROM workflow_runner_worker_events
WHERE xmin = pg_current_xact_id()::text::xid
LIMIT 1`).Scan(&kind)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			return err
		}
		if kind == "effect_outcome" && injected.CompareAndSwap(false, true) {
			_ = tx.Rollback(ctx)
			return errGS8BUnknownEffectOutcome
		}
		return tx.Commit(ctx)
	})
	ambiguousService := qualificationRunnerApp(t, ambiguousRepository)
	stopAmbiguous := startQualificationScheduler(t, ambiguousRepository, supervisor, "runner.qualification.ambiguous")
	t.Cleanup(stopAmbiguous)
	ambiguous := createQualificationJob(t, workspaceRoot, descriptorRoot, "effect-ambiguity", `
export async function run(runtime) {
  runtime.phase("Run");
  await runtime.openslack.task.createIssue({ title: "GS8-B local qualification" });
  return { status: "completed" };
}
`)
	if response := submitQualificationJob(t, ambiguousService.Handler(), ambiguous); response.Code != http.StatusCreated {
		t.Fatalf("submit effect ambiguity job: %d %s", response.Code, response.Body.String())
	}
	ambiguousView := waitQualificationJob(t, repository, ambiguous.Spec.JobID, func(view runnerstore.JobView) bool {
		return view.State == runnerstore.JobReconciliationRequired
	})
	if !injected.Load() || ambiguousView.ReconciliationID == nil || ambiguousView.OpenEffectCount != 1 ||
		ambiguousView.TerminalStatus == nil || *ambiguousView.TerminalStatus != "reconciliation_required" {
		t.Fatalf("executed effect ambiguity did not fail closed: injected=%v view=%+v", injected.Load(), ambiguousView)
	}
	var intentCount, reconciledOutcomeCount int
	if err := pool.QueryRow(t.Context(), `
SELECT
  count(*) FILTER (WHERE kind='effect_intent'),
  count(*) FILTER (WHERE kind='effect_outcome')
FROM workflow_runner_worker_events
WHERE workspace_id=$1 AND job_id=$2`, gs8bQualificationWorkspace, ambiguous.Spec.JobID).Scan(&intentCount, &reconciledOutcomeCount); err != nil {
		t.Fatal(err)
	}
	if intentCount != 1 || reconciledOutcomeCount != 1 {
		t.Fatalf("effect ambiguity evidence cardinality intent=%d outcome=%d", intentCount, reconciledOutcomeCount)
	}
}

// TestGS8BRestartQualification is run by the restart harness in two separate
// Go test processes with a real PostgreSQL restart between seed and verify.
func TestGS8BRestartQualification(t *testing.T) {
	phase := strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS8B_RESTART_PHASE"))
	if phase == "" {
		t.Skip("GS8-B Go/PostgreSQL restart qualification is not enabled")
	}
	schema := strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS8B_RESTART_SCHEMA"))
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		repository := runnerpostgres.New(pool)
		seedBoot, err := newBootInstanceID("runner.restart.seed", bytes.NewReader(bytes.Repeat([]byte{1}, 16)))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(t.Context(), `
CREATE TABLE gs8b_restart_qualification (
	  fixture text PRIMARY KEY,
	  postmaster_started_at timestamptz NOT NULL,
	  go_pid bigint NOT NULL,
	  boot_instance_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  lease_id text NOT NULL,
	  fence bigint NOT NULL
)`); err != nil {
			t.Fatal(err)
		}
		for _, fixture := range []string{"safe", "running", "open-effect", "pending-cancel"} {
			input := qualificationRestartJob(t, fixture)
			if _, err := repository.Submit(t.Context(), input); err != nil {
				t.Fatalf("submit restart fixture %s: %v", fixture, err)
			}
			lease, err := repository.ClaimNext(t.Context(), runnerstore.ClaimInput{WorkspaceID: input.Prepared.Spec.WorkspaceID, SupervisorInstanceID: seedBoot, LeaseOfferTimeout: 10 * time.Second, LeaseDuration: time.Hour})
			if err != nil {
				t.Fatalf("claim restart fixture %s: %v", fixture, err)
			}
			if fixture != "safe" {
				openEffects := 0
				if fixture == "open-effect" {
					openEffects = 1
				}
				if _, err := pool.Exec(t.Context(), `
UPDATE workflow_runner_attempts SET state='running',execution_started=true,open_effect_count=$1,accepted_at=offered_at,started_at=offered_at WHERE attempt_id=$2;
UPDATE workflow_runner_leases SET state='active' WHERE lease_id=$3;
UPDATE workflow_runner_jobs SET state='running' WHERE workspace_id=$4 AND job_id=$5`, openEffects, lease.AttemptID, lease.LeaseID, lease.WorkspaceID, lease.JobID); err != nil {
					t.Fatalf("seed unsafe restart fixture %s: %v", fixture, err)
				}
				if fixture == "pending-cancel" {
					now := time.Now().UTC().Truncate(time.Millisecond)
					cancelInput := runnerstore.CancelInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, CorrelationID: lease.CorrelationID, ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken, Reason: "operator", Now: now, ExpiresAt: now.Add(time.Minute)}
					cancelInput.IdempotencyKey, cancelInput.RequestFingerprint, err = runnerstore.CancelBindings(cancelInput)
					if err != nil {
						t.Fatalf("bind restart cancellation: %v", err)
					}
					if _, err := repository.RequestCancel(t.Context(), cancelInput); err != nil {
						t.Fatalf("seed pending cancellation: %v", err)
					}
				}
			}
			if _, err := pool.Exec(t.Context(), `INSERT INTO gs8b_restart_qualification (fixture,postmaster_started_at,go_pid,boot_instance_id,job_id,attempt_id,lease_id,fence) VALUES ($1,pg_postmaster_start_time(),$2,$3,$4,$5,$6,$7)`, fixture, os.Getpid(), seedBoot, lease.JobID, lease.AttemptID, lease.LeaseID, lease.FencingToken); err != nil {
				t.Fatalf("record restart fixture %s: %v", fixture, err)
			}
		}
		pool.Close()
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		repository := runnerpostgres.New(pool)
		var seededPostmaster time.Time
		var seededPID int64
		var seededBoot string
		if err := pool.QueryRow(t.Context(), `
		SELECT postmaster_started_at,go_pid,boot_instance_id
		FROM gs8b_restart_qualification WHERE fixture='safe'`).Scan(
			&seededPostmaster, &seededPID, &seededBoot,
		); err != nil {
			t.Fatal(err)
		}
		var currentPostmaster time.Time
		if err := pool.QueryRow(t.Context(), `SELECT pg_postmaster_start_time()`).Scan(&currentPostmaster); err != nil {
			t.Fatal(err)
		}
		if currentPostmaster.Equal(seededPostmaster) || seededPID == int64(os.Getpid()) {
			t.Fatalf("restart qualification requires a new PostgreSQL and Go process: postgres seed=%s current=%s go seed=%d current=%d", seededPostmaster, currentPostmaster, seededPID, os.Getpid())
		}
		verifyBoot, err := newBootInstanceID("runner.restart.verify", bytes.NewReader(bytes.Repeat([]byte{2}, 16)))
		if err != nil || verifyBoot == seededBoot {
			t.Fatalf("new boot identity: %q err=%v", verifyBoot, err)
		}
		recovered, err := repository.RecoverOrphans(t.Context(), verifyBoot, time.Now(), 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(recovered) != 4 {
			t.Fatalf("restart recovery cardinality=%d values=%+v", len(recovered), recovered)
		}
		byFixture := map[string]runnerstore.RecoveryResult{}
		rows, err := pool.Query(t.Context(), `SELECT fixture,job_id FROM gs8b_restart_qualification`)
		if err != nil {
			t.Fatal(err)
		}
		jobFixtures := map[string]string{}
		for rows.Next() {
			var fixture, id string
			if err := rows.Scan(&fixture, &id); err != nil {
				t.Fatal(err)
			}
			jobFixtures[id] = fixture
		}
		rows.Close()
		for _, value := range recovered {
			byFixture[jobFixtures[value.JobID]] = value
		}
		if value := byFixture["safe"]; !value.SafeForNewAttempt || value.State != runnerstore.JobQueued {
			t.Fatalf("unstarted orphan was not safely backoff-queued: %+v", value)
		}
		if value := byFixture["running"]; value.SafeForNewAttempt || value.State != runnerstore.JobTerminal {
			t.Fatalf("running orphan was replayed instead of failed closed: %+v", value)
		}
		if value := byFixture["open-effect"]; value.SafeForNewAttempt || value.State != runnerstore.JobReconciliationRequired {
			t.Fatalf("open-effect orphan did not require reconciliation: %+v", value)
		}
		if value := byFixture["pending-cancel"]; value.SafeForNewAttempt || value.State != runnerstore.JobTerminal {
			t.Fatalf("pending-cancel orphan did not settle terminal: %+v", value)
		}
		time.Sleep(runnerstore.MinDispatchBackoff + 100*time.Millisecond)
		newLease, err := repository.ClaimNext(t.Context(), runnerstore.ClaimInput{
			WorkspaceID: gs8bQualificationWorkspace, SupervisorInstanceID: verifyBoot,
			LeaseOfferTimeout: 10 * time.Second, LeaseDuration: time.Hour,
		})
		if err != nil {
			t.Fatal(err)
		}
		var safeJobID, safeAttemptID string
		var safeFence int64
		if err := pool.QueryRow(t.Context(), `SELECT job_id,attempt_id,fence FROM gs8b_restart_qualification WHERE fixture='safe'`).Scan(&safeJobID, &safeAttemptID, &safeFence); err != nil {
			t.Fatal(err)
		}
		if newLease.JobID != safeJobID || newLease.AttemptID == safeAttemptID || newLease.FencingToken != safeFence+1 {
			t.Fatalf("post-restart durable fence recovery drift: old=%s/%d new=%+v", safeAttemptID, safeFence, newLease)
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown GS8-B restart phase %q", phase)
	}
}

// TestGS8BImageDefaultOff verifies the default image origin remains the GS7-B
// shadow service and does not expose the explicitly enabled runner surface.
func TestGS8BImageDefaultOff(t *testing.T) {
	origin := strings.TrimRight(strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS8B_DEFAULT_ORIGIN")), "/")
	if origin == "" {
		t.Skip("GS8-B default image origin is not configured")
	}
	version := qualificationOriginRequest(t, http.MethodGet, origin+"/health/version", nil)
	runnerRoute := qualificationOriginRequest(t, http.MethodPost, origin+runnerapp.RouteJobs, []byte(`{}`))
	if version.status != http.StatusOK || !strings.Contains(string(version.body), `"mode":"shadow-only"`) ||
		strings.Contains(string(version.body), "runner-control-explicit") || runnerRoute.status != http.StatusNotFound {
		t.Fatalf("default image runner gate drift: version=%d %s runner=%d %s", version.status, version.body, runnerRoute.status, runnerRoute.body)
	}
}

type qualificationPreparedJob struct {
	runnerstore.SubmitInput
	Spec runnerstore.JobSpec
}

func qualificationRunnerApp(t *testing.T, store runnerstore.Store) *runnerapp.Service {
	t.Helper()
	tokenHash := sha256.Sum256([]byte(gs8bQualificationToken))
	service, err := runnerapp.New(runnerapp.Options{
		Store: store, BuildSHA: gs8bQualificationBuild,
		WorkspaceID: gs8bQualificationWorkspace, BearerTokenSHA256: hex.EncodeToString(tokenHash[:]),
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func startQualificationScheduler(t *testing.T, store runnerscheduler.SessionStore, supervisor *processsupervisor.Supervisor, prefix string) func() {
	t.Helper()
	bootID, err := newBootInstanceID(prefix, bytes.NewReader(bytes.Repeat([]byte{byte(len(prefix))}, 16)))
	if err != nil {
		t.Fatal(err)
	}
	session, err := runnerscheduler.NewSession(runnerscheduler.SessionConfig{
		Store: store, Launcher: runnerscheduler.SealedLauncher{Supervisor: supervisor},
		ControlBuildHash: gs8bQualificationBuild, HeartbeatInterval: 250 * time.Millisecond,
		LeaseOfferTimeout: 5 * time.Second, CancelWindow: 30 * time.Second,
		CancelGrace: 2 * time.Second, TerminalExitGrace: 2 * time.Second, PollInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := runnerscheduler.New(runnerscheduler.Config{
		Store: store, Session: session, WorkspaceID: gs8bQualificationWorkspace,
		SupervisorInstanceID: bootID, MaxProcesses: 1,
		LeaseOfferTimeout: 5 * time.Second, LeaseDuration: 30 * time.Second,
		PollInterval: 20 * time.Millisecond, RecoveryInterval: 500 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- scheduler.Run(ctx) }()
	var stopped atomic.Bool
	return func() {
		if !stopped.CompareAndSwap(false, true) {
			return
		}
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("qualification scheduler stopped with error: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Errorf("qualification scheduler did not stop")
		}
	}
}

func createQualificationJob(t *testing.T, workspaceRoot, descriptorRoot, suffix, runBody string) qualificationPreparedJob {
	t.Helper()
	workflowID := "gs8b-" + suffix
	runID := "run.gs8b." + suffix
	jobID := "job.gs8b." + suffix
	correlationID := "correlation.gs8b." + suffix
	descriptorRef := "descriptor.gs8b." + suffix
	manifest := canonicaljson.Object{
		"name": workflowID, "version": "1.0.0", "description": "GS8-B LOCAL_PASS qualification fixture.",
		"phases": canonicaljson.Array{canonicaljson.Object{"title": "Run", "detail": "Run qualification fixture."}},
		"risk":   "low",
	}
	manifestBytes, err := canonicaljson.Encode(manifest)
	if err != nil {
		t.Fatal(err)
	}
	source := []byte("export const meta = " + string(manifestBytes) + ";\n" + strings.TrimSpace(runBody) + "\n")
	workflowDirectory := filepath.Join(workspaceRoot, ".openslack", "workflows")
	if err := os.MkdirAll(workflowDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workflowDirectory, workflowID+".mjs"), source, 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	input := canonicaljson.Object{}
	inputBytes, _ := canonicaljson.Encode(input)
	descriptor := canonicaljson.Object{
		"schema":        "openslack.workflow_runner_execution_descriptor.v1",
		"descriptorRef": descriptorRef, "workspaceId": gs8bQualificationWorkspace,
		"workflowRunId": runID, "correlationId": correlationID,
		"workflowId": workflowID, "workflowVersion": "1.0.0", "workflowSource": "openslack-project",
		"workflowSourceHash": qualificationDomainHash("workflow-source", source),
		"manifestHash":       qualificationDomainHash("workflow-manifest", manifestBytes),
		"inputHash":          qualificationDomainHash("workflow-input", inputBytes), "input": input,
		"budget": canonicaljson.Object{"tokens": 1000, "costUsd": 1},
		"confirmationPolicy": canonicaljson.Object{
			"mode": "unattended-explicit", "actorId": "actor.gs8b.qualification", "runId": runID,
			"allowUnattended": true, "onUnexpectedEffect": "fail",
		},
		"createdAt": runnerstore.CanonicalTimestamp(now.Add(-time.Second)),
		"expiresAt": runnerstore.CanonicalTimestamp(now.Add(10 * time.Minute)),
	}
	descriptorBytes, err := canonicaljson.Encode(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	descriptorHash := qualificationDomainHash("execution-descriptor", descriptorBytes)
	filenameHash := sha256.Sum256([]byte(descriptorRef))
	descriptorPath := filepath.Join(descriptorRoot, "descriptors", hex.EncodeToString(filenameHash[:])+".json")
	if err := os.WriteFile(descriptorPath, append(descriptorBytes, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(descriptorPath, 0o600); err != nil {
		t.Fatal(err)
	}
	spec := runnerstore.JobSpec{
		Schema: runnerstore.JobSpecSchema, WorkspaceID: gs8bQualificationWorkspace,
		JobID: jobID, WorkflowRunID: runID, CorrelationID: correlationID,
		ExecutionDescriptorRef: descriptorRef, ExecutionDescriptorHash: descriptorHash,
		WorkflowID: workflowID, WorkflowVersion: "1.0.0",
		WorkflowSourceHash: qualificationDomainHash("workflow-source", source),
		ManifestHash:       qualificationDomainHash("workflow-manifest", manifestBytes),
		InputHash:          qualificationDomainHash("workflow-input", inputBytes),
		WholeTimeoutMS:     int64((2 * time.Minute) / time.Millisecond), SubmittedAt: runnerstore.CanonicalTimestamp(now),
	}
	prepared, err := runnerstore.PrepareJobSpec(spec)
	if err != nil {
		t.Fatal(err)
	}
	key, fingerprint := runnerstore.SubmissionBindings(prepared)
	return qualificationPreparedJob{SubmitInput: runnerstore.SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint}, Spec: spec}
}

func prepareDescriptorRoot(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "descriptors"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{root, filepath.Join(root, "descriptors")} {
		if err := os.Chmod(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
}

func assertQualificationBundle(t *testing.T, root string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(root, workerregistry.ManifestFilename))
	if err != nil {
		t.Fatalf("read qualification bundle manifest: %v", err)
	}
	var manifest workerregistry.Manifest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		t.Fatalf("decode qualification bundle manifest: %v", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("qualification bundle manifest has trailing data: %v", err)
	}
	if manifest.Schema != workerregistry.ManifestSchema || filepath.ToSlash(manifest.Entrypoint.RelativePath) != "workflow-runner-worker.js" || manifest.EntrypointMode != "first-argument" {
		t.Fatalf("qualification must execute the built TypeScript worker entrypoint: schema=%q entrypoint=%q", manifest.Schema, manifest.Entrypoint.RelativePath)
	}
	entrypoint, err := os.ReadFile(filepath.Join(root, "workflow-runner-worker.js"))
	if err != nil {
		t.Fatalf("read self-contained qualification worker: %v", err)
	}
	digest := sha256.Sum256(entrypoint)
	if actual := hex.EncodeToString(digest[:]); manifest.RunnerBuildHash != actual || manifest.Entrypoint.SHA256 != actual {
		t.Fatalf("qualification runnerBuildHash must equal self-contained entrypoint SHA-256: runner=%q artifact=%q actual=%q", manifest.RunnerBuildHash, manifest.Entrypoint.SHA256, actual)
	}
}

func qualificationDomainHash(domain string, body []byte) string {
	hasher := sha256.New()
	_, _ = io.WriteString(hasher, "openslack.workflow-runner."+domain+".v1\x00")
	_, _ = hasher.Write(body)
	return hex.EncodeToString(hasher.Sum(nil))
}

func submitQualificationJob(t *testing.T, handler http.Handler, input qualificationPreparedJob) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, runnerapp.RouteJobs, bytes.NewReader(input.Prepared.ExactBody))
	request.Header.Set("Authorization", "Bearer "+gs8bQualificationToken)
	request.Header.Set(runnerapp.HeaderWorkspaceID, gs8bQualificationWorkspace)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", input.IdempotencyKey)
	request.Header.Set(runnerapp.HeaderRequestFingerprint, input.RequestFingerprint)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func cancelQualificationJob(t *testing.T, handler http.Handler, view runnerstore.JobView) *httptest.ResponseRecorder {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	input := runnerstore.CancelInput{
		WorkspaceID: view.WorkspaceID, JobID: view.JobID, CorrelationID: view.CorrelationID,
		ExpectedAttemptID: *view.AttemptID, ExpectedLeaseID: *view.LeaseID,
		ExpectedFence: view.FencingToken, Reason: "operator", Now: now, ExpiresAt: now.Add(30 * time.Second),
	}
	key, fingerprint, err := runnerstore.CancelBindings(input)
	if err != nil {
		t.Fatal(err)
	}
	body, err := canonicaljson.Encode(canonicaljson.Object{
		"schema": "openslack.workflow_runner_cancel_request.v1", "correlationId": input.CorrelationID,
		"expectedAttemptId": input.ExpectedAttemptID, "expectedLeaseId": input.ExpectedLeaseID,
		"expectedFence": input.ExpectedFence, "reason": input.Reason,
		"requestedAt": runnerstore.CanonicalTimestamp(input.Now), "expiresAt": runnerstore.CanonicalTimestamp(input.ExpiresAt),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/runner/jobs/"+view.JobID+"/cancellations", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+gs8bQualificationToken)
	request.Header.Set(runnerapp.HeaderWorkspaceID, gs8bQualificationWorkspace)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	request.Header.Set(runnerapp.HeaderRequestFingerprint, fingerprint)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func waitQualificationJob(t *testing.T, store runnerstore.Store, jobID string, predicate func(runnerstore.JobView) bool) runnerstore.JobView {
	t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	var last runnerstore.JobView
	var lastErr error
	for time.Now().Before(deadline) {
		last, lastErr = store.ReadJob(t.Context(), gs8bQualificationWorkspace, jobID)
		if lastErr == nil && predicate(last) {
			return last
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("runner job %s did not reach qualification state: view=%+v err=%v", jobID, last, lastErr)
	return runnerstore.JobView{}
}

func assertReceiptProvenProcess(t *testing.T, pool qualificationPool, jobID string) {
	t.Helper()
	var sessions, events, receipts, terminals int
	if err := pool.QueryRow(t.Context(), `
SELECT
  count(DISTINCT s.process_session_id),
  count(DISTINCT e.event_id),
  count(DISTINCT r.receipt_event_id),
  count(DISTINCT e.event_id) FILTER (WHERE e.kind='terminal')
FROM workflow_runner_jobs j
JOIN workflow_runner_attempts a ON a.attempt_id=j.current_attempt_id
JOIN workflow_runner_process_sessions s ON s.attempt_id=a.attempt_id
JOIN workflow_runner_worker_events e ON e.attempt_id=a.attempt_id
JOIN workflow_runner_event_receipts r ON r.received_event_id=e.event_id
WHERE j.workspace_id=$1 AND j.job_id=$2`, gs8bQualificationWorkspace, jobID).Scan(&sessions, &events, &receipts, &terminals); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 || events < 2 || receipts != events || terminals != 1 {
		t.Fatalf("receipt-proven process evidence sessions=%d events=%d receipts=%d terminals=%d", sessions, events, receipts, terminals)
	}
}

type qualificationPool interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func qualificationRestartJob(t *testing.T, suffix string) runnerstore.SubmitInput {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	spec := runnerstore.JobSpec{
		Schema: runnerstore.JobSpecSchema, WorkspaceID: gs8bQualificationWorkspace,
		JobID: "job.gs8b.restart." + suffix, WorkflowRunID: "run.gs8b.restart." + suffix, CorrelationID: "correlation.gs8b.restart." + suffix,
		ExecutionDescriptorRef: "descriptor.gs8b.restart." + suffix, ExecutionDescriptorHash: strings.Repeat("1", 64),
		WorkflowID: "gs8b-restart", WorkflowVersion: "1.0.0", WorkflowSourceHash: strings.Repeat("2", 64),
		ManifestHash: strings.Repeat("3", 64), InputHash: strings.Repeat("4", 64),
		WholeTimeoutMS: int64((24 * time.Hour) / time.Millisecond), SubmittedAt: runnerstore.CanonicalTimestamp(now),
	}
	prepared, err := runnerstore.PrepareJobSpec(spec)
	if err != nil {
		t.Fatal(err)
	}
	key, fingerprint := runnerstore.SubmissionBindings(prepared)
	return runnerstore.SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint}
}

type qualificationOriginResponse struct {
	status int
	body   []byte
}

func qualificationOriginRequest(t *testing.T, method, url string, body []byte) qualificationOriginResponse {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	return qualificationOriginResponse{status: response.StatusCode, body: responseBody}
}

func runtimeGOOS() string {
	return runtime.GOOS
}
