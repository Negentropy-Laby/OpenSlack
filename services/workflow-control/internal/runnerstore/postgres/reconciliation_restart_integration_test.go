package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	authoritypostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/storageproof"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

// Seed and verify run in separate Go processes around a real PostgreSQL restart.
// Both fixtures begin at schema 9, then apply migration 10 without rewriting any
// original stage, resolution, receipt, event or ACK bytes.
func TestBindingReconciliationUpgradeRestart(t *testing.T) {
	requireGS9F2(t)
	phase := os.Getenv("WORKFLOW_RUNNER_RECONCILIATION_RESTART_PHASE")
	if phase == "" {
		t.Skip("explicit reconciliation PostgreSQL restart qualification is not enabled")
	}
	if phase != "seed" && phase != "verify" {
		t.Fatal("invalid reconciliation restart phase")
	}
	base := os.Getenv("WORKFLOW_RUNNER_RECONCILIATION_RESTART_SCHEMA")
	process, err := gs9f2RecoveryProcessIdentity()
	if err != nil {
		t.Fatal(err)
	}
	for _, outcome := range []string{"committed", "not_committed"} {
		t.Run(outcome, func(t *testing.T) {
			schema := base + "_" + outcome
			pool := testsupport.OpenPersistentSchema(t, schema, phase == "seed")
			ctx := context.Background()
			source := authoritypostgres.New(pool, 10)
			repo := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{}).WithReconciliationWriter(func(ctx context.Context, c storageproof.Challenge, _ int64) (storageproof.Answer, error) {
				return source.ProveStorage(ctx, c)
			}, "recovery-test")
			if phase == "seed" {
				down, err := os.ReadFile(v2MigrationPath(t, "000010_reconcile_workflow_runner_bindings.down.sql"))
				if err != nil {
					t.Fatal(err)
				}
				if _, err = pool.Exec(ctx, string(down)); err != nil {
					t.Fatal(err)
				}
				_, writer, v, record := reconciliationFixtureInPool(t, pool, 9, runnerbindingcontract.OperationResumeAdvance, "staged")
				stage, _ := runnerbindingcontract.ParseStageBytes(v.ExactStageBytes)
				hash, _ := runnerbindingcontract.HashStage(stage)
				if outcome == "committed" {
					if _, err = writer.Mutate(ctx, reconciliationMutation(t, record, "resuming", 1, "resume."+hash)); err != nil {
						t.Fatal(err)
					}
				}
				expireReconciliationLease(t, pool, v)
				up, err := os.ReadFile(v2MigrationPath(t, "000010_reconcile_workflow_runner_bindings.up.sql"))
				if err != nil {
					t.Fatal(err)
				}
				if _, err = pool.Exec(ctx, string(up)+"\nUPDATE schema_migrations SET version=10;"); err != nil {
					t.Fatal(err)
				}
				original, err := scanAuthorityBindingView(pool.QueryRow(ctx, `SELECT `+authorityBindingViewColumns+` FROM workflow_runner_authority_bindings WHERE binding_id=$1`, v.BindingID))
				if err != nil || !bytes.Equal(original.ExactStageBytes, v.ExactStageBytes) || !bytes.Equal(original.ExactStageReceipt, v.ExactStageReceipt) || len(original.ExactResolutionBytes) != 0 {
					t.Fatal("upgrade changed original evidence", err)
				}
				request := reconciliationRequest(t, v, outcome)
				receipt, err := repo.ApplyBindingReconciliation(ctx, request)
				if err != nil {
					t.Fatal(err)
				}
				var pause []byte
				if outcome == "committed" {
					head, err := source.Read(ctx, v.WorkspaceID, v.RunID)
					if err != nil {
						t.Fatal(err)
					}
					pause, err = repo.PauseReconciledRun(ctx, runnerstore.RecoveryPauseRequest{Schema: "openslack.workflow_runner_recovery_pause.v1", WorkspaceID: v.WorkspaceID, RunID: v.RunID, ExpectedRevision: head.Revision, ExpectedRecordHash: head.RecordHash})
					if err != nil {
						t.Fatal(err)
					}
				}
				if _, err = pool.Exec(ctx, `CREATE TABLE reconciliation_restart_evidence(started_at timestamptz,process text,request bytea,receipt bytea,stage bytea,stage_receipt bytea,pause bytea);
INSERT INTO reconciliation_restart_evidence VALUES(pg_postmaster_start_time(),$1,$2,$3,$4,$5,$6)`, process, request.ExactBytes, receipt, v.ExactStageBytes, v.ExactStageReceipt, pause); err != nil {
					t.Fatal(err)
				}
				return
			}
			defer testsupport.DropSchema(t, schema)
			var started, now time.Time
			var previous string
			var request, receipt, stageBytes, stageReceipt, pause []byte
			if err = pool.QueryRow(ctx, `SELECT started_at,process,request,receipt,stage,stage_receipt,pause,pg_postmaster_start_time() FROM reconciliation_restart_evidence`).Scan(&started, &previous, &request, &receipt, &stageBytes, &stageReceipt, &pause, &now); err != nil {
				t.Fatal(err)
			}
			if started.Equal(now) || previous == process {
				t.Fatal("verification requires both PostgreSQL and Go process restart")
			}
			prepared, err := runnerstore.ParseBindingReconciliation(request)
			if err != nil {
				t.Fatal(err)
			}
			replay, err := repo.ApplyBindingReconciliation(ctx, prepared)
			if err != nil || !bytes.Equal(replay, receipt) {
				t.Fatal("restart changed exact settlement", err)
			}
			point, err := repo.ReadBindingSettlementReceipt(ctx, prepared.Value.WorkspaceID, prepared.Value.RunID, prepared.IdempotencyKey)
			if err != nil || !bytes.Equal(point, receipt) {
				t.Fatal("restart receipt lookup differs", err)
			}
			var exactStage, exactReceipt []byte
			if err = pool.QueryRow(ctx, `SELECT exact_stage_bytes,exact_stage_receipt_bytes FROM workflow_runner_authority_bindings WHERE binding_id=$1`, prepared.Value.BindingID).Scan(&exactStage, &exactReceipt); err != nil || !bytes.Equal(stageBytes, exactStage) || !bytes.Equal(stageReceipt, exactReceipt) {
				t.Fatal("restart rewrote history", err)
			}
			if len(pause) > 0 {
				var saved struct {
					ExpectedRevision int64  `json:"expectedRevision"`
					PriorRecordHash  string `json:"priorRecordHash"`
				}
				if err = json.Unmarshal(pause, &saved); err != nil {
					t.Fatal(err)
				}
				replay, err = repo.PauseReconciledRun(ctx, runnerstore.RecoveryPauseRequest{Schema: "openslack.workflow_runner_recovery_pause.v1", WorkspaceID: prepared.Value.WorkspaceID, RunID: prepared.Value.RunID, ExpectedRevision: saved.ExpectedRevision, ExpectedRecordHash: saved.PriorRecordHash})
				if err != nil || !bytes.Equal(replay, pause) {
					t.Fatal("restart changed exact pause", err)
				}
			}
			evidence, err := repo.ReadRecoveryEvidenceV2(ctx, prepared.Value.WorkspaceID, prepared.Value.RunID, "", "", "")
			if err != nil {
				t.Fatal(err)
			}
			for _, record := range evidence.Records {
				if record.Kind == "diagnostic" {
					t.Fatal("settled operation remained unfinished")
				}
			}
			head, err := source.Read(ctx, prepared.Value.WorkspaceID, prepared.Value.RunID)
			if err != nil || head.State != "paused" {
				t.Fatal("reconciled run is not paused", err)
			}
			// The historical conclusion cannot block a normal new-generation source CAS.
			var prior authoritystore.RunRecord
			if err = json.Unmarshal(head.RecordBytes, &prior); err != nil {
				t.Fatal(err)
			}
			next := reconciliationMutation(t, prior, "resuming", head.ResumeGeneration+1, "resume.new."+strings.Repeat("a", 64))
			if _, err = source.Mutate(ctx, next); err != nil {
				t.Fatal("new resume after reconciliation failed", err)
			}
		})
	}
}
