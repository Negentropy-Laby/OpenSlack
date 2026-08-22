package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func TestGS9F1QualificationFoundation(t *testing.T) {
	marker, configured := os.LookupEnv("WORKFLOW_RUNNER_GS9F1_QUALIFICATION")
	if !configured || marker == "" {
		t.Skip("GS9-F1 qualification marker is not configured")
	}
	if marker != "1" {
		t.Fatalf("WORKFLOW_RUNNER_GS9F1_QUALIFICATION must be exactly 1, got %q", marker)
	}
	pool := openV2Postgres(t)
	ctx := t.Context()

	t.Run("accepted exact admission replay and no Go route", func(t *testing.T) {
		repository := New(pool)
		input := v2JobInput(t, "admission", "ts-local", "typescript")
		first, err := repository.SubmitV2(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		replay, err := repository.SubmitV2(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		if replay.Status != runnerstore.ReceiptAccepted || !replay.Replay || !bytes.Equal(first.ExactBytes, replay.ExactBytes) {
			t.Fatalf("v2 admission replay drifted: first=%+v replay=%+v", first, replay)
		}
		goInput := v2JobInput(t, "go-route", "go", "workflow-control")
		if _, err := repository.SubmitV2(ctx, goInput); !runnerstore.IsCode(err, runnerstore.ErrorAuthorityUnavailable) {
			t.Fatalf("F1 admitted Go authority: %v", err)
		}
		var rows int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runner_jobs WHERE job_id=$1`, goInput.Prepared.Spec.JobID).Scan(&rows); err != nil || rows != 0 {
			t.Fatalf("rejected Go route persisted rows=%d err=%v", rows, err)
		}
	})

	t.Run("v1 and v2 dispatch do not downgrade", func(t *testing.T) {
		repository := New(pool)
		workspace := "workspace-dispatch"
		v1 := jobInputForRun(t, "dispatch-v1", workspace, "job-dispatch-v1", "run-dispatch-v1")
		if _, err := repository.Submit(ctx, v1); err != nil {
			t.Fatal(err)
		}
		v2 := v2JobInputForWorkspace(t, "dispatch-v2", workspace, "ts-local", "typescript")
		if _, err := repository.SubmitV2(ctx, v2); err != nil {
			t.Fatal(err)
		}
		v1Claim := claimInput(workspace)
		v1Claim.ProtocolVersions = []string{runnerprotocol.ProtocolVersion}
		leaseV1, err := repository.ClaimNext(ctx, v1Claim)
		if err != nil || leaseV1.JobID != v1.Prepared.Spec.JobID || leaseV1.RequiredProtocolVersion != runnerprotocol.ProtocolVersion {
			t.Fatalf("v1 dispatch drifted: %+v %v", leaseV1, err)
		}
		v2Claim := claimInput(workspace)
		v2Claim.ProtocolVersions = []string{authoritycontract.ProtocolVersion}
		leaseV2, err := repository.ClaimNext(ctx, v2Claim)
		if err != nil || leaseV2.JobID != v2.Prepared.Spec.JobID || leaseV2.RequiredProtocolVersion != authoritycontract.ProtocolVersion {
			t.Fatalf("v2 dispatch drifted: %+v %v", leaseV2, err)
		}
		oldHello := v2Hello(leaseV2)
		oldHello.Payload["supportedProtocolVersions"] = []any{runnerprotocol.ProtocolVersion}
		if _, err := prepareV2Message(oldHello); err == nil {
			t.Fatal("v2-required lease accepted an old-worker hello downgrade")
		}
	})

	t.Run("authority response loss exact replay and receipt before decision", func(t *testing.T) {
		adapter := &budgetFoundationAdapter{failApplyResponse: true}
		repository := NewWithV2Authorities(pool, runnerstore.V2AuthorityPorts{Budget: adapter})
		lease := startV2Lease(t, repository, "budget-order")
		budget := v2BudgetReserve(t, lease, 2, "event-budget-order")
		recorded, err := repository.RecordV2Event(ctx, budget)
		if err != nil {
			t.Fatal(err)
		}
		if adapter.applyCalls != 1 || adapter.readCalls != 1 || recorded.Decision == nil {
			t.Fatalf("authority response loss was not point-read: apply=%d read=%d result=%+v", adapter.applyCalls, adapter.readCalls, recorded)
		}
		if err := repository.MarkV2ControlDeliveryStarted(ctx, lease.AttemptID, recorded.Decision.EventID, string(recorded.Decision.Kind), time.Now()); !runnerstore.IsCode(err, runnerstore.ErrorSequenceConflict) {
			t.Fatalf("decision overtook receipt: %v", err)
		}
		deliverV2Control(t, repository, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind))
		deliverV2Control(t, repository, lease.AttemptID, recorded.Decision.EventID, string(recorded.Decision.Kind))
		replay, err := repository.RecordV2Event(ctx, budget)
		if err != nil || !replay.Duplicate || !bytes.Equal(replay.ReceiptBytes, recorded.ReceiptBytes) || !bytes.Equal(replay.DecisionBytes, recorded.DecisionBytes) || adapter.applyCalls != 1 {
			t.Fatalf("finalized exact replay called authority or drifted: %+v %v", replay, err)
		}
		conflict := budget
		conflict.Message.Payload["requestedTokens"] = "2"
		prepared, prepareErr := prepareV2Message(conflict.Message)
		if prepareErr != nil {
			t.Fatal(prepareErr)
		}
		conflict.ExactBytes = []byte(prepared.Body)
		if _, err := repository.RecordV2Event(ctx, conflict); !runnerstore.IsCode(err, runnerstore.ErrorIdempotencyConflict) || adapter.applyCalls != 1 {
			t.Fatalf("eventId conflict reached authority: calls=%d err=%v", adapter.applyCalls, err)
		}
	})

	t.Run("budget authority binds durable and runner revision planes independently", func(t *testing.T) {
		zeroOffset := int64(0)
		for _, test := range []struct {
			name                    string
			adapter                 *budgetFoundationAdapter
			wantAuthorityBindingErr bool
		}{
			{name: "distinct revisions", adapter: &budgetFoundationAdapter{}},
			{name: "coincident revisions", adapter: &budgetFoundationAdapter{sourceRevisionOffset: &zeroOffset}},
			{name: "committed revision drift", adapter: &budgetFoundationAdapter{committedRevisionDelta: 1}, wantAuthorityBindingErr: true},
			{name: "receipt hash drift", adapter: &budgetFoundationAdapter{driftReceiptHash: true}, wantAuthorityBindingErr: true},
			{name: "receipt operation drift", adapter: &budgetFoundationAdapter{driftReceiptOperation: true}, wantAuthorityBindingErr: true},
			{name: "receipt status drift", adapter: &budgetFoundationAdapter{driftReceiptStatus: true}, wantAuthorityBindingErr: true},
			{name: "receipt reservation drift", adapter: &budgetFoundationAdapter{driftReceiptReservation: true}, wantAuthorityBindingErr: true},
		} {
			t.Run(test.name, func(t *testing.T) {
				repository := NewWithV2Authorities(pool, runnerstore.V2AuthorityPorts{Budget: test.adapter})
				lease := startV2Lease(t, repository, "budget-planes-"+strings.ReplaceAll(test.name, " ", "-"))
				budget := v2BudgetReserve(t, lease, 2, "event-budget-planes-"+strings.ReplaceAll(test.name, " ", "-"))
				recorded, err := repository.RecordV2Event(ctx, budget)
				if test.wantAuthorityBindingErr {
					if !runnerstore.IsCode(err, runnerstore.ErrorAuthorityBinding) {
						t.Fatalf("drifted budget binding was not rejected: %v", err)
					}
					return
				}
				if err != nil || recorded.Decision == nil {
					t.Fatalf("valid budget revision planes were rejected: %+v %v", recorded, err)
				}
				payload := recorded.Decision.Payload
				committedRevision, ok := payload["committedRunRevision"].(int64)
				if !ok {
					t.Fatalf("budget committed revision is not int64: %T", payload["committedRunRevision"])
				}
				if test.adapter.sourceRevisionOffset == nil && committedRevision == *recorded.Decision.RunRevision {
					t.Fatal("independent budget fixture accidentally conflated its revision planes")
				}
				if test.adapter.sourceRevisionOffset != nil && committedRevision != *recorded.Decision.RunRevision {
					t.Fatal("coincident revision values were rejected as if equality were forbidden")
				}
			})
		}
	})

	t.Run("cancel cannot overtake or split an event control lane", func(t *testing.T) {
		repository := New(pool)
		lease := startV2Lease(t, repository, "cancel-order")
		now := time.Now().UTC().Truncate(time.Millisecond)
		cancelInput := runnerstore.CancelInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, CorrelationID: lease.CorrelationID,
			ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken,
			Reason: "operator", Now: now, ExpiresAt: now.Add(time.Minute)}
		cancelInput.IdempotencyKey, cancelInput.RequestFingerprint, _ = runnerstore.CancelBindings(cancelInput)
		control, err := repository.RequestCancel(ctx, cancelInput)
		if err != nil {
			t.Fatal(err)
		}
		wrapped, err := repository.PrepareV2Cancel(ctx, lease, control)
		if err != nil || wrapped.Message.Kind != authoritycontract.KindCancelRequest || wrapped.Message.Payload["cancelId"] != control.CancelID {
			t.Fatalf("v2 cancel wrapper drifted: %+v %v", wrapped, err)
		}
		heartbeat := v2Heartbeat(t, lease, 2, "event-heartbeat-after-cancel")
		recorded, err := repository.RecordV2Event(ctx, heartbeat)
		if err != nil {
			t.Fatal(err)
		}
		if err := repository.MarkV2ControlDeliveryStarted(ctx, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind), now); !runnerstore.IsCode(err, runnerstore.ErrorSequenceConflict) {
			t.Fatalf("receipt overtook lower cancel: %v", err)
		}
		deliverV2Control(t, repository, lease.AttemptID, wrapped.Message.EventID, string(wrapped.Message.Kind))
		deliverV2Control(t, repository, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind))
	})

	t.Run("cancel cannot synthesize clearance for an unresolved authority event", func(t *testing.T) {
		adapter := &budgetFoundationAdapter{failApplyResponse: true, failRead: true}
		repository := NewWithV2Authorities(pool, runnerstore.V2AuthorityPorts{Budget: adapter})
		lease := startV2Lease(t, repository, "cancel-unresolved-authority")
		budget := v2BudgetReserve(t, lease, 2, "event-budget-unresolved")
		if _, err := repository.RecordV2Event(ctx, budget); !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
			t.Fatalf("unproven authority result was not latched for recovery: %v", err)
		}

		now := time.Now().UTC().Truncate(time.Millisecond)
		cancelInput := runnerstore.CancelInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, CorrelationID: lease.CorrelationID,
			ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken,
			Reason: "operator", Now: now, ExpiresAt: now.Add(time.Minute)}
		cancelInput.IdempotencyKey, cancelInput.RequestFingerprint, _ = runnerstore.CancelBindings(cancelInput)
		if _, err := repository.RequestCancel(ctx, cancelInput); !runnerstore.IsCode(err, runnerstore.ErrorConflict) ||
			err.Error() != "WORKFLOW_RUNNER_CONFLICT: v2 cancellation is blocked by an unsettled authority event" {
			t.Fatalf("cancellation forged authority clearance or changed its stable diagnostic: %v", err)
		}

		var inboxState string
		var cancelRows int
		if err := pool.QueryRow(ctx, `SELECT state FROM workflow_runner_v2_event_inbox WHERE event_id=$1`, budget.Message.EventID).Scan(&inboxState); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM workflow_runner_cancel_controls WHERE attempt_id=$1`, lease.AttemptID).Scan(&cancelRows); err != nil {
			t.Fatal(err)
		}
		if inboxState != "pending_authority" || cancelRows != 0 {
			t.Fatalf("blocked cancellation mutated recovery evidence: state=%s cancelRows=%d", inboxState, cancelRows)
		}
	})

	t.Run("operation-specific revision and generation transitions are database enforced", func(t *testing.T) {
		repository := New(pool)
		valid := []struct {
			name                      string
			operation                 string
			runDelta, generationDelta int64
		}{
			{name: "checkpoint observer", operation: "checkpoint_commit"},
			{name: "effect grant", operation: "effect_authorize"},
			{name: "budget authority", operation: "budget_reserve", runDelta: 1},
			{name: "resume authority", operation: "resume_advance", runDelta: 1, generationDelta: 1},
		}
		for index, test := range valid {
			lease := startV2Lease(t, repository, fmt.Sprintf("binding-valid-%d", index))
			if _, err := pool.Exec(ctx, `UPDATE workflow_runner_v2_attempt_bindings
SET current_run_revision=current_run_revision+$2,
    current_resume_generation=current_resume_generation+$3,
    last_authority_operation=$4,last_authority_event_id=$5
WHERE attempt_id=$1`, lease.AttemptID, test.runDelta, test.generationDelta, test.operation, "event-binding-valid-"+fmt.Sprint(index)); err != nil {
				t.Fatalf("%s transition rejected: %v", test.name, err)
			}
		}
		invalid := []struct {
			operation                 string
			runDelta, generationDelta int64
		}{
			{operation: "checkpoint_commit", runDelta: 1},
			{operation: "effect_authorize", generationDelta: 1},
			{operation: "budget_settle"},
			{operation: "resume_advance", runDelta: 1},
		}
		for index, test := range invalid {
			lease := startV2Lease(t, repository, fmt.Sprintf("binding-invalid-%d", index))
			if _, err := pool.Exec(ctx, `UPDATE workflow_runner_v2_attempt_bindings
SET current_run_revision=current_run_revision+$2,
    current_resume_generation=current_resume_generation+$3,
    last_authority_operation=$4,last_authority_event_id=$5
WHERE attempt_id=$1`, lease.AttemptID, test.runDelta, test.generationDelta, test.operation, "event-binding-invalid-"+fmt.Sprint(index)); err == nil {
				t.Fatalf("invalid %s transition was accepted", test.operation)
			}
		}
	})

	t.Run("stored replay rejects canonical and scalar cross-splice", func(t *testing.T) {
		adapter := &budgetFoundationAdapter{}
		repository := NewWithV2Authorities(pool, runnerstore.V2AuthorityPorts{Budget: adapter})
		create := func(suffix string) (runnerstore.V2RecordEventInput, runnerstore.V2RecordedEvent) {
			t.Helper()
			lease := startV2Lease(t, repository, "stored-replay-"+suffix)
			event := v2BudgetReserve(t, lease, 2, "event-stored-replay-"+suffix)
			recorded, err := repository.RecordV2Event(ctx, event)
			if err != nil || recorded.Decision == nil {
				t.Fatalf("create stored replay fixture %s: %+v %v", suffix, recorded, err)
			}
			return event, recorded
		}
		sourceEvent, source := create("source")
		_ = sourceEvent
		assertRejected := func(event runnerstore.V2RecordEventInput) {
			t.Helper()
			if _, err := repository.RecordV2Event(ctx, event); err == nil ||
				(!runnerstore.IsCode(err, runnerstore.ErrorReconciliation) && !runnerstore.IsCode(err, runnerstore.ErrorIdempotencyConflict)) {
				t.Fatalf("corrupt stored replay was accepted: %v", err)
			}
		}

		noncanonicalEvent, noncanonical := create("noncanonical-receipt")
		if _, err := pool.Exec(ctx, `ALTER TABLE workflow_runner_event_receipts DISABLE TRIGGER workflow_runner_event_receipts_immutable;
UPDATE workflow_runner_event_receipts SET exact_receipt_bytes=exact_receipt_bytes || convert_to(' ','UTF8') WHERE received_event_id=$1;
ALTER TABLE workflow_runner_event_receipts ENABLE TRIGGER workflow_runner_event_receipts_immutable;
UPDATE workflow_runner_control_messages SET exact_message_bytes=exact_message_bytes || convert_to(' ','UTF8') WHERE control_event_id=$2`, noncanonicalEvent.Message.EventID, noncanonical.Receipt.EventID); err != nil {
			t.Fatal(err)
		}
		assertRejected(noncanonicalEvent)

		otherReceiptEvent, otherReceipt := create("other-receipt")
		if _, err := pool.Exec(ctx, `ALTER TABLE workflow_runner_event_receipts DISABLE TRIGGER workflow_runner_event_receipts_immutable;
UPDATE workflow_runner_event_receipts target SET exact_receipt_bytes=source.exact_receipt_bytes,receipt_digest=source.receipt_digest
FROM workflow_runner_event_receipts source WHERE target.received_event_id=$1 AND source.received_event_id=$2;
ALTER TABLE workflow_runner_event_receipts ENABLE TRIGGER workflow_runner_event_receipts_immutable;
UPDATE workflow_runner_control_messages target SET exact_message_bytes=source.exact_message_bytes,message_digest=source.message_digest
FROM workflow_runner_control_messages source WHERE target.control_event_id=$3 AND source.control_event_id=$4`, otherReceiptEvent.Message.EventID,
			sourceEvent.Message.EventID, otherReceipt.Receipt.EventID, source.Receipt.EventID); err != nil {
			t.Fatal(err)
		}
		assertRejected(otherReceiptEvent)

		otherDecisionEvent, otherDecision := create("other-decision")
		if _, err := pool.Exec(ctx, `UPDATE workflow_runner_control_messages target SET exact_message_bytes=source.exact_message_bytes,message_digest=source.message_digest
FROM workflow_runner_control_messages source WHERE target.control_event_id=$1 AND source.control_event_id=$2`, otherDecision.Decision.EventID, source.Decision.EventID); err != nil {
			t.Fatal(err)
		}
		assertRejected(otherDecisionEvent)

		hashEvent, _ := create("authority-hash")
		if _, err := pool.Exec(ctx, `ALTER TABLE workflow_runner_v2_decision_bindings DISABLE TRIGGER workflow_runner_v2_decision_bindings_immutable;
UPDATE workflow_runner_v2_decision_bindings SET authority_receipt_hash=decode(repeat('ff',32),'hex') WHERE received_event_id=$1;
ALTER TABLE workflow_runner_v2_decision_bindings ENABLE TRIGGER workflow_runner_v2_decision_bindings_immutable`, hashEvent.Message.EventID); err != nil {
			t.Fatal(err)
		}
		assertRejected(hashEvent)

		digestEvent, _ := create("event-digest")
		if _, err := pool.Exec(ctx, `ALTER TABLE workflow_runner_worker_events DISABLE TRIGGER workflow_runner_worker_events_immutable;
UPDATE workflow_runner_worker_events SET message_digest=decode(repeat('ff',32),'hex') WHERE event_id=$1;
ALTER TABLE workflow_runner_worker_events ENABLE TRIGGER workflow_runner_worker_events_immutable`, digestEvent.Message.EventID); err != nil {
			t.Fatal(err)
		}
		assertRejected(digestEvent)

		controlBuildEvent, _ := create("control-build")
		if _, err := pool.Exec(ctx, `UPDATE workflow_runner_process_sessions SET control_build_hash=decode(repeat('ee',32),'hex') WHERE attempt_id=$1`, *controlBuildEvent.Message.AttemptID); err != nil {
			t.Fatal(err)
		}
		assertRejected(controlBuildEvent)
	})
}

func TestGS9F1RestartFoundation(t *testing.T) {
	if phase := strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS9F1_RESTART_PHASE")); phase != "" {
		runGS9F1PersistentRestart(t, phase, strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS9F1_RESTART_SCHEMA")))
		return
	}
	pool := openV2Postgres(t)
	ctx := t.Context()

	t.Run("missing operation authority cannot retry", func(t *testing.T) {
		repository := New(pool)
		lease := startV2Lease(t, repository, "no-port")
		checkpoint := v2Checkpoint(t, lease, 2, "event-checkpoint-no-port")
		if _, err := repository.RecordV2Event(ctx, checkpoint); !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
			t.Fatalf("missing authority port did not fail closed: %v", err)
		}
		view, err := repository.RecordProcessExit(ctx, runnerstore.ProcessExitInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID,
			AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken,
			Class: runnerstore.ProcessForced, ObservedAt: time.Now().UTC()})
		if err != nil || view.State != runnerstore.JobReconciliationRequired {
			t.Fatalf("staged no-port event became retryable: %+v %v", view, err)
		}
	})

	t.Run("authority commit followed by binding loss stays reconciliation", func(t *testing.T) {
		adapter := &checkpointCASLossAdapter{pool: pool}
		repository := NewWithV2Authorities(pool, runnerstore.V2AuthorityPorts{Checkpoint: adapter})
		lease := startV2Lease(t, repository, "cas-loss")
		checkpoint := v2Checkpoint(t, lease, 2, "event-checkpoint-cas-loss")
		if _, err := repository.RecordV2Event(ctx, checkpoint); !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
			t.Fatalf("authority/CAS loss was not reconciliation: %v", err)
		}
		view, err := repository.RecordProcessExit(ctx, runnerstore.ProcessExitInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID,
			AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken,
			Class: runnerstore.ProcessCrashed, ObservedAt: time.Now().UTC()})
		if err != nil || view.State != runnerstore.JobReconciliationRequired {
			t.Fatalf("authority committed evidence was overwritten by process failure: %+v %v", view, err)
		}
	})

	t.Run("uncertain receipt delivery cannot retry", func(t *testing.T) {
		repository := New(pool)
		lease, accept := createV2LeaseAccept(t, repository, "delivery-loss")
		if err := repository.MarkV2ControlDeliveryStarted(ctx, lease.AttemptID, accept.Receipt.EventID, string(accept.Receipt.Kind), time.Now()); err != nil {
			t.Fatal(err)
		}
		if err := repository.MarkV2ControlDeliveryReconciliation(ctx, lease.AttemptID, accept.Receipt.EventID, string(accept.Receipt.Kind), time.Now()); err != nil {
			t.Fatal(err)
		}
		assertV2ProcessExitReconciliation(t, repository, lease)
	})

	t.Run("uncertain authority receipt and decision delivery cannot retry", func(t *testing.T) {
		for _, decisionLoss := range []bool{false, true} {
			adapter := &budgetFoundationAdapter{}
			repository := NewWithV2Authorities(pool, runnerstore.V2AuthorityPorts{Budget: adapter})
			lease := startV2Lease(t, repository, fmt.Sprintf("authority-delivery-loss-%v", decisionLoss))
			recorded, err := repository.RecordV2Event(ctx, v2BudgetReserve(t, lease, 2, "event-authority-delivery-loss-"+fmt.Sprint(decisionLoss)))
			if err != nil || recorded.Decision == nil {
				t.Fatalf("record authority event: %+v %v", recorded, err)
			}
			if decisionLoss {
				deliverV2Control(t, repository, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind))
				if err := repository.MarkV2ControlDeliveryStarted(ctx, lease.AttemptID, recorded.Decision.EventID, string(recorded.Decision.Kind), time.Now()); err != nil {
					t.Fatal(err)
				}
				if err := repository.MarkV2ControlDeliveryReconciliation(ctx, lease.AttemptID, recorded.Decision.EventID, string(recorded.Decision.Kind), time.Now()); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := repository.MarkV2ControlDeliveryStarted(ctx, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind), time.Now()); err != nil {
					t.Fatal(err)
				}
				if err := repository.MarkV2ControlDeliveryReconciliation(ctx, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind), time.Now()); err != nil {
					t.Fatal(err)
				}
			}
			assertV2ProcessExitReconciliation(t, repository, lease)
		}
	})

	t.Run("uncertain terminal receipt delivery preserves the receipt-proven terminal", func(t *testing.T) {
		repository := New(pool)
		lease := startV2Lease(t, repository, "terminal-delivery-loss")
		finishedAt := canonicalNow()
		terminal := v2LeasedEventAt(t, lease, authoritycontract.KindTerminal, 2, "event-terminal-delivery-loss", lease.RunRevision, lease.ResumeGeneration, finishedAt,
			map[string]any{"status": "completed", "finishedAt": finishedAt, "resultHash": strings.Repeat("9", 64), "terminalReason": nil})
		recorded, err := repository.RecordV2Event(ctx, terminal)
		if err != nil || recorded.JobState != runnerstore.JobTerminal {
			t.Fatalf("record terminal event: %+v %v", recorded, err)
		}
		if err := repository.MarkV2ControlDeliveryStarted(ctx, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind), time.Now()); err != nil {
			t.Fatal(err)
		}
		if err := repository.MarkV2ControlDeliveryReconciliation(ctx, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind), time.Now()); err != nil {
			t.Fatal(err)
		}
		view, err := repository.RecordProcessExit(ctx, runnerstore.ProcessExitInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID,
			AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken,
			Class: runnerstore.ProcessCrashed, ObservedAt: time.Now().UTC()})
		if err != nil || view.State != runnerstore.JobTerminal || view.TerminalStatus == nil || *view.TerminalStatus != runnerprotocol.TerminalCompleted {
			t.Fatalf("receipt-proven terminal was overwritten by transport uncertainty: %+v %v", view, err)
		}
	})

	t.Run("down migration refuses durable v2 evidence", func(t *testing.T) {
		contents, err := os.ReadFile(v2MigrationPath(t, "000007_integrate_workflow_runner_v2.down.sql"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(contents)); err == nil {
			t.Fatal("000007 down migration removed durable v2 evidence")
		}
		var stillPresent bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass('workflow_runner_v2_event_inbox') IS NOT NULL`).Scan(&stillPresent); err != nil || !stillPresent {
			t.Fatalf("failed down migration did not roll back atomically: present=%v err=%v", stillPresent, err)
		}
	})
}

type v2ReplayQueryTracer struct{ count atomic.Int64 }

func (tracer *v2ReplayQueryTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if strings.Contains(data.SQL, "FROM workflow_runner_worker_events e") {
		tracer.count.Add(1)
	}
	return ctx
}

func (*v2ReplayQueryTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestGS9F1EventReplayQueriesAreBounded(t *testing.T) {
	tracer := &v2ReplayQueryTracer{}
	pool := testsupport.OpenPostgresWithTracer(t, tracer)
	repository := NewWithV2Authorities(pool, runnerstore.V2AuthorityPorts{Budget: &budgetFoundationAdapter{}})
	lease := startV2Lease(t, repository, "bounded-replay-query")
	event := v2BudgetReserve(t, lease, 2, "event-bounded-replay-query")

	tracer.count.Store(0)
	first, err := repository.RecordV2Event(t.Context(), event)
	if err != nil || first.Duplicate || tracer.count.Load() != 2 {
		t.Fatalf("fresh authority event replay-query count drifted: count=%d result=%+v err=%v", tracer.count.Load(), first, err)
	}
	tracer.count.Store(0)
	replay, err := repository.RecordV2Event(t.Context(), event)
	if err != nil || !replay.Duplicate || tracer.count.Load() != 1 {
		t.Fatalf("exact replay query count drifted: count=%d result=%+v err=%v", tracer.count.Load(), replay, err)
	}
}

func TestGS9F1SchemaSevenDoesNotSilentlySkipMissingV2Tables(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := NewForSchema(pool, 7)
	lease := startV2Lease(t, repository, "missing-v2-table")
	if _, err := pool.Exec(t.Context(), `DROP TABLE workflow_runner_v2_event_inbox CASCADE`); err != nil {
		t.Fatal(err)
	}
	_, err := repository.RecordProcessExit(t.Context(), runnerstore.ProcessExitInput{
		WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, AttemptID: lease.AttemptID,
		LeaseID: lease.LeaseID, FencingToken: lease.FencingToken,
		Class: runnerstore.ProcessCrashed, ObservedAt: time.Now().UTC(),
	})
	if !runnerstore.IsCode(err, runnerstore.ErrorDatabase) {
		t.Fatalf("schema 7 silently skipped a missing v2 table: %v", err)
	}
}

func assertV2ProcessExitReconciliation(t testing.TB, repository *Repository, lease runnerstore.AttemptLease) {
	t.Helper()
	view, err := repository.RecordProcessExit(context.Background(), runnerstore.ProcessExitInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID,
		AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken,
		Class: runnerstore.ProcessCrashed, ObservedAt: time.Now().UTC()})
	if err != nil || view.State != runnerstore.JobReconciliationRequired {
		t.Fatalf("uncertain v2 delivery became ordinary failure: %+v %v", view, err)
	}
}

func TestGS9F1ImageDefaultOff(t *testing.T) {
	origin := strings.TrimRight(strings.TrimSpace(os.Getenv("WORKFLOW_RUNNER_GS9F1_DEFAULT_ORIGIN")), "/")
	if origin == "" {
		t.Skip("GS9-F1 default image origin is not configured")
	}
	client := &http.Client{Timeout: 5 * time.Second}
	request := func(method, path string, body io.Reader) (int, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), method, origin+path, body)
		if err != nil {
			t.Fatal(err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		contents, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, contents
	}
	versionStatus, versionBody := request(http.MethodGet, "/health/version", nil)
	v2Status, v2Body := request(http.MethodPost, "/v2/runner/jobs", strings.NewReader("{}\n"))
	if versionStatus != http.StatusOK || !bytes.Contains(versionBody, []byte(`"mode":"shadow-only"`)) ||
		bytes.Contains(versionBody, []byte("runner-control-v2-qualification")) || v2Status != http.StatusNotFound {
		t.Fatalf("default image v2 gate drifted: version=%d %s v2=%d %s", versionStatus, versionBody, v2Status, v2Body)
	}
	if authoritycontract.HasDurableAuthority() {
		t.Fatal("Go authority unexpectedly activated")
	}
}

func runGS9F1PersistentRestart(t *testing.T, phase, schema string) {
	t.Helper()
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		if _, err := pool.Exec(t.Context(), `CREATE TABLE gs9f1_restart_qualification (
fixture TEXT PRIMARY KEY,postmaster_started_at TIMESTAMPTZ NOT NULL,workspace_id TEXT NOT NULL,
job_id TEXT NOT NULL,attempt_id TEXT NOT NULL,lease_id TEXT NOT NULL,fence BIGINT NOT NULL,
exact_event_bytes BYTEA,receipt_event_id TEXT,decision_event_id TEXT
)`); err != nil {
			t.Fatal(err)
		}
		adapter := &budgetFoundationAdapter{}
		repository := NewWithV2Authorities(pool, runnerstore.V2AuthorityPorts{Budget: adapter})
		replayLease := startV2Lease(t, repository, "restart-replay-delivery")
		event := v2BudgetReserve(t, replayLease, 2, "event-restart-replay-delivery")
		recorded, err := repository.RecordV2Event(t.Context(), event)
		if err != nil || recorded.Decision == nil {
			t.Fatalf("seed durable v2 authority event: %+v %v", recorded, err)
		}
		if err := repository.MarkV2ControlDeliveryStarted(t.Context(), replayLease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind), time.Now()); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(t.Context(), `INSERT INTO gs9f1_restart_qualification
(fixture,postmaster_started_at,workspace_id,job_id,attempt_id,lease_id,fence,exact_event_bytes,receipt_event_id,decision_event_id)
VALUES ('replay-delivery',pg_postmaster_start_time(),$1,$2,$3,$4,$5,$6,$7,$8)`, replayLease.WorkspaceID, replayLease.JobID,
			replayLease.AttemptID, replayLease.LeaseID, replayLease.FencingToken, event.ExactBytes, recorded.Receipt.EventID, recorded.Decision.EventID); err != nil {
			t.Fatal(err)
		}

		noPortRepository := New(pool)
		noPortLease := startV2Lease(t, noPortRepository, "restart-no-port")
		checkpoint := v2Checkpoint(t, noPortLease, 2, "event-restart-no-port")
		if _, err := noPortRepository.RecordV2Event(t.Context(), checkpoint); !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
			t.Fatalf("seed no-port reconciliation latch: %v", err)
		}
		if _, err := pool.Exec(t.Context(), `INSERT INTO gs9f1_restart_qualification
(fixture,postmaster_started_at,workspace_id,job_id,attempt_id,lease_id,fence)
VALUES ('no-port',pg_postmaster_start_time(),$1,$2,$3,$4,$5)`, noPortLease.WorkspaceID, noPortLease.JobID,
			noPortLease.AttemptID, noPortLease.LeaseID, noPortLease.FencingToken); err != nil {
			t.Fatal(err)
		}
		pool.Close()
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		var seededPostmaster, currentPostmaster time.Time
		if err := pool.QueryRow(t.Context(), `SELECT postmaster_started_at FROM gs9f1_restart_qualification WHERE fixture='replay-delivery'`).Scan(&seededPostmaster); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(t.Context(), `SELECT pg_postmaster_start_time()`).Scan(&currentPostmaster); err != nil {
			t.Fatal(err)
		}
		if currentPostmaster.Equal(seededPostmaster) {
			t.Fatalf("GS9-F1 restart verification did not cross a PostgreSQL restart: %s", currentPostmaster)
		}
		type fixture struct {
			workspaceID, jobID, attemptID, leaseID string
			fence                                  int64
			exactEvent                             []byte
			receiptEventID, decisionEventID        *string
		}
		readFixture := func(name string) fixture {
			t.Helper()
			var value fixture
			if err := pool.QueryRow(t.Context(), `SELECT workspace_id,job_id,attempt_id,lease_id,fence,exact_event_bytes,receipt_event_id,decision_event_id
FROM gs9f1_restart_qualification WHERE fixture=$1`, name).Scan(&value.workspaceID, &value.jobID, &value.attemptID, &value.leaseID,
				&value.fence, &value.exactEvent, &value.receiptEventID, &value.decisionEventID); err != nil {
				t.Fatal(err)
			}
			return value
		}
		replayFixture := readFixture("replay-delivery")
		message, err := authoritycontract.DecodeMessageJSON(replayFixture.exactEvent)
		if err != nil {
			t.Fatal(err)
		}
		repository := New(pool)
		replayed, err := repository.RecordV2Event(t.Context(), runnerstore.V2RecordEventInput{Message: message, ExactBytes: replayFixture.exactEvent,
			ControlBuildHash: strings.Repeat("f", 64), Now: time.Now().UTC()})
		if err != nil || !replayed.Duplicate || replayed.Decision == nil {
			t.Fatalf("post-restart exact event point-read failed: %+v %v", replayed, err)
		}
		if err := repository.MarkV2ControlDeliveryStarted(t.Context(), replayFixture.attemptID, *replayFixture.decisionEventID,
			string(replayed.Decision.Kind), time.Now()); !runnerstore.IsCode(err, runnerstore.ErrorSequenceConflict) {
			t.Fatalf("post-restart decision overtook uncertain receipt: %v", err)
		}
		if err := repository.MarkV2ControlDeliveryReconciliation(t.Context(), replayFixture.attemptID, *replayFixture.receiptEventID,
			string(replayed.Receipt.Kind), time.Now()); err != nil {
			t.Fatal(err)
		}
		assertV2ProcessExitReconciliation(t, repository, runnerstore.AttemptLease{WorkspaceID: replayFixture.workspaceID, JobID: replayFixture.jobID,
			AttemptID: replayFixture.attemptID, LeaseID: replayFixture.leaseID, FencingToken: replayFixture.fence})
		noPort := readFixture("no-port")
		assertV2ProcessExitReconciliation(t, repository, runnerstore.AttemptLease{WorkspaceID: noPort.workspaceID, JobID: noPort.jobID,
			AttemptID: noPort.attemptID, LeaseID: noPort.leaseID, FencingToken: noPort.fence})
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown GS9-F1 restart phase %q", phase)
	}
}

func openV2Postgres(t testing.TB) *pgxpool.Pool {
	t.Helper()
	pool := testsupport.OpenPostgres(t)
	var exists bool
	if err := pool.QueryRow(context.Background(), `SELECT to_regclass('workflow_runner_v2_event_inbox') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		return pool
	}
	path := v2MigrationPath(t, "000007_integrate_workflow_runner_v2.up.sql")
	contents, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), string(contents)); err != nil {
		t.Fatalf("apply 000007: %v", err)
	}
	return pool
}

func v2MigrationPath(t testing.TB, name string) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve v2 test migration")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "migrations", name)
}

func v2JobInput(t testing.TB, suffix, backend, authority string) runnerstore.V2SubmitInput {
	t.Helper()
	return v2JobInputForWorkspace(t, suffix, "workspace-"+suffix, backend, authority)
}

func v2JobInputForWorkspace(t testing.TB, suffix, workspace, backend, authority string) runnerstore.V2SubmitInput {
	t.Helper()
	prepared, err := runnerstore.PrepareV2JobSpec(runnerstore.V2JobSpec{
		Schema: runnerstore.V2JobSpecSchema, WorkspaceID: workspace, JobID: "job-" + suffix, WorkflowRunID: "run-" + suffix,
		CorrelationID: "correlation-" + suffix, ExecutionDescriptorRef: "descriptor-" + suffix,
		ExecutionDescriptorHash: strings.Repeat("1", 64), WorkflowID: "workflow-" + suffix, WorkflowVersion: "1.0.0",
		WorkflowSourceHash: strings.Repeat("2", 64), ManifestHash: strings.Repeat("3", 64), InputHash: strings.Repeat("4", 64),
		WholeTimeoutMS: time.Hour.Milliseconds(), SubmittedAt: runnerstore.CanonicalTimestamp(time.Now().UTC()),
		RequiredProtocolVersion: authoritycontract.ProtocolVersion, RequiredCapabilities: runnerstore.V2RequiredCapabilities(),
		AuthorityRoute: authoritycontract.Route{Backend: backend, Authority: authority, RoutingEpoch: 1, AuthorityBuildHash: strings.Repeat("5", 64)},
		RunRevision:    1, ResumeGeneration: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	key, fingerprint := runnerstore.V2SubmissionBindings(prepared)
	return runnerstore.V2SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint}
}

func claimV2(t testing.TB, repository *Repository, input runnerstore.V2SubmitInput) runnerstore.AttemptLease {
	t.Helper()
	if _, err := repository.SubmitV2(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	claim := claimInput(input.Prepared.Spec.WorkspaceID)
	claim.ProtocolVersions = []string{authoritycontract.ProtocolVersion}
	lease, err := repository.ClaimNext(context.Background(), claim)
	if err != nil {
		t.Fatal(err)
	}
	return lease
}

func startV2Lease(t testing.TB, repository *Repository, suffix string) runnerstore.AttemptLease {
	t.Helper()
	lease, accept := createV2LeaseAccept(t, repository, suffix)
	deliverV2Control(t, repository, lease.AttemptID, accept.Receipt.EventID, string(accept.Receipt.Kind))
	return lease
}

func createV2LeaseAccept(t testing.TB, repository *Repository, suffix string) (runnerstore.AttemptLease, runnerstore.V2RecordedEvent) {
	t.Helper()
	lease := claimV2(t, repository, v2JobInput(t, suffix, "ts-local", "typescript"))
	hello := v2Hello(lease)
	preparedHello, err := prepareV2Message(hello)
	if err != nil {
		t.Fatal(err)
	}
	negotiation, err := repository.RecordV2Negotiation(context.Background(), runnerstore.V2NegotiationInput{Lease: lease, Hello: hello,
		ExactBytes: []byte(preparedHello.Body), ControlBuildHash: strings.Repeat("f", 64), ExpectedRunnerBuildHash: strings.Repeat("e", 64),
		HeartbeatInterval: time.Second, LeaseOfferTimeout: 30 * time.Second, Now: time.Now().UTC()})
	if err != nil {
		t.Fatal(err)
	}
	deliverV2Control(t, repository, lease.AttemptID, negotiation.HelloAck.EventID, string(negotiation.HelloAck.Kind))
	deliverV2Control(t, repository, lease.AttemptID, lease.V2LeaseOffer.EventID, string(lease.V2LeaseOffer.Kind))
	acceptedAt := canonicalNow()
	accept := v2LeasedEventAt(t, lease, authoritycontract.KindLeaseAccept, 1, "event-accept-"+suffix, lease.RunRevision, lease.ResumeGeneration,
		acceptedAt, map[string]any{"acceptedAt": acceptedAt, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)})
	recorded, err := repository.RecordV2Event(context.Background(), accept)
	if err != nil {
		t.Fatal(err)
	}
	return lease, recorded
}

func v2Hello(lease runnerstore.AttemptLease) authoritycontract.Message {
	return authoritycontract.Message{Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion,
		Kind: authoritycontract.KindHello, WorkspaceID: lease.WorkspaceID, EventID: "hello-" + lease.JobID,
		CorrelationID: lease.CorrelationID, SentAt: canonicalNow(), Payload: map[string]any{
			"runtimeName": "node", "runtimeVersion": "22.14.0", "runnerBuildHash": strings.Repeat("e", 64),
			"supportedProtocolVersions": []any{runnerprotocol.ProtocolVersion, authoritycontract.ProtocolVersion},
			"capabilities":              []any{"cancel_ack", "effect_receipts", "lease_heartbeat"}, "maxConcurrentJobs": int64(1),
		}}
}

func v2Checkpoint(t testing.TB, lease runnerstore.AttemptLease, sequence int64, eventID string) runnerstore.V2RecordEventInput {
	t.Helper()
	return v2LeasedEvent(t, lease, authoritycontract.KindCheckpointCommit, sequence, eventID, lease.RunRevision, lease.ResumeGeneration, map[string]any{
		"checkpointId": "checkpoint-1", "phaseId": "phase-0", "phaseIndex": int64(0), "commitPoint": "after_phase_work",
		"artifactRef": "artifact/checkpoint-1", "artifactHash": strings.Repeat("6", 64), "resultHash": nil, "cacheKeyHash": nil,
		"workflowSourceHash": strings.Repeat("2", 64), "manifestHash": strings.Repeat("3", 64), "inputHash": strings.Repeat("4", 64),
	})
}

func v2BudgetReserve(t testing.TB, lease runnerstore.AttemptLease, sequence int64, eventID string) runnerstore.V2RecordEventInput {
	t.Helper()
	return v2LeasedEvent(t, lease, authoritycontract.KindBudgetReserveRequest, sequence, eventID, lease.RunRevision, lease.ResumeGeneration, map[string]any{
		"reservationId": "reservation-1", "callId": "call-1", "policyHash": strings.Repeat("7", 64),
		"requestedTokens": "1", "requestedCostNanoUsd": "1", "requestedCalls": "1",
	})
}

func v2Heartbeat(t testing.TB, lease runnerstore.AttemptLease, sequence int64, eventID string) runnerstore.V2RecordEventInput {
	t.Helper()
	sentAt := canonicalNow()
	return v2LeasedEventAt(t, lease, authoritycontract.KindHeartbeat, sequence, eventID, lease.RunRevision, lease.ResumeGeneration, sentAt, map[string]any{
		"observedAt": sentAt, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt), "state": "cancelling", "lastReceiptSequence": int64(1),
	})
}

func v2LeasedEvent(t testing.TB, lease runnerstore.AttemptLease, kind authoritycontract.Kind, sequence int64, eventID string, revision, generation int64, payload map[string]any) runnerstore.V2RecordEventInput {
	t.Helper()
	return v2LeasedEventAt(t, lease, kind, sequence, eventID, revision, generation, canonicalNow(), payload)
}

func v2LeasedEventAt(t testing.TB, lease runnerstore.AttemptLease, kind authoritycontract.Kind, sequence int64, eventID string, revision, generation int64, sentAt string, payload map[string]any) runnerstore.V2RecordEventInput {
	t.Helper()
	route := lease.AuthorityRoute
	jobID, runID, attemptID, leaseID, fence := lease.JobID, lease.WorkflowRunID, lease.AttemptID, lease.LeaseID, lease.FencingToken
	message := authoritycontract.Message{Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion,
		Kind: kind, WorkspaceID: lease.WorkspaceID, JobID: &jobID, WorkflowRunID: &runID, AttemptID: &attemptID,
		LeaseID: &leaseID, FencingToken: &fence, Sequence: &sequence, AuthorityBackend: &route.Backend, Authority: &route.Authority,
		RoutingEpoch: &route.RoutingEpoch, AuthorityBuildHash: &route.AuthorityBuildHash, RunRevision: &revision,
		ResumeGeneration: &generation, EventID: eventID, CorrelationID: lease.CorrelationID, SentAt: sentAt, Payload: payload}
	prepared, err := prepareV2Message(message)
	if err != nil {
		t.Fatal(err)
	}
	return runnerstore.V2RecordEventInput{Message: message, ExactBytes: []byte(prepared.Body), ControlBuildHash: strings.Repeat("f", 64), Now: time.Now().UTC()}
}

func deliverV2Control(t testing.TB, repository *Repository, attemptID, eventID, kind string) {
	t.Helper()
	now := time.Now().UTC()
	if err := repository.MarkV2ControlDeliveryStarted(context.Background(), attemptID, eventID, kind, now); err != nil {
		t.Fatal(err)
	}
	if err := repository.MarkV2ControlDelivered(context.Background(), attemptID, eventID, kind, now); err != nil {
		t.Fatal(err)
	}
}

type budgetFoundationAdapter struct {
	applyCalls, readCalls   int
	failApplyResponse       bool
	failRead                bool
	sourceRevisionOffset    *int64
	committedRevisionDelta  int64
	driftReceiptHash        bool
	driftReceiptOperation   bool
	driftReceiptStatus      bool
	driftReceiptReservation bool
	stored                  runnerstore.V2AuthorityOutcome
}

func (adapter *budgetFoundationAdapter) ReserveBudget(_ context.Context, request runnerstore.V2AuthorityRequest) (runnerstore.V2AuthorityOutcome, error) {
	adapter.applyCalls++
	const defaultSourceRevisionOffset int64 = 10
	runnerRevision, generation := *request.Message.RunRevision+1, *request.Message.ResumeGeneration
	sourceRevisionOffset := defaultSourceRevisionOffset
	if adapter.sourceRevisionOffset != nil {
		sourceRevisionOffset = *adapter.sourceRevisionOffset
	}
	sourceRunRevision := *request.Message.RunRevision + sourceRevisionOffset
	requestedAt, err := time.Parse(time.RFC3339Nano, request.Message.SentAt)
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	committedAt := runnerstore.CanonicalTimestamp(requestedAt.Add(time.Millisecond))
	zeroQuantities := func() budgetcontract.Record {
		return budgetcontract.Record{"tokens": "0", "nanoUsd": "0", "calls": "0"}
	}
	buildHash := *request.Message.AuthorityBuildHash
	route := budgetcontract.Record{
		"backend": budgetstore.Backend, "authority": budgetstore.Authority,
		"routingEpoch": *request.Message.RoutingEpoch, "authorityBuildHash": buildHash,
	}
	account, err := budgetcontract.ValidateAccount(budgetcontract.Record{
		"schema": budgetcontract.SchemaAccount, "contractVersion": budgetcontract.ContractVersion,
		"authority": budgetcontract.Authority, "writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"workspaceId": request.Message.WorkspaceID, "runId": *request.Message.WorkflowRunID,
		"accountId": "account-1", "policyHash": request.Message.Payload["policyHash"], "route": route,
		"accountRevision": int64(0), "runRevision": sourceRunRevision,
		"limit":    budgetcontract.Record{"tokens": "100", "nanoUsd": "100", "calls": "10"},
		"reserved": zeroQuantities(), "settled": zeroQuantities(),
		"updatedAt": runnerstore.CanonicalTimestamp(requestedAt.Add(-time.Millisecond)),
	})
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	reserveRequest := budgetcontract.Record{
		"schema": budgetcontract.SchemaReserveRequest, "contractVersion": budgetcontract.ContractVersion,
		"authority": budgetcontract.Authority, "writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"workspaceId": request.Message.WorkspaceID, "runId": *request.Message.WorkflowRunID,
		"accountId": "account-1", "reservationId": request.Message.Payload["reservationId"],
		"callId": request.Message.Payload["callId"], "providerAttempt": "1",
		"expectedProviderHash":    "sha256:" + strings.Repeat("1", 64),
		"expectedModelHash":       "sha256:" + strings.Repeat("2", 64),
		"expectedProviderRunHash": "sha256:" + strings.Repeat("3", 64),
		"policyHash":              request.Message.Payload["policyHash"], "route": route,
		"expectedAccountRevision": int64(0), "expectedRunRevision": sourceRunRevision,
		"rateNanoUsdPerToken": "1",
		"requested": budgetcontract.Record{
			"tokens":  request.Message.Payload["requestedTokens"],
			"nanoUsd": request.Message.Payload["requestedCostNanoUsd"],
			"calls":   request.Message.Payload["requestedCalls"],
		},
		"requestedAt": request.Message.SentAt,
	}
	preparedBudget, err := budgetcontract.PrepareRequest("reserve", reserveRequest, "runner-v2-foundation")
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	evaluation, err := budgetcontract.EvaluateReserve(account, reserveRequest, committedAt)
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	recordHash, err := budgetcontract.HashValue("reserve-decision", evaluation.Decision)
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	ledgerHash, err := budgetcontract.HashValue("ledger-entry", evaluation.LedgerEntry)
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	budgetReceipt, err := budgetcontract.ValidateReceipt(budgetcontract.Record{
		"schema": budgetcontract.SchemaReceipt, "contractVersion": budgetcontract.ContractVersion,
		"authority": budgetcontract.Authority, "writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"operation": "reserve", "status": "accepted", "workspaceId": request.Message.WorkspaceID,
		"runId": *request.Message.WorkflowRunID, "accountId": "account-1",
		"reservationId": request.Message.Payload["reservationId"], "callId": request.Message.Payload["callId"],
		"expectedAccountRevision": int64(0), "acceptedAccountRevision": int64(1),
		"expectedRunRevision": sourceRunRevision, "acceptedRunRevision": sourceRunRevision + 1,
		"idempotencyKey": preparedBudget.IdempotencyKey, "requestFingerprint": preparedBudget.RequestFingerprint,
		"requestHash": preparedBudget.RequestHash, "recordHash": recordHash, "ledgerEntryHash": ledgerHash,
		"correlationId": request.Message.CorrelationID, "serviceBuildHash": buildHash,
		"committedAt": committedAt, "reconciliationToken": nil,
	})
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	if _, err := budgetcontract.ValidateReceiptForResult(budgetReceipt, preparedBudget, evaluation.Decision, evaluation.LedgerEntry, nil); err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	durableReceipt, err := budgetstore.NewDurableRecord(budgetstore.RecordKindReceipt, budgetReceipt, buildHash)
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	if adapter.driftReceiptOperation {
		durableReceipt.OperationalProjection["operation"] = "settle"
	}
	if adapter.driftReceiptStatus {
		durableReceipt.OperationalProjection["status"] = "provider_reconciliation_required"
		durableReceipt.OperationalProjection["reconciliationToken"] = "budget-fixture-reconciliation"
	}
	if adapter.driftReceiptReservation {
		durableReceipt.OperationalProjection["reservationId"] = "reservation.sibling"
	}
	if adapter.driftReceiptOperation || adapter.driftReceiptStatus || adapter.driftReceiptReservation {
		durableReceipt.OperationalProjectionHash, err = budgetcontract.HashValue("receipt", durableReceipt.OperationalProjection)
		if err != nil {
			return runnerstore.V2AuthorityOutcome{}, err
		}
	}
	receipt, err := budgetstore.EncodeDurableRecord(durableReceipt)
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	receiptHash := sha256.Sum256(receipt)
	receiptHashText := hex.EncodeToString(receiptHash[:])
	if adapter.driftReceiptHash {
		receiptHashText = strings.Repeat("f", 64)
	}
	sequence := *request.Message.Sequence + 2
	authorization, authorizationOK := evaluation.Decision["authorization"].(budgetcontract.Record)
	acceptedSourceRevision, revisionOK := budgetReceipt["acceptedRunRevision"].(int64)
	if !authorizationOK || !revisionOK {
		return runnerstore.V2AuthorityOutcome{}, errors.New("validated budget fixture lost its typed projection")
	}
	decision := authoritycontract.Message{Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion,
		Kind: authoritycontract.KindBudgetAuthorization, WorkspaceID: request.Message.WorkspaceID, JobID: request.Message.JobID,
		WorkflowRunID: request.Message.WorkflowRunID, AttemptID: request.Message.AttemptID, LeaseID: request.Message.LeaseID,
		FencingToken: request.Message.FencingToken, Sequence: &sequence, AuthorityBackend: request.Message.AuthorityBackend,
		Authority: request.Message.Authority, RoutingEpoch: request.Message.RoutingEpoch, AuthorityBuildHash: request.Message.AuthorityBuildHash,
		RunRevision: &runnerRevision, ResumeGeneration: &generation, EventID: "decision-" + request.Message.EventID,
		CorrelationID: request.Message.CorrelationID, SentAt: request.Message.SentAt, Payload: map[string]any{
			"reservationId": request.Message.Payload["reservationId"], "status": evaluation.Decision["status"],
			"authorizedTokens": authorization["tokens"], "authorizedCostNanoUsd": authorization["nanoUsd"],
			"authorizedCalls": authorization["calls"], "authorityReceiptHash": receiptHashText,
			"committedRunRevision": acceptedSourceRevision + adapter.committedRevisionDelta,
		}}
	prepared, err := prepareV2Message(decision)
	if err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	adapter.stored = runnerstore.V2AuthorityOutcome{Operation: authoritycontract.ReceiptBudgetReserve, ExactReceiptBytes: receipt,
		AcceptedRunRevision: runnerRevision, AcceptedResumeGeneration: generation, Decision: &decision, DecisionBytes: []byte(prepared.Body)}
	if adapter.failApplyResponse {
		return runnerstore.V2AuthorityOutcome{}, errors.New("simulated authority response loss")
	}
	return adapter.stored, nil
}
func (adapter *budgetFoundationAdapter) SettleBudget(context.Context, runnerstore.V2AuthorityRequest) (runnerstore.V2AuthorityOutcome, error) {
	return runnerstore.V2AuthorityOutcome{}, errors.New("unexpected settle")
}
func (adapter *budgetFoundationAdapter) ReadBudgetReceipt(context.Context, authoritycontract.Kind, string, string) (runnerstore.V2AuthorityOutcome, error) {
	adapter.readCalls++
	if adapter.failRead {
		return runnerstore.V2AuthorityOutcome{}, errors.New("simulated unreadable authority receipt")
	}
	return adapter.stored, nil
}

type checkpointCASLossAdapter struct{ pool *pgxpool.Pool }

func (adapter *checkpointCASLossAdapter) CommitCheckpoint(ctx context.Context, request runnerstore.V2AuthorityRequest) (runnerstore.V2AuthorityOutcome, error) {
	if _, err := adapter.pool.Exec(ctx, `UPDATE workflow_runner_v2_attempt_bindings
SET current_run_revision=current_run_revision+1,last_authority_operation='budget_reserve',last_authority_event_id=$1
WHERE attempt_id=$2`, "interloper-"+request.Message.EventID, *request.Message.AttemptID); err != nil {
		return runnerstore.V2AuthorityOutcome{}, err
	}
	return runnerstore.V2AuthorityOutcome{Operation: authoritycontract.ReceiptCheckpointCommit,
		ExactReceiptBytes: []byte(`{"schema":"test-only-checkpoint-receipt"}`), AcceptedRunRevision: *request.Message.RunRevision,
		AcceptedResumeGeneration: *request.Message.ResumeGeneration}, nil
}
func (adapter *checkpointCASLossAdapter) ReadCheckpointReceipt(context.Context, string, string) (runnerstore.V2AuthorityOutcome, error) {
	return runnerstore.V2AuthorityOutcome{}, errors.New("unexpected checkpoint read")
}
