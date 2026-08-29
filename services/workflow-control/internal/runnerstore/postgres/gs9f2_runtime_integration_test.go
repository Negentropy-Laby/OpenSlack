package postgres

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

const gs9f2Marker = "WORKFLOW_RUNNER_GS9F2_QUALIFICATION"

func requireGS9F2(t *testing.T) {
	t.Helper()
	value, configured := os.LookupEnv(gs9f2Marker)
	if !configured {
		t.Skip(gs9f2Marker + " is not configured")
	}
	if value != "1" {
		t.Fatalf("%s must be exactly 1, got %q", gs9f2Marker, value)
	}
}

func TestGS9F2AuthorityBindingRuntimeDelivery(t *testing.T) {
	requireGS9F2(t)
	pool := testsupport.OpenPostgres(t)
	repository := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})

	t.Run("sealed initial admission accepts exact first lease", func(t *testing.T) {
		lease := claimV2(t, repository, v2JobInput(t, "f2-initial", "go", "workflow-control"))
		first := sealRuntimeAdmission(t, repository, lease, "initial")
		replay := sealRuntimeAdmission(t, repository, lease, "initial")
		if !replay.Replay || !bytes.Equal(first.ExactBytes, replay.ExactBytes) {
			t.Fatalf("runtime admission exact replay drifted: first=%+v replay=%+v", first, replay)
		}
		negotiateV2Lease(t, repository, lease)
		acceptedAt := canonicalNow()
		accept := v2LeasedEventAt(t, lease, authoritycontract.KindLeaseAccept, 1, "event-f2-initial",
			lease.RunRevision, lease.ResumeGeneration, acceptedAt,
			map[string]any{"acceptedAt": acceptedAt, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)})
		accept.ControlBuildHash = lease.AuthorityRoute.AuthorityBuildHash
		recorded, err := repository.RecordV2Event(context.Background(), accept)
		if err != nil || recorded.Status != runnerstore.ReceiptAccepted || recorded.Decision != nil {
			t.Fatalf("sealed initial admission was not consumed exactly: %+v %v", recorded, err)
		}
	})

	t.Run("first resume generation zero cannot pass without exact binding", func(t *testing.T) {
		lease := claimV2(t, repository, v2JobInput(t, "f2-first-resume", "go", "workflow-control"))
		sealRuntimeAdmission(t, repository, lease, "resume")
		negotiateV2Lease(t, repository, lease)
		acceptedAt := canonicalNow()
		accept := v2LeasedEventAt(t, lease, authoritycontract.KindLeaseAccept, 1, "event-f2-first-resume",
			1, 0, acceptedAt, map[string]any{"acceptedAt": acceptedAt, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)})
		accept.ControlBuildHash = lease.AuthorityRoute.AuthorityBuildHash
		if _, err := repository.RecordV2Event(context.Background(), accept); !runnerstore.IsCode(err, runnerstore.ErrorNotFound) {
			t.Fatalf("first resume (1,0) without stage binding did not fail closed: %v", err)
		}
	})

	t.Run("missing admission and opposite-disposition replay fail closed", func(t *testing.T) {
		lease := claimV2(t, repository, v2JobInput(t, "f2-missing-admission", "go", "workflow-control"))
		negotiateV2Lease(t, repository, lease)
		acceptedAt := canonicalNow()
		accept := v2LeasedEventAt(t, lease, authoritycontract.KindLeaseAccept, 1, "event-f2-missing-admission",
			1, 0, acceptedAt, map[string]any{"acceptedAt": acceptedAt, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)})
		accept.ControlBuildHash = lease.AuthorityRoute.AuthorityBuildHash
		if _, err := repository.RecordV2Event(context.Background(), accept); err == nil {
			t.Fatal("lease accept without an explicit runtime admission was accepted")
		}
		prepared := runtimeAdmissionForLease(t, lease, "initial")
		prepared.Value.Disposition = "resume"
		if _, err := repository.SealV2RuntimeAdmission(context.Background(), runnerstore.V2RuntimeAdmissionInput{
			WorkspaceID: lease.WorkspaceID, Prepared: prepared,
			IdempotencyKey: prepared.IdempotencyKey, RequestFingerprint: prepared.RequestFingerprint,
		}); !runnerstore.IsCode(err, runnerstore.ErrorHashMismatch) {
			t.Fatalf("body/prepared disposition splice was accepted: %v", err)
		}
	})

	t.Run("six operation revision generation matrix is database enforced", func(t *testing.T) {
		matrix := []struct {
			operation                 runnerbindingcontract.Operation
			runDelta, generationDelta int64
		}{
			{operation: runnerbindingcontract.OperationCheckpointCommit, runDelta: 1},
			{operation: runnerbindingcontract.OperationEffectAuthorize, runDelta: 1},
			{operation: runnerbindingcontract.OperationEffectComplete},
			{operation: runnerbindingcontract.OperationBudgetReserve, runDelta: 1},
			{operation: runnerbindingcontract.OperationBudgetSettle, runDelta: 1},
			{operation: runnerbindingcontract.OperationResumeAdvance, runDelta: 1, generationDelta: 1},
		}
		for index, row := range matrix {
			lease := claimV2(t, repository, v2JobInput(t, fmt.Sprintf("f2-matrix-valid-%d", index), "go", "workflow-control"))
			sealRuntimeAdmission(t, repository, lease, "initial")
			delta, err := runnerbindingcontract.RunnerHeadDelta(row.operation)
			if err != nil || delta.Revision != row.runDelta || delta.Generation != row.generationDelta {
				t.Fatalf("contract matrix %s drifted: %+v %v", row.operation, delta, err)
			}
			if _, err := pool.Exec(context.Background(), `UPDATE workflow_runner_v2_attempt_bindings
SET current_run_revision=current_run_revision+$2,current_resume_generation=current_resume_generation+$3,
    last_authority_operation=$4,last_authority_event_id=$5 WHERE attempt_id=$1`,
				lease.AttemptID, row.runDelta, row.generationDelta, string(row.operation), "event-f2-matrix-valid-"+fmt.Sprint(index)); err != nil {
				t.Fatalf("valid %s matrix row was rejected: %v", row.operation, err)
			}
		}
		for index, row := range matrix {
			lease := claimV2(t, repository, v2JobInput(t, fmt.Sprintf("f2-matrix-invalid-%d", index), "go", "workflow-control"))
			sealRuntimeAdmission(t, repository, lease, "initial")
			wrongRun, wrongGeneration := row.runDelta, row.generationDelta
			if row.operation == runnerbindingcontract.OperationEffectComplete {
				wrongRun = 1
			} else if row.operation == runnerbindingcontract.OperationResumeAdvance {
				wrongGeneration = 0
			} else {
				wrongRun = 0
			}
			if _, err := pool.Exec(context.Background(), `UPDATE workflow_runner_v2_attempt_bindings
SET current_run_revision=current_run_revision+$2,current_resume_generation=current_resume_generation+$3,
    last_authority_operation=$4,last_authority_event_id=$5 WHERE attempt_id=$1`,
				lease.AttemptID, wrongRun, wrongGeneration, string(row.operation), "event-f2-matrix-invalid-"+fmt.Sprint(index)); err == nil {
				t.Fatalf("invalid %s revision/generation transition was accepted", row.operation)
			}
		}
	})

	assertGS9F2BudgetDecisionUsesSourceRevision(t)

	t.Run("ACK predecessor closes instant and restart resend races", func(t *testing.T) {
		instant := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-instant-ack", nil, "runner_committed", "")
		lease, receipt := gs9f2BoundControl(t, repository, instant, false)
		if err := repository.MarkV2ControlDeliveryStarted(context.Background(), lease.AttemptID, receipt.EventID, string(receipt.Kind), time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		instantACK := buildGS9F2ControlACK(t, lease, instant.BindingID, runnerbindingcontract.OperationCheckpointCommit, receipt, 3)
		if _, err := repository.AcknowledgeV2Control(context.Background(), instantACK); err != nil {
			t.Fatalf("ACK arriving immediately after durable predecessor was rejected: %v", err)
		}
		if err := repository.MarkV2ControlDelivered(context.Background(), lease.AttemptID, receipt.EventID, string(receipt.Kind), time.Now().UTC()); err != nil {
			t.Fatalf("transport return after instant ACK regressed delivery: %v", err)
		}

		resend := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-restart-resend", nil, "runner_committed", "")
		resendLease, resendReceipt := gs9f2BoundControl(t, repository, resend, false)
		if err := repository.MarkV2ControlDeliveryStarted(context.Background(), resendLease.AttemptID, resendReceipt.EventID, string(resendReceipt.Kind), time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		if err := repository.MarkV2ControlDeliveryStarted(context.Background(), resendLease.AttemptID, resendReceipt.EventID, string(resendReceipt.Kind), time.Now().UTC()); err != nil {
			t.Fatalf("restart resend could not reuse awaiting-ACK predecessor: %v", err)
		}
		if err := repository.MarkV2ControlDelivered(context.Background(), resendLease.AttemptID, resendReceipt.EventID, string(resendReceipt.Kind), time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		var deliveryState string
		if err := pool.QueryRow(context.Background(), `SELECT delivery_state FROM workflow_runner_control_messages WHERE control_event_id=$1`, resendReceipt.EventID).Scan(&deliveryState); err != nil || deliveryState != "awaiting_ack" {
			t.Fatalf("restart resend treated transport write as authority ACK: state=%s err=%v", deliveryState, err)
		}
		resendACK := buildGS9F2ControlACK(t, resendLease, resend.BindingID, runnerbindingcontract.OperationCheckpointCommit, resendReceipt, 3)
		if _, err := repository.AcknowledgeV2Control(context.Background(), resendACK); err != nil {
			t.Fatal(err)
		}
	})

	for _, operation := range []runnerbindingcontract.Operation{
		runnerbindingcontract.OperationCheckpointCommit,
		runnerbindingcontract.OperationEffectAuthorize,
		runnerbindingcontract.OperationEffectComplete,
		runnerbindingcontract.OperationBudgetReserve,
		runnerbindingcontract.OperationBudgetSettle,
		runnerbindingcontract.OperationResumeAdvance,
	} {
		operation := operation
		t.Run("exact runtime lifecycle/"+string(operation), func(t *testing.T) {
			exerciseGS9F2BindingLifecycle(t, repository, operation, "f2-lifecycle-"+string(operation))
		})
	}

	t.Run("decision ACK4 is followed by ordinary cancel and cancel_ack", func(t *testing.T) {
		ctx := context.Background()
		view := exerciseGS9F2BindingLifecycle(t, repository, runnerbindingcontract.OperationEffectAuthorize,
			"f2-decision-then-ordinary-cancel")
		var correlationID, backend, authority string
		var routingEpoch, runRevision, generation, workerSequence, decisionSequence int64
		var buildHash []byte
		if err := pool.QueryRow(ctx, `SELECT job.correlation_id,binding.authority_backend,binding.workflow_authority,
binding.routing_epoch,binding.authority_build_hash,binding.current_run_revision,binding.current_resume_generation,
attempt.worker_sequence,decision.sequence
FROM workflow_runner_jobs job
JOIN workflow_runner_attempts attempt ON attempt.attempt_id=$1
JOIN workflow_runner_v2_attempt_bindings binding ON binding.attempt_id=attempt.attempt_id
JOIN workflow_runner_authority_bindings authority_binding ON authority_binding.binding_id=$2
JOIN workflow_runner_v2_decision_bindings pair ON pair.received_event_id=authority_binding.target_event_id
JOIN workflow_runner_control_messages decision ON decision.control_event_id=pair.decision_control_event_id
WHERE job.workspace_id=$3 AND job.job_id=$4`, view.AttemptID, view.BindingID, view.WorkspaceID, view.JobID).Scan(
			&correlationID, &backend, &authority, &routingEpoch, &buildHash, &runRevision, &generation,
			&workerSequence, &decisionSequence,
		); err != nil {
			t.Fatal(err)
		}
		lease := runnerstore.AttemptLease{
			WorkspaceID: view.WorkspaceID, JobID: view.JobID, WorkflowRunID: view.RunID,
			CorrelationID: correlationID, AttemptID: view.AttemptID, LeaseID: view.LeaseID,
			FencingToken: view.FencingToken, RequiredProtocolVersion: authoritycontract.ProtocolVersion,
			AuthorityRoute: &authoritycontract.Route{Backend: backend, Authority: authority, RoutingEpoch: routingEpoch,
				AuthorityBuildHash: hex.EncodeToString(buildHash)},
			RunRevision: runRevision, ResumeGeneration: generation,
		}
		now := time.Now().UTC().Truncate(time.Millisecond)
		cancelInput := runnerstore.CancelInput{
			WorkspaceID: view.WorkspaceID, JobID: view.JobID, CorrelationID: correlationID,
			ExpectedAttemptID: view.AttemptID, ExpectedLeaseID: view.LeaseID, ExpectedFence: view.FencingToken,
			Reason: "operator", Now: now, ExpiresAt: now.Add(time.Minute),
		}
		cancelInput.IdempotencyKey, cancelInput.RequestFingerprint, _ = runnerstore.CancelBindings(cancelInput)
		cancel, err := repository.RequestCancel(ctx, cancelInput)
		if err != nil {
			t.Fatal(err)
		}
		if cancel.ControlSequence != decisionSequence+1 {
			t.Fatalf("ordinary cancel sequence=%d want decision successor %d", cancel.ControlSequence, decisionSequence+1)
		}
		wrapped, err := repository.PrepareV2Cancel(ctx, lease, cancel)
		if err != nil {
			t.Fatal(err)
		}
		if wrapped.Message.Sequence == nil || *wrapped.Message.Sequence != cancel.ControlSequence {
			t.Fatalf("ordinary v2 cancel sequence drifted: %+v", wrapped.Message.Sequence)
		}
		if err := repository.MarkV2ControlDeliveryStarted(ctx, lease.AttemptID, wrapped.Message.EventID,
			string(wrapped.Message.Kind), time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		if err := repository.MarkV2ControlDelivered(ctx, lease.AttemptID, wrapped.Message.EventID,
			string(wrapped.Message.Kind), time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		var deliveryState string
		var bindingACKs int
		if err := pool.QueryRow(ctx, `SELECT delivery_state FROM workflow_runner_control_messages WHERE control_event_id=$1`,
			wrapped.Message.EventID).Scan(&deliveryState); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runner_authority_control_acks WHERE control_event_id=$1`,
			wrapped.Message.EventID).Scan(&bindingACKs); err != nil {
			t.Fatal(err)
		}
		if deliveryState != "delivered" || bindingACKs != 0 {
			t.Fatalf("post-decision cancel entered binding ACK lane: state=%s ACKs=%d", deliveryState, bindingACKs)
		}
		acknowledgedAt := canonicalNow()
		cancelACK := v2LeasedEventAt(t, lease, authoritycontract.KindCancelAck, workerSequence+1,
			"event-f2-ordinary-cancel-ack", runRevision, generation, acknowledgedAt,
			map[string]any{"cancelId": cancel.CancelID, "acknowledgedAt": acknowledgedAt, "status": "cancelling"})
		cancelACK.ControlBuildHash = lease.AuthorityRoute.AuthorityBuildHash
		recorded, err := repository.RecordV2Event(ctx, cancelACK)
		if err != nil || recorded.AuthorityBindingID != nil || recorded.Status != runnerstore.ReceiptAccepted {
			t.Fatalf("ordinary cancel_ack did not close through Runner v2: %+v %v", recorded, err)
		}
		var cancelState string
		if err := pool.QueryRow(ctx, `SELECT state FROM workflow_runner_cancel_controls WHERE cancel_id=$1`, cancel.CancelID).Scan(&cancelState); err != nil {
			t.Fatal(err)
		}
		if cancelState != "acknowledged" {
			t.Fatalf("ordinary cancel_ack durable state=%s", cancelState)
		}
	})
}

func TestGS9F2AuthorityBindingRestartRecovery(t *testing.T) {
	requireGS9F2(t)
	phase := os.Getenv("WORKFLOW_RUNNER_GS9F2_RESTART_PHASE")
	schema := os.Getenv("WORKFLOW_RUNNER_GS9F2_RESTART_SCHEMA")
	if phase == "" || schema == "" {
		t.Skip("GS9-F2 restart seed/verify variables are not configured")
	}
	pool := testsupport.OpenPersistentSchema(t, schema, phase == "seed")
	repository := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	switch phase {
	case "seed":
		const restartWorkspace = "workspace-f2-restart-recovery"
		for _, state := range []string{"staged", "resolved", "runner_committed", "awaiting_ack"} {
			view := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
				"f2-restart-"+state, nil, state, restartWorkspace)
			if view.BindingID == "" {
				t.Fatalf("restart %s seed omitted authority binding", state)
			}
		}
		var awaiting int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM workflow_runner_control_messages WHERE delivery_state='awaiting_ack'`).Scan(&awaiting); err != nil || awaiting != 1 {
			t.Fatalf("restart seed awaiting ACK count=%d err=%v", awaiting, err)
		}
	case "verify":
		var exact []byte
		if err := pool.QueryRow(context.Background(), `SELECT exact_request_bytes FROM workflow_runner_v2_runtime_admissions LIMIT 1`).Scan(&exact); err != nil {
			t.Fatal(err)
		}
		prepared, err := runnerstore.ParseV2RuntimeAdmission(exact)
		if err != nil {
			t.Fatal(err)
		}
		receipt, err := repository.SealV2RuntimeAdmission(context.Background(), runnerstore.V2RuntimeAdmissionInput{
			WorkspaceID: prepared.Value.WorkspaceID, Prepared: prepared,
			IdempotencyKey: prepared.IdempotencyKey, RequestFingerprint: prepared.RequestFingerprint,
		})
		if err != nil || !receipt.Replay || len(receipt.ExactBytes) == 0 {
			t.Fatalf("restart point-read did not recover exact admission: %+v %v", receipt, err)
		}
		views, err := repository.RecoverAuthorityBindings(context.Background(), prepared.Value.WorkspaceID, time.Now().UTC(), 10)
		if err != nil || len(views) != 4 {
			t.Fatalf("restart binding scan before orphan recovery got=%d err=%v", len(views), err)
		}
		states := map[string]int{}
		for _, view := range views {
			states[view.State]++
		}
		if states["staged"] != 1 || states["resolved"] != 1 || states["runner_committed"] != 2 {
			t.Fatalf("restart phase inventory drifted: %v", states)
		}
		recovered, err := repository.RecoverOrphans(context.Background(), "supervisor-f2-restart-verify", time.Now().UTC(), 10)
		if err != nil || len(recovered) != 4 {
			t.Fatalf("restart orphan recovery got=%d err=%v", len(recovered), err)
		}
		for _, result := range recovered {
			if result.State != runnerstore.JobReconciliationRequired || result.SafeForNewAttempt {
				t.Fatalf("restart orphan escaped quarantine: %+v", result)
			}
		}
		views, err = repository.RecoverAuthorityBindings(context.Background(), prepared.Value.WorkspaceID, time.Now().UTC(), 10)
		if err != nil || len(views) != 4 {
			t.Fatalf("restart binding scan after orphan recovery got=%d err=%v", len(views), err)
		}
		for _, view := range views {
			if view.State != "reconciliation_required" || view.ReconciliationID == nil || view.ReconciliationReason == nil ||
				*view.ReconciliationReason != "process_crash" || len(view.ExactStageBytes) == 0 {
				t.Fatalf("restart binding was not reason-specifically quarantined: %+v", view)
			}
			if view.JobID == "job-f2-restart-staged" && (len(view.ExactResolutionBytes) != 0 || len(view.ExactResolutionReceipt) != 0) {
				t.Fatalf("stage-only recovery invented resolution evidence: %+v", view)
			}
			if view.JobID != "job-f2-restart-staged" && (len(view.ExactResolutionBytes) == 0 || len(view.ExactResolutionReceipt) == 0) {
				t.Fatalf("post-resolution recovery lost exact evidence: %+v", view)
			}
		}
		var reconciledControls int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM workflow_runner_control_messages WHERE delivery_state='reconciliation_required'`).Scan(&reconciledControls); err != nil || reconciledControls != 1 {
			t.Fatalf("awaiting ACK was not latched across restart: count=%d err=%v", reconciledControls, err)
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("WORKFLOW_RUNNER_GS9F2_RESTART_PHASE must be seed or verify, got %q", phase)
	}
}

func TestGS9F2AuthorityBindingMigrationGuards(t *testing.T) {
	requireGS9F2(t)
	pool := testsupport.OpenPostgres(t)
	repository := NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	lease := claimV2(t, repository, v2JobInput(t, "f2-migration-guard", "go", "workflow-control"))
	sealRuntimeAdmission(t, repository, lease, "initial")

	if _, err := pool.Exec(context.Background(), `UPDATE workflow_runner_v2_runtime_admissions SET admission_disposition='resume' WHERE attempt_id=$1`, lease.AttemptID); err == nil {
		t.Fatal("immutable runtime admission was rewritten")
	}
	if _, err := pool.Exec(context.Background(), `UPDATE workflow_runner_v2_attempt_bindings SET admission_job_spec_hash=decode(repeat('ff',32),'hex') WHERE attempt_id=$1`, lease.AttemptID); err == nil {
		t.Fatal("attempt admission FK/hash anchor was rewritten")
	}
	_, forgedErr := pool.Exec(context.Background(), `INSERT INTO workflow_runner_authority_control_acks
(control_event_id,binding_id,control_kind,control_sequence,companion_sequence,message_digest,
 attempt_id,lease_id,fencing_token,disposition,ack_idempotency_key,ack_request_fingerprint,
 ack_hash,exact_ack_bytes,processed_at)
VALUES ('forged-control','forged-binding','event_receipt',3,3,decode(repeat('11',32),'hex'),
 'forged-attempt','forged-lease',1,'accepted','forged-key',decode(repeat('22',32),'hex'),
 decode(repeat('33',32),'hex'),convert_to('{}','UTF8'),clock_timestamp())`)
	var pgErr *pgconn.PgError
	if !errors.As(forgedErr, &pgErr) || pgErr.ConstraintName != "workflow_runner_authority_control_ack_hash_check" {
		t.Fatalf("forged ACK bytes/hash did not fail the DB hash guard: %v", forgedErr)
	}
	var admissionTable *string
	if err := pool.QueryRow(context.Background(), `SELECT to_regclass('workflow_runner_v2_runtime_admissions')::TEXT`).Scan(&admissionTable); err != nil || admissionTable == nil {
		t.Fatalf("schema-8 runtime admission inventory is missing: table=%v err=%v", admissionTable, err)
	}

	t.Run("schema7 exact authority row survives schema8 upgrade", func(t *testing.T) {
		upgradePool := testsupport.OpenPostgres(t)
		downMigration, err := os.ReadFile(v2MigrationPath(t, "000008_deliver_workflow_runner_authority_bindings.down.sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := upgradePool.Exec(context.Background(), string(downMigration)); err != nil {
			t.Fatalf("return exact compatibility fixture to schema 7: %v", err)
		}
		adapter := &budgetFoundationAdapter{}
		schema7Repository := NewForSchema(upgradePool, 7)
		schema7Repository.v2Authorities = runnerstore.V2AuthorityPorts{Budget: adapter}
		lease := startV2Lease(t, schema7Repository, "f2-schema7-exact-upgrade")
		event := v2BudgetReserve(t, lease, 2, "event-f2-schema7-exact-upgrade")
		recorded, err := schema7Repository.RecordV2Event(context.Background(), event)
		if err != nil || recorded.Decision == nil || adapter.applyCalls != 1 {
			t.Fatalf("form schema7 exact authority row through the F1 store path: %+v err=%v calls=%d", recorded, err, adapter.applyCalls)
		}
		var beforeState, beforeOperation string
		var beforeHash, beforeExact []byte
		if err := upgradePool.QueryRow(context.Background(), `SELECT state,authority_operation,authority_receipt_hash,exact_authority_receipt_bytes
FROM workflow_runner_v2_event_inbox WHERE event_id=$1`, event.Message.EventID).Scan(
			&beforeState, &beforeOperation, &beforeHash, &beforeExact,
		); err != nil {
			t.Fatal(err)
		}
		if beforeState != "runner_committed" || beforeOperation != "budget_reserve" || len(beforeHash) != 32 || len(beforeExact) == 0 {
			t.Fatalf("schema7 exact authority row is incomplete: state=%s operation=%s hash=%x exact=%q",
				beforeState, beforeOperation, beforeHash, beforeExact)
		}
		upMigration, err := os.ReadFile(v2MigrationPath(t, "000008_deliver_workflow_runner_authority_bindings.up.sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := upgradePool.Exec(context.Background(), string(upMigration)); err != nil {
			t.Fatalf("upgrade a valid schema7 exact authority row to schema8: %v", err)
		}
		var afterState, afterOperation string
		var afterHash, afterExact []byte
		if err := upgradePool.QueryRow(context.Background(), `SELECT state,authority_operation,authority_receipt_hash,exact_authority_receipt_bytes
FROM workflow_runner_v2_event_inbox WHERE event_id=$1`, event.Message.EventID).Scan(
			&afterState, &afterOperation, &afterHash, &afterExact,
		); err != nil {
			t.Fatal(err)
		}
		if afterState != beforeState || afterOperation != beforeOperation ||
			!bytes.Equal(afterHash, beforeHash) || !bytes.Equal(afterExact, beforeExact) {
			t.Fatalf("schema8 upgrade rewrote exact schema7 authority evidence: before=%s/%s/%x/%q after=%s/%s/%x/%q",
				beforeState, beforeOperation, beforeHash, beforeExact, afterState, afterOperation, afterHash, afterExact)
		}
		schema8Repository := NewWithV2Authorities(upgradePool, runnerstore.V2AuthorityPorts{Budget: adapter})
		replay, err := schema8Repository.RecordV2Event(context.Background(), event)
		if err != nil || !replay.Duplicate || adapter.applyCalls != 1 ||
			!bytes.Equal(replay.ReceiptBytes, recorded.ReceiptBytes) || !bytes.Equal(replay.DecisionBytes, recorded.DecisionBytes) {
			t.Fatalf("schema8 exact replay did not preserve the schema7 authority result: %+v err=%v calls=%d", replay, err, adapter.applyCalls)
		}
	})

	t.Run("schema7 authority outcome cross-splice blocks schema8 upgrade", func(t *testing.T) {
		upgradePool := testsupport.OpenPostgres(t)
		downMigration, err := os.ReadFile(v2MigrationPath(t, "000008_deliver_workflow_runner_authority_bindings.down.sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := upgradePool.Exec(context.Background(), string(downMigration)); err != nil {
			t.Fatalf("return isolated upgrade fixture to schema 7: %v", err)
		}
		schema7Repository := NewForSchema(upgradePool, 7)
		schema7Lease := claimV2(t, schema7Repository,
			v2JobInput(t, "f2-schema7-upgrade-splice", "ts-local", "typescript"))
		exactAuthority := []byte("{}\n")
		if _, err := upgradePool.Exec(context.Background(), `INSERT INTO workflow_runner_v2_event_inbox (
event_id,workspace_id,job_id,attempt_id,lease_id,fencing_token,worker_sequence,kind,run_revision,resume_generation,
idempotency_key,request_fingerprint,message_digest,exact_event_bytes,state,authority_operation,
authority_receipt_hash,exact_authority_receipt_bytes,created_at,updated_at)
VALUES ('event-f2-schema7-upgrade-splice',$1,$2,$3,$4,$5,1,'checkpoint_commit',$6,$7,
'event-f2-schema7-upgrade-splice-key',decode(repeat('11',32),'hex'),decode(repeat('22',32),'hex'),convert_to('{}' || chr(10),'UTF8'),
'authority_committed','budget_settle',sha256($8),$8,clock_timestamp(),clock_timestamp())`,
			schema7Lease.WorkspaceID, schema7Lease.JobID, schema7Lease.AttemptID, schema7Lease.LeaseID,
			schema7Lease.FencingToken, schema7Lease.RunRevision, schema7Lease.ResumeGeneration, exactAuthority); err != nil {
			t.Fatal(err)
		}
		upMigration, err := os.ReadFile(v2MigrationPath(t, "000008_deliver_workflow_runner_authority_bindings.up.sql"))
		if err != nil {
			t.Fatal(err)
		}
		_, upgradeErr := upgradePool.Exec(context.Background(), string(upMigration))
		var upgradePGErr *pgconn.PgError
		if !errors.As(upgradeErr, &upgradePGErr) || upgradePGErr.Code != "23514" ||
			upgradePGErr.ConstraintName != "workflow_runner_v2_event_inbox_f2b_upgrade_check" {
			t.Fatalf("schema8 upgrade accepted a schema7 authority outcome splice: %v", upgradeErr)
		}
	})

	t.Run("runtime admission request receipt cross-splice is rejected", func(t *testing.T) {
		workspace := "workspace-f2-admission-splice"
		leaseA := claimV2(t, repository, v2JobInputForWorkspace(t, "f2-admission-splice-a", workspace, "go", "workflow-control"))
		receiptA := sealRuntimeAdmission(t, repository, leaseA, "initial")
		leaseB := claimV2(t, repository, v2JobInputForWorkspace(t, "f2-admission-splice-b", workspace, "go", "workflow-control"))
		preparedB := runtimeAdmissionForLease(t, leaseB, "initial")
		fingerprintB, decodeErr := hex.DecodeString(preparedB.RequestFingerprint[len("sha256:"):])
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if _, err := pool.Exec(context.Background(), `INSERT INTO workflow_runner_v2_runtime_admissions
(attempt_id,workspace_id,job_id,workflow_run_id,lease_id,fencing_token,job_spec_hash,
 admission_disposition,idempotency_key,request_fingerprint,exact_request_bytes,exact_receipt_bytes,admitted_at)
VALUES ($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8,$9,$10,$11,$12,clock_timestamp())`,
			leaseB.AttemptID, leaseB.WorkspaceID, leaseB.JobID, leaseB.WorkflowRunID, leaseB.LeaseID,
			leaseB.FencingToken, leaseB.JobSpecHash, "initial", preparedB.IdempotencyKey, fingerprintB,
			preparedB.ExactBytes, receiptA.ExactBytes); err == nil {
			t.Fatal("database accepted runtime admission request A plus receipt B")
		}

		receiptB := sealRuntimeAdmission(t, repository, leaseB, "initial")
		if _, err := pool.Exec(context.Background(), `ALTER TABLE workflow_runner_v2_runtime_admissions DISABLE TRIGGER workflow_runner_v2_runtime_admissions_guard;
UPDATE workflow_runner_v2_runtime_admissions SET exact_receipt_bytes=$2 WHERE attempt_id=$1;
ALTER TABLE workflow_runner_v2_runtime_admissions ENABLE TRIGGER workflow_runner_v2_runtime_admissions_guard`, leaseA.AttemptID, receiptB.ExactBytes); err != nil {
			t.Fatal(err)
		}
		preparedA := runtimeAdmissionForLease(t, leaseA, "initial")
		if _, err := repository.SealV2RuntimeAdmission(context.Background(), runnerstore.V2RuntimeAdmissionInput{
			WorkspaceID: leaseA.WorkspaceID, Prepared: preparedA,
			IdempotencyKey: preparedA.IdempotencyKey, RequestFingerprint: preparedA.RequestFingerprint,
		}); !runnerstore.IsCode(err, runnerstore.ErrorHashMismatch) {
			t.Fatalf("point-read replay accepted sibling exact receipt bytes: %v", err)
		}
		if _, err := pool.Exec(context.Background(), `ALTER TABLE workflow_runner_v2_runtime_admissions DISABLE TRIGGER workflow_runner_v2_runtime_admissions_guard;
UPDATE workflow_runner_v2_runtime_admissions SET exact_receipt_bytes=$2 WHERE attempt_id=$1;
ALTER TABLE workflow_runner_v2_runtime_admissions ENABLE TRIGGER workflow_runner_v2_runtime_admissions_guard`, leaseA.AttemptID, receiptA.ExactBytes); err != nil {
			t.Fatal(err)
		}

		connection, err := pool.Acquire(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Release()
		if _, err := connection.Exec(context.Background(), `SET session_replication_role='replica';
UPDATE workflow_runner_v2_runtime_admissions SET admission_disposition='resume' WHERE attempt_id=$1;
UPDATE workflow_runner_v2_attempt_bindings SET admission_disposition='resume' WHERE attempt_id=$1;
SET session_replication_role='origin'`, leaseA.AttemptID); err != nil {
			_, _ = connection.Exec(context.Background(), `SET session_replication_role='origin'`)
			t.Fatal(err)
		}
		acceptedAt := canonicalNow()
		accept := v2LeasedEventAt(t, leaseA, authoritycontract.KindLeaseAccept, 1, "event-f2-admission-column-drift",
			leaseA.RunRevision, leaseA.ResumeGeneration, acceptedAt,
			map[string]any{"acceptedAt": acceptedAt, "leaseExpiresAt": runnerstore.CanonicalTimestamp(leaseA.LeaseExpiresAt)})
		if repository.isInitialV2LeaseAccept(context.Background(), accept.Message) || repository.isResumeV2LeaseAccept(context.Background(), accept.Message) {
			t.Fatal("lease admission consumption trusted drifted disposition columns over exact request/receipt bytes")
		}
		if _, err := connection.Exec(context.Background(), `SET session_replication_role='replica';
UPDATE workflow_runner_v2_runtime_admissions SET admission_disposition='initial' WHERE attempt_id=$1;
UPDATE workflow_runner_v2_attempt_bindings SET admission_disposition='initial' WHERE attempt_id=$1;
SET session_replication_role='origin'`, leaseA.AttemptID); err != nil {
			_, _ = connection.Exec(context.Background(), `SET session_replication_role='origin'`)
			t.Fatal(err)
		}
	})

	t.Run("binding transition and ACK guards fail closed", func(t *testing.T) {
		ctx := context.Background()
		early := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-early-complete", nil, "runner_committed", "")
		if _, err := pool.Exec(ctx, `UPDATE workflow_runner_authority_bindings SET state='completed' WHERE binding_id=$1`, early.BindingID); err == nil {
			t.Fatal("runner-committed binding completed without exact ACK")
		}

		forgedExact := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-forged-exact-ack", nil, "runner_committed", "")
		forgedLease, forgedReceipt := gs9f2BoundControl(t, repository, forgedExact, false)
		validACK := prepareGS9F2ControlACK(t, repository, forgedLease, forgedExact.BindingID,
			runnerbindingcontract.OperationCheckpointCommit, forgedReceipt, 3)
		forgedACK := validACK
		forgedACK.Prepared.Body = "{}\n"
		forgedBodyErr := insertGS9F2ControlACKRow(t, repository, forgedExact.BindingID, forgedACK, nil)
		var forgedBodyPGErr *pgconn.PgError
		if !errors.As(forgedBodyErr, &forgedBodyPGErr) || forgedBodyPGErr.Code != "23514" ||
			forgedBodyPGErr.ConstraintName != "workflow_runner_authority_control_ack_bytes_check" {
			t.Fatalf("self-hashed forged exact ACK body did not fail the DB byte binding: %v", forgedBodyErr)
		}
		noncanonicalACK := validACK
		noncanonicalACK.Prepared.Body = strings.Replace(validACK.Prepared.Body, `{"bindingId":`, `{ "bindingId":`, 1)
		if noncanonicalACK.Prepared.Body == validACK.Prepared.Body {
			t.Fatal("failed to construct the semantically identical noncanonical ACK")
		}
		noncanonicalErr := insertGS9F2ControlACKRow(t, repository, forgedExact.BindingID, noncanonicalACK, nil)
		var noncanonicalPGErr *pgconn.PgError
		if !errors.As(noncanonicalErr, &noncanonicalPGErr) || noncanonicalPGErr.Code != "23514" ||
			noncanonicalPGErr.ConstraintName != "workflow_runner_authority_control_ack_bytes_check" {
			t.Fatalf("self-hashed noncanonical ACK did not fail the DB canonical byte binding: %v", noncanonicalErr)
		}
		nonIntegerACK := validACK
		nonIntegerACK.Prepared.Body = strings.Replace(validACK.Prepared.Body,
			`"companionSequence":3,`, `"companionSequence":3.0,`, 1)
		if nonIntegerACK.Prepared.Body == validACK.Prepared.Body {
			t.Fatal("failed to construct the self-hashed non-integer ACK")
		}
		nonIntegerErr := insertGS9F2ControlACKRow(t, repository, forgedExact.BindingID, nonIntegerACK, nil)
		var nonIntegerPGErr *pgconn.PgError
		if !errors.As(nonIntegerErr, &nonIntegerPGErr) || nonIntegerPGErr.Code != "23514" ||
			nonIntegerPGErr.ConstraintName != "workflow_runner_authority_control_ack_bytes_check" {
			t.Fatalf("self-hashed 3.0 ACK integer did not fail the DB canonical byte binding: %v", nonIntegerErr)
		}
		committedAt := validACK.Prepared.Value["committedAt"].(string)
		parsedCommittedAt, err := time.Parse(time.RFC3339Nano, committedAt)
		if err != nil {
			t.Fatal(err)
		}
		driftedCommittedAt := runnerstore.CanonicalTimestamp(parsedCommittedAt.Add(time.Millisecond))
		driftedACK := validACK
		driftedACK.Prepared.Body = strings.Replace(validACK.Prepared.Body,
			`"committedAt":"`+committedAt+`"`, `"committedAt":"`+driftedCommittedAt+`"`, 1)
		if driftedACK.Prepared.Body == validACK.Prepared.Body {
			t.Fatal("failed to construct the self-hashed ACK timestamp drift")
		}
		driftedBodyErr := insertGS9F2ControlACKRow(t, repository, forgedExact.BindingID, driftedACK, nil)
		var driftedBodyPGErr *pgconn.PgError
		if !errors.As(driftedBodyErr, &driftedBodyPGErr) || driftedBodyPGErr.Code != "23514" ||
			driftedBodyPGErr.ConstraintName != "workflow_runner_authority_control_ack_bytes_check" {
			t.Fatalf("self-hashed ACK committedAt/processedAt drift did not fail the DB byte binding: %v", driftedBodyErr)
		}
		var forgedControlState, forgedBindingState string
		if err := pool.QueryRow(ctx, `SELECT delivery_state FROM workflow_runner_control_messages WHERE control_event_id=$1`,
			forgedReceipt.EventID).Scan(&forgedControlState); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT state FROM workflow_runner_authority_bindings WHERE binding_id=$1`,
			forgedExact.BindingID).Scan(&forgedBindingState); err != nil {
			t.Fatal(err)
		}
		if forgedControlState != "awaiting_ack" || forgedBindingState != "runner_committed" {
			t.Fatalf("forged exact ACK advanced durable state: control=%s binding=%s", forgedControlState, forgedBindingState)
		}

		crossTarget := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-cross-event-target", nil, "runner_committed", "")
		lease, eventReceipt := gs9f2BoundControl(t, repository, early, false)
		crossEventACK := prepareGS9F2ControlACK(t, repository, lease, early.BindingID,
			runnerbindingcontract.OperationCheckpointCommit, eventReceipt, 3)
		if err := insertGS9F2ControlACKRow(t, repository, crossTarget.BindingID, crossEventACK, nil); err == nil {
			t.Fatal("event-receipt ACK was cross-spliced onto a sibling binding")
		}

		decisionSource := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationEffectAuthorize,
			"f2-guard-decision-source", nil, "runner_committed", "")
		decisionTarget := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationEffectAuthorize,
			"f2-guard-decision-target", nil, "runner_committed", "")
		decisionLease, receiptMessage := gs9f2BoundControl(t, repository, decisionSource, false)
		receiptACK := acknowledgeGS9F2Control(t, repository, decisionLease, decisionSource.BindingID,
			runnerbindingcontract.OperationEffectAuthorize, receiptMessage, 3)
		if _, err := pool.Exec(ctx, `UPDATE workflow_runner_authority_bindings SET state='completed' WHERE binding_id=$1`, decisionSource.BindingID); err == nil {
			t.Fatal("decision-producing binding completed with only companion-3 ACK")
		}
		_, decisionMessage := gs9f2BoundControl(t, repository, decisionSource, true)
		crossDecisionACK := prepareGS9F2ControlACK(t, repository, decisionLease, decisionSource.BindingID,
			runnerbindingcontract.OperationEffectAuthorize, decisionMessage, 4)
		if err := insertGS9F2ControlACKRow(t, repository, decisionTarget.BindingID, crossDecisionACK,
			receiptACK.Prepared.Value["controlEventId"]); err == nil {
			t.Fatal("decision ACK was cross-spliced onto a sibling binding")
		}

		resolved := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-null-source-plane", nil, "resolved", "")
		if _, err := pool.Exec(ctx, `UPDATE workflow_runner_authority_bindings SET source_plane=NULL WHERE binding_id=$1`, resolved.BindingID); err == nil {
			t.Fatal("resolved binding accepted a NULL source plane with retained source siblings")
		}

		hashGuard := exerciseGS9F2BindingLifecycle(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-source-result-hash")
		connection, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Release()
		if _, err := connection.Exec(ctx, `SET session_replication_role='replica'`); err != nil {
			t.Fatal(err)
		}
		_, hashErr := connection.Exec(ctx, `UPDATE workflow_runner_authority_bindings SET
operation='budget_reserve',source_plane='budget_account',source_evidence_state='prepared',
source_accepted_revision=NULL,source_receipt_hash=NULL,source_record_hash=NULL,
exact_source_result_bytes=convert_to('{"schema":"forged"}' || chr(10),'UTF8'),
source_result_hash=decode(repeat('ff',32),'hex') WHERE binding_id=$1`, hashGuard.BindingID)
		if _, err := connection.Exec(ctx, `SET session_replication_role='origin'`); err != nil {
			t.Fatal(err)
		}
		var hashPGErr *pgconn.PgError
		if !errors.As(hashErr, &hashPGErr) || hashPGErr.Code != "23514" ||
			hashPGErr.ConstraintName != "workflow_runner_authority_source_result_hash_check" {
			t.Fatalf("forged source-result bytes/hash did not fail the DB hash guard: %v", hashErr)
		}

		replayGuard := exerciseGS9F2BindingLifecycle(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-inbox-operation-replay")
		if _, err := pool.Exec(ctx, `UPDATE workflow_runner_v2_event_inbox SET authority_operation='budget_settle'
WHERE event_id=$1`, replayGuard.TargetEventID); err == nil {
			t.Fatal("runner-committed event inbox authority operation was mutable")
		}
		if _, err := connection.Exec(ctx, `SET session_replication_role='replica'`); err != nil {
			t.Fatal(err)
		}
		if _, err := connection.Exec(ctx, `UPDATE workflow_runner_v2_event_inbox SET authority_operation='budget_settle'
WHERE event_id=$1`, replayGuard.TargetEventID); err != nil {
			_, _ = connection.Exec(ctx, `SET session_replication_role='origin'`)
			t.Fatal(err)
		}
		if _, err := connection.Exec(ctx, `SET session_replication_role='origin'`); err != nil {
			t.Fatal(err)
		}
		replayMessage, err := authoritycontract.DecodeMessageJSON(replayGuard.ExactTargetBytes)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repository.RecordV2Event(ctx, runnerstore.V2RecordEventInput{
			Message: replayMessage, ExactBytes: replayGuard.ExactTargetBytes,
			ControlBuildHash: *replayMessage.AuthorityBuildHash, Now: time.Now().UTC(),
		}); !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
			t.Fatalf("exact event replay accepted a checkpoint/budget-settle operation splice: %v", err)
		}
		if _, err := connection.Exec(ctx, `SET session_replication_role='replica'`); err != nil {
			t.Fatal(err)
		}
		if _, err := connection.Exec(ctx, `UPDATE workflow_runner_v2_event_inbox SET authority_operation='checkpoint_commit'
WHERE event_id=$1`, replayGuard.TargetEventID); err != nil {
			_, _ = connection.Exec(ctx, `SET session_replication_role='origin'`)
			t.Fatal(err)
		}
		if _, err := connection.Exec(ctx, `SET session_replication_role='origin'`); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("reconciliation identity and frozen phase shape fail closed", func(t *testing.T) {
		ctx := context.Background()
		first := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-reconciliation-first", nil, "staged", "")
		second := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-reconciliation-second", nil, "staged", "")
		if _, err := repository.RecordProcessExit(ctx, runnerstore.ProcessExitInput{
			WorkspaceID: second.WorkspaceID, JobID: second.JobID, AttemptID: second.AttemptID,
			LeaseID: second.LeaseID, FencingToken: second.FencingToken,
			Class: runnerstore.ProcessCrashed, ObservedAt: time.Now().UTC(),
		}); err != nil {
			t.Fatal(err)
		}
		var reconciliationID, reason string
		if err := pool.QueryRow(ctx, `SELECT reconciliation_id,reconciliation_reason FROM workflow_runner_authority_bindings WHERE binding_id=$1`, second.BindingID).Scan(&reconciliationID, &reason); err != nil {
			t.Fatal(err)
		}
		assertPhaseReasonRejected := func(view runnerstore.V2AuthorityBindingView, wrongReason string) {
			t.Helper()
			phaseTx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer phaseTx.Rollback(ctx)
			phaseReconciliationID := "reconciliation-phase-" + view.BindingID
			if _, err := phaseTx.Exec(ctx, `INSERT INTO workflow_runner_authority_reconciliations
(reconciliation_id,binding_id,workspace_id,job_id,attempt_id,reason,evidence_hash,created_at)
VALUES ($1,$2,$3,$4,$5,$6,decode(repeat('44',32),'hex'),clock_timestamp())`,
				phaseReconciliationID, view.BindingID, view.WorkspaceID, view.JobID, view.AttemptID, wrongReason); err != nil {
				t.Fatal(err)
			}
			if _, err := phaseTx.Exec(ctx, `UPDATE workflow_runner_authority_bindings
SET state='reconciliation_required',reconciliation_id=$2,reconciliation_reason=$3
WHERE binding_id=$1`, view.BindingID, phaseReconciliationID, wrongReason); err == nil {
				t.Fatalf("%s binding accepted cross-phase reconciliation reason %s", view.State, wrongReason)
			}
		}
		assertPhaseReasonRejected(first, "control_delivery_unknown")
		resolvedPhase := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-reconciliation-resolved-phase", nil, "resolved", "")
		assertPhaseReasonRejected(resolvedPhase, "stage_commit_unknown")
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, updateErr := tx.Exec(ctx, `UPDATE workflow_runner_authority_bindings
SET state='reconciliation_required',reconciliation_id=$2,reconciliation_reason=$3 WHERE binding_id=$1`,
			first.BindingID, reconciliationID, reason)
		commitErr := tx.Commit(ctx)
		if updateErr == nil && commitErr == nil {
			t.Fatal("binding accepted another binding's reconciliation identity/reason")
		}
		_ = tx.Rollback(ctx)
		if _, err := pool.Exec(ctx, `UPDATE workflow_runner_authority_bindings
SET resolution_idempotency_key='post-reconciliation-enrichment' WHERE binding_id=$1`, second.BindingID); err == nil {
			t.Fatal("reconciliation binding accepted post-write resolution enrichment")
		}
		if _, err := pool.Exec(ctx, `UPDATE workflow_runner_authority_bindings SET state='completed' WHERE binding_id=$1`, second.BindingID); err == nil {
			t.Fatal("reconciliation binding completed without returning to an authoritative state")
		}

		lateSource := exerciseGS9F2BindingLifecycleUntil(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-reconciliation-late-ack", nil, "runner_committed", "")
		lateLease, lateReceipt := gs9f2BoundControl(t, repository, lateSource, false)
		lateACK := prepareGS9F2ControlACK(t, repository, lateLease, lateSource.BindingID,
			runnerbindingcontract.OperationCheckpointCommit, lateReceipt, 3)
		if err := insertGS9F2ControlACKRow(t, repository, second.BindingID, lateACK, nil); err == nil {
			t.Fatal("reconciliation binding accepted a late control ACK")
		}

		completed := exerciseGS9F2BindingLifecycle(t, repository, runnerbindingcontract.OperationCheckpointCommit,
			"f2-guard-completed-late-ack")
		if err := insertGS9F2ControlACKRow(t, repository, completed.BindingID, lateACK, nil); err == nil {
			t.Fatal("completed binding accepted a late control ACK")
		}
	})
}

func runtimeAdmissionForLease(t testing.TB, lease runnerstore.AttemptLease, disposition string) runnerstore.PreparedV2RuntimeAdmission {
	t.Helper()
	prepared, err := runnerstore.PrepareV2RuntimeAdmission(runnerstore.V2RuntimeAdmission{
		Schema: runnerstore.V2RuntimeAdmissionSchema, WorkspaceID: lease.WorkspaceID,
		JobID: lease.JobID, WorkflowRunID: lease.WorkflowRunID, AttemptID: lease.AttemptID,
		LeaseID: lease.LeaseID, FencingToken: lease.FencingToken, JobSpecHash: lease.JobSpecHash,
		Disposition: disposition,
	})
	if err != nil {
		t.Fatal(err)
	}
	return prepared
}

func sealRuntimeAdmission(t testing.TB, repository *Repository, lease runnerstore.AttemptLease, disposition string) runnerstore.V2RuntimeAdmissionReceipt {
	t.Helper()
	prepared := runtimeAdmissionForLease(t, lease, disposition)
	receipt, err := repository.SealV2RuntimeAdmission(context.Background(), runnerstore.V2RuntimeAdmissionInput{
		WorkspaceID: lease.WorkspaceID, Prepared: prepared,
		IdempotencyKey: prepared.IdempotencyKey, RequestFingerprint: prepared.RequestFingerprint,
	})
	if err != nil {
		t.Fatal(err)
	}
	return receipt
}

func negotiateV2Lease(t testing.TB, repository *Repository, lease runnerstore.AttemptLease) {
	t.Helper()
	hello := v2Hello(lease)
	preparedHello, err := prepareV2Message(hello)
	if err != nil {
		t.Fatal(err)
	}
	negotiation, err := repository.RecordV2Negotiation(context.Background(), runnerstore.V2NegotiationInput{
		Lease: lease, Hello: hello, ExactBytes: []byte(preparedHello.Body),
		ControlBuildHash: lease.AuthorityRoute.AuthorityBuildHash, ExpectedRunnerBuildHash: stringsRepeat("e", 64),
		HeartbeatInterval: time.Second, LeaseOfferTimeout: 30 * time.Second, Now: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	deliverV2Control(t, repository, lease.AttemptID, negotiation.HelloAck.EventID, string(negotiation.HelloAck.Kind))
	deliverV2Control(t, repository, lease.AttemptID, lease.V2LeaseOffer.EventID, string(lease.V2LeaseOffer.Kind))
}

func stringsRepeat(value string, count int) string {
	result := make([]byte, count*len(value))
	for index := 0; index < count; index++ {
		copy(result[index*len(value):], value)
	}
	return string(result)
}
