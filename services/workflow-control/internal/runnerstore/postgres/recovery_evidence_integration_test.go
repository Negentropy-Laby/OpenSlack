package postgres

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

func TestGS9F2RecoveryEvidenceIsReadOnlyScopedAndUpgradeSafe(t *testing.T) {
	requireGS9F2(t)
	pool := testsupport.OpenPostgres(t)
	repository := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	ctx := context.Background()
	const workspace = "workspace-recovery-evidence"
	original := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
		"recovery-read", nil, "resolved", workspace)
	stage, err := runnerbindingcontract.ParseStageBytes(original.ExactStageBytes)
	if err != nil {
		t.Fatal(err)
	}
	run := bindingString(stage, "runId")
	read := func() runnerstore.RecoveryEvidence {
		result, err := repository.ReadRecoveryEvidence(ctx, workspace, run, original.BindingID, "", "")
		if err != nil || result.Complete || result.NextCursor != nil || len(result.Bindings) != 1 || len(result.Unfinished) != 1 || len(result.ActiveAttempts) != 1 {
			t.Fatalf("recovery evidence: %+v %v", result, err)
		}
		entry := result.Bindings[0]
		if entry.Stage != string(original.ExactStageBytes) || entry.StageReceipt != string(original.ExactStageReceipt) || entry.Resolution == nil || *entry.Resolution != string(original.ExactResolutionBytes) || entry.ResolutionReceipt == nil || *entry.ResolutionReceipt != string(original.ExactResolutionReceipt) {
			t.Fatal("read changed exact committed frames")
		}
		return result
	}
	before := read()
	all, err := repository.ReadRecoveryEvidence(ctx, workspace, run, "", "", "")
	if err != nil || !all.Complete || len(all.Bindings) != 1 {
		t.Fatalf("complete frontier query failed: %+v %v", all, err)
	}
	for _, identity := range [][3]string{{"workspace-foreign", run, original.BindingID}, {workspace, "run-foreign", original.BindingID}, {workspace, run, "WFRUNNER-BINDING-" + strings.Repeat("0", 64)}} {
		if _, err := repository.ReadRecoveryEvidence(ctx, identity[0], identity[1], identity[2], "", ""); !runnerstore.IsCode(err, runnerstore.ErrorNotFound) {
			t.Fatalf("cross-identity query did not fail closed: %v", err)
		}
	}
	if _, err := repository.ReadRecoveryEvidence(ctx, workspace, run, "", original.BindingID, strings.Repeat("0", 64)); !runnerstore.IsCode(err, runnerstore.ErrorAuthorityUnavailable) {
		t.Fatalf("stale pagination snapshot accepted: %v", err)
	}
	var indexed bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='workflow_runner_bindings_run_recovery_idx')`).Scan(&indexed); err != nil || !indexed {
		t.Fatalf("workspace/run recovery index is missing: %v", err)
	}
	// Downgrade and reapply only the additive index migration; existing durable
	// frames and receipts must survive schema 8 -> 9 byte-for-byte.
	for _, direction := range []string{"down", "up"} {
		migration, err := os.ReadFile(v2MigrationPath(t, "000009_index_workflow_runner_recovery_evidence."+direction+".sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(migration)); err != nil {
			t.Fatalf("schema 9 %s: %v", direction, err)
		}
	}
	after := read()
	if before.Snapshot != after.Snapshot {
		t.Fatal("index upgrade changed durable history")
	}
	var exact []byte
	if err := pool.QueryRow(ctx, `SELECT exact_resolution_receipt_bytes FROM workflow_runner_authority_bindings WHERE binding_id=$1`, original.BindingID).Scan(&exact); err != nil || !bytes.Equal(exact, original.ExactResolutionReceipt) {
		t.Fatalf("read or upgrade changed authority receipt: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := repository.ReadRecoveryEvidence(cancelled, workspace, run, "", "", ""); err == nil {
		t.Fatal("cancelled read succeeded")
	}
}
