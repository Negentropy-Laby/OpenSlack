package postgres

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

const gs9f2MixedRecoveryWorkspace = "workspace.gs9f2.mixed-recovery"

// Process identity is stable within one test binary and distinct across restarts,
// including containers that reuse the same PID.
var gs9f2RecoveryProcessIdentity = sync.OnceValues(func() (string, error) {
	return randomToken("process")
})

func TestGS9F2RecoveryProcessIdentityIsStable(t *testing.T) {
	first, err := gs9f2RecoveryProcessIdentity()
	if err != nil {
		t.Fatal(err)
	}
	second, err := gs9f2RecoveryProcessIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if first == "" || first != second {
		t.Fatal("recovery process identity is not stable")
	}
}

// The current runtime-delivery gate invokes seed and verify in separate Go
// processes with a real PostgreSQL restart between them. No retired server is used.
func TestGS9F2MixedOrphanRestartRecovery(t *testing.T) {
	requireGS9F2(t)
	phase := strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS9F2_MIXED_RESTART_PHASE"))
	if phase == "" {
		t.Skip("GS9-F2 mixed-orphan Go/PostgreSQL restart qualification is not enabled")
	}
	schema := strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS9F2_MIXED_RESTART_SCHEMA"))
	processIdentity, err := gs9f2RecoveryProcessIdentity()
	if err != nil {
		t.Fatalf("create qualification process identity: %v", err)
	}
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		repository := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
		seedBoot := "supervisor." + processIdentity
		if _, err := pool.Exec(t.Context(), `
CREATE TABLE gs9f2_mixed_restart_qualification (
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
			input := v2JobInputForWorkspace(t, "mixed-"+fixture, gs9f2MixedRecoveryWorkspace, "go", "workflow-control")
			if _, err := repository.SubmitV2(t.Context(), input); err != nil {
				t.Fatalf("submit restart fixture %s: %v", fixture, err)
			}
			lease, err := repository.ClaimNext(t.Context(), runnerstore.ClaimInput{ProtocolVersions: []string{authoritycontract.ProtocolVersion}, WorkspaceID: input.Prepared.Spec.WorkspaceID, SupervisorInstanceID: seedBoot, LeaseOfferTimeout: 10 * time.Second, LeaseDuration: time.Hour})
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
			if _, err := pool.Exec(t.Context(), `INSERT INTO gs9f2_mixed_restart_qualification (fixture,postmaster_started_at,go_process_identity,boot_instance_id,job_id,attempt_id,lease_id,fence) VALUES ($1,pg_postmaster_start_time(),$2,$3,$4,$5,$6,$7)`, fixture, processIdentity, seedBoot, lease.JobID, lease.AttemptID, lease.LeaseID, lease.FencingToken); err != nil {
				t.Fatalf("record restart fixture %s: %v", fixture, err)
			}
		}
		pool.Close()
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		repository := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
		var seededPostmaster time.Time
		var seededProcessIdentity string
		var seededBoot string
		if err := pool.QueryRow(t.Context(), `
		SELECT postmaster_started_at,go_process_identity,boot_instance_id
		FROM gs9f2_mixed_restart_qualification WHERE fixture='safe'`).Scan(
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
		verifyBoot := "supervisor." + processIdentity
		if verifyBoot == seededBoot {
			t.Fatal("restart reused the seeded supervisor identity")
		}
		recovered, err := repository.RecoverOrphans(t.Context(), verifyBoot, time.Now(), 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(recovered) != 4 {
			t.Fatalf("restart recovery cardinality=%d values=%+v", len(recovered), recovered)
		}
		byFixture := map[string]runnerstore.RecoveryResult{}
		rows, err := pool.Query(t.Context(), `SELECT fixture,job_id FROM gs9f2_mixed_restart_qualification`)
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
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
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
		newLease, err := repository.ClaimNext(t.Context(), runnerstore.ClaimInput{ProtocolVersions: []string{authoritycontract.ProtocolVersion},
			WorkspaceID: gs9f2MixedRecoveryWorkspace, SupervisorInstanceID: verifyBoot,
			LeaseOfferTimeout: 10 * time.Second, LeaseDuration: time.Hour,
		})
		if err != nil {
			t.Fatal(err)
		}
		var safeJobID, safeAttemptID, safeLeaseID string
		var safeFence int64
		if err := pool.QueryRow(t.Context(), `SELECT job_id,attempt_id,lease_id,fence FROM gs9f2_mixed_restart_qualification WHERE fixture='safe'`).Scan(&safeJobID, &safeAttemptID, &safeLeaseID, &safeFence); err != nil {
			t.Fatal(err)
		}
		if newLease.JobID != safeJobID || newLease.AttemptID == safeAttemptID || newLease.LeaseID == safeLeaseID || newLease.FencingToken != safeFence+1 {
			t.Fatalf("post-restart durable fence recovery drift: old=%s/%d new=%+v", safeAttemptID, safeFence, newLease)
		}
		for _, fixture := range []string{"running", "open-effect", "pending-cancel"} {
			view, err := repository.ReadJob(t.Context(), gs9f2MixedRecoveryWorkspace, byFixture[fixture].JobID)
			if err != nil {
				t.Fatal(err)
			}
			want := "failed"
			if fixture == "pending-cancel" {
				want = "cancelled"
			}
			if fixture == "open-effect" {
				want = "reconciliation_required"
				if view.ReconciliationID == nil {
					t.Fatal("open-effect recovery omitted reconciliation evidence")
				}
			}
			if view.TerminalStatus == nil || string(*view.TerminalStatus) != want {
				t.Fatalf("%s terminal disposition = %+v, want %s", fixture, view, want)
			}
		}
		if _, err := repository.ClaimNext(t.Context(), runnerstore.ClaimInput{
			ProtocolVersions: []string{authoritycontract.ProtocolVersion},
			WorkspaceID:      gs9f2MixedRecoveryWorkspace, SupervisorInstanceID: verifyBoot,
			LeaseOfferTimeout: 10 * time.Second, LeaseDuration: time.Hour,
		}); !runnerstore.IsCode(err, runnerstore.ErrorNoWork) {
			t.Fatalf("unsafe orphan became dispatchable: %v", err)
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown GS9-F2 mixed-orphan restart phase %q", phase)
	}
}
