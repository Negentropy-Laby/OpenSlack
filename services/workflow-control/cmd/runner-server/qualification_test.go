package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	runnerpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

const (
	gs8bQualificationWorkspace = "workspace.gs8b.qualification"
	gs8bQualificationBuild     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	gs8bQualificationToken     = "0123456789abcdef0123456789abcdef"
)

var (
	gs8bQualificationProcess struct {
		sync.Once
		identity string
		err      error
	}
)

func gs8bQualificationProcessIdentity() (string, error) {
	gs8bQualificationProcess.Do(func() {
		gs8bQualificationProcess.identity, gs8bQualificationProcess.err = newBootInstanceID(
			"runner.restart.process",
			rand.Reader,
		)
	})
	return gs8bQualificationProcess.identity, gs8bQualificationProcess.err
}

func TestGS8BQualificationProcessIdentityIsStableWithinOneProcess(t *testing.T) {
	first, err := gs8bQualificationProcessIdentity()
	if err != nil {
		t.Fatal(err)
	}
	second, err := gs8bQualificationProcessIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if first == "" || first != second {
		t.Fatalf("qualification process identity is not process-stable: first=%q second=%q", first, second)
	}
}

// TestGS8BQualification is deliberately environment-gated. After GS9-H it
// proves that the authenticated legacy admission surface is retired without a
// PostgreSQL mutation. Durable recovery remains qualified independently below.
func TestGS8BQualification(t *testing.T) {
	if os.Getenv("WORKFLOW_RUNNER_GS8B_QUALIFICATION") != "1" {
		t.Skip("GS8-B retired-admission PostgreSQL qualification is not enabled")
	}

	pool := testsupport.OpenPostgres(t)
	workspaceRoot := filepath.Clean(t.TempDir())
	descriptorRoot := filepath.Join(workspaceRoot, ".runner-descriptors")
	prepareDescriptorRoot(t, descriptorRoot)
	repository := runnerpostgres.New(pool)
	service := qualificationRunnerApp(t, repository)
	job := createQualificationJob(t, workspaceRoot, descriptorRoot, "retired-admission", `
export async function run() {
  throw new Error("retired TypeScript worker must never start");
}
`)

	unauthorizedRequest := httptest.NewRequest(
		http.MethodPost,
		runnerapp.RouteJobs,
		bytes.NewReader(job.Prepared.ExactBody),
	)
	unauthorizedResponse := httptest.NewRecorder()
	service.Handler().ServeHTTP(unauthorizedResponse, unauthorizedRequest)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("retired admission bypassed identity: %d %s", unauthorizedResponse.Code, unauthorizedResponse.Body.String())
	}

	first := submitQualificationJob(t, service.Handler(), job)
	replay := submitQualificationJob(t, service.Handler(), job)
	if first.Code != http.StatusGone || replay.Code != first.Code || replay.Body.String() != first.Body.String() ||
		!strings.Contains(first.Body.String(), "WORKFLOW_RUNNER_TS_MUTATION_RETIRED") {
		t.Fatalf("retired admission response drift: first=%d %q replay=%d %q", first.Code, first.Body.String(), replay.Code, replay.Body.String())
	}
	var jobs int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM workflow_runner_jobs WHERE workspace_id=$1`, gs8bQualificationWorkspace).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 0 {
		t.Fatalf("retired admission persisted %d legacy runner jobs", jobs)
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
	processIdentity, err := gs8bQualificationProcessIdentity()
	if err != nil {
		t.Fatalf("create qualification process identity: %v", err)
	}
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
	  go_process_identity text NOT NULL,
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
			if _, err := pool.Exec(t.Context(), `INSERT INTO gs8b_restart_qualification (fixture,postmaster_started_at,go_process_identity,boot_instance_id,job_id,attempt_id,lease_id,fence) VALUES ($1,pg_postmaster_start_time(),$2,$3,$4,$5,$6,$7)`, fixture, processIdentity, seedBoot, lease.JobID, lease.AttemptID, lease.LeaseID, lease.FencingToken); err != nil {
				t.Fatalf("record restart fixture %s: %v", fixture, err)
			}
		}
		pool.Close()
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		repository := runnerpostgres.New(pool)
		var seededPostmaster time.Time
		var seededProcessIdentity string
		var seededBoot string
		if err := pool.QueryRow(t.Context(), `
		SELECT postmaster_started_at,go_process_identity,boot_instance_id
		FROM gs8b_restart_qualification WHERE fixture='safe'`).Scan(
			&seededPostmaster, &seededProcessIdentity, &seededBoot,
		); err != nil {
			t.Fatal(err)
		}
		var currentPostmaster time.Time
		if err := pool.QueryRow(t.Context(), `SELECT pg_postmaster_start_time()`).Scan(&currentPostmaster); err != nil {
			t.Fatal(err)
		}
		if currentPostmaster.Equal(seededPostmaster) || seededProcessIdentity == processIdentity {
			t.Fatalf("restart qualification requires a new PostgreSQL and Go process: postgres seed=%s current=%s go seed=%q current=%q", seededPostmaster, currentPostmaster, seededProcessIdentity, processIdentity)
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
