package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointshadowstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

func TestObserveReplayMismatchLatchAndIntegrity(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := New(pool)
	first := prepared(t, envelope(t, 1, 2, 0, 0))
	key := checkpointshadowstore.IdempotencyPrefix + strings.Repeat("1", 64)
	input := checkpointshadowstore.ObserveInput{Prepared: first, IdempotencyKey: key, RequestFingerprint: checkpointshadowstore.Fingerprint("POST", "/v1/shadow/workflow-control/checkpoints", key, first.ExactBody), ServiceBuildHash: strings.Repeat("f", 64)}
	accepted, err := repository.Observe(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := repository.Observe(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if !replay.Replay || !bytes.Equal(accepted.ExactBytes, replay.ExactBytes) {
		t.Fatal("replay did not preserve exact receipt bytes")
	}
	secondEnvelope := envelope(t, 2, 3, 0, 1)
	secondEnvelope.Observation.ManifestHash = strings.Repeat("9", 64)
	rehashEnvelope(t, &secondEnvelope)
	second := prepared(t, secondEnvelope)
	secondKey := checkpointshadowstore.IdempotencyPrefix + strings.Repeat("2", 64)
	secondReceipt, err := repository.Observe(context.Background(), checkpointshadowstore.ObserveInput{Prepared: second, IdempotencyKey: secondKey, RequestFingerprint: checkpointshadowstore.Fingerprint("POST", "/v1/shadow/workflow-control/checkpoints", secondKey, second.ExactBody), ServiceBuildHash: strings.Repeat("f", 64)})
	if err != nil {
		t.Fatal(err)
	}
	if secondReceipt.Value.Parity != "mismatched" || secondReceipt.Value.MismatchCode == nil {
		t.Fatalf("receipt=%#v", secondReceipt.Value)
	}
	head, err := repository.ReadHead(context.Background(), "workspace-test", "run-test")
	if err != nil {
		t.Fatal(err)
	}
	if !head.MismatchLatched || head.SourceSequence != 2 || head.MatchedSourceSequence == nil || *head.MatchedSourceSequence != 1 {
		t.Fatalf("head=%#v", head)
	}
	if _, err := pool.Exec(context.Background(), `ALTER TABLE workflow_control_checkpoint_shadow_receipts DISABLE TRIGGER workflow_control_checkpoint_shadow_receipts_immutable`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE workflow_control_checkpoint_shadow_receipts SET exact_receipt_bytes='{}'::bytea WHERE idempotency_key=$1`, key); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ReadReceipt(context.Background(), "workspace-test", key); !checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorIntegrity) {
		t.Fatalf("integrity error=%v", err)
	}
}

func TestCommitResponseLossAndRollbackReconciliation(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	responseLoss := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errors.New("response lost")
	})
	first := prepared(t, envelope(t, 1, 2, 0, 0))
	key := checkpointshadowstore.IdempotencyPrefix + strings.Repeat("3", 64)
	input := checkpointshadowstore.ObserveInput{Prepared: first, IdempotencyKey: key, RequestFingerprint: checkpointshadowstore.Fingerprint("POST", "/v1/shadow/workflow-control/checkpoints", key, first.ExactBody), ServiceBuildHash: strings.Repeat("f", 64)}
	receipt, err := responseLoss.Observe(context.Background(), input)
	if err != nil || receipt.Value.Status != "accepted" {
		t.Fatalf("response loss receipt=%#v err=%v", receipt.Value, err)
	}
	rollback := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error { _ = tx.Rollback(ctx); return errors.New("commit unknown") })
	next := prepared(t, envelope(t, 1, 2, 0, 0))
	next.Envelope.Observation.RunID = "run-rollback"
	rehashEnvelope(t, &next.Envelope)
	next = prepared(t, next.Envelope)
	nextKey := checkpointshadowstore.IdempotencyPrefix + strings.Repeat("4", 64)
	reconciliation, err := rollback.Observe(context.Background(), checkpointshadowstore.ObserveInput{Prepared: next, IdempotencyKey: nextKey, RequestFingerprint: checkpointshadowstore.Fingerprint("POST", "/v1/shadow/workflow-control/checkpoints", nextKey, next.ExactBody), ServiceBuildHash: strings.Repeat("f", 64)})
	if err != nil || reconciliation.Value.Status != "reconciliation_required" || reconciliation.Value.Parity != "unknown" || reconciliation.Value.ReconciliationToken == nil {
		t.Fatalf("reconciliation=%#v err=%v", reconciliation.Value, err)
	}
}

func TestGS9CQualification(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := New(pool)
	ctx := context.Background()
	first := prepared(t, envelope(t, 1, 2, 0, 0))
	firstInput := observeInput(first, "5")
	if _, err := repository.Observe(ctx, firstInput); err != nil {
		t.Fatal(err)
	}

	conflicting := firstInput
	conflicting.RequestFingerprint = strings.Repeat("0", 64)
	if _, err := repository.Observe(ctx, conflicting); !checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorIdempotencyConflict) {
		t.Fatalf("fingerprint conflict=%v", err)
	}

	gapEnvelope := envelope(t, 2, 3, 0, 1)
	gapEnvelope.Observation.RunID = "run-gap"
	rehashEnvelope(t, &gapEnvelope)
	if _, err := repository.Observe(ctx, observeInput(prepared(t, gapEnvelope), "6")); !checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorConflict) {
		t.Fatalf("sequence gap=%v", err)
	}

	second := prepared(t, envelope(t, 2, 3, 0, 1))
	inputs := []checkpointshadowstore.ObserveInput{observeInput(second, "7"), observeInput(second, "8")}
	var wait sync.WaitGroup
	errorsSeen := make(chan error, len(inputs))
	for _, input := range inputs {
		wait.Add(1)
		go func(input checkpointshadowstore.ObserveInput) {
			defer wait.Done()
			_, err := repository.Observe(ctx, input)
			errorsSeen <- err
		}(input)
	}
	wait.Wait()
	close(errorsSeen)
	successes, conflicts := 0, 0
	for err := range errorsSeen {
		switch {
		case err == nil:
			successes++
		case checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorConflict):
			conflicts++
		default:
			t.Fatalf("concurrent observe=%v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent outcomes success=%d conflict=%d", successes, conflicts)
	}
}

func TestCrossOperationMismatchLatchAndHeadCorruption(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := New(pool)
	ctx := context.Background()
	firstEnvelope := envelope(t, 1, 2, 0, 0)
	if _, err := repository.Observe(ctx, observeInput(prepared(t, firstEnvelope), "9")); err != nil {
		t.Fatal(err)
	}
	resume := resumeEnvelope(t, 2, 3, 1, *firstEnvelope.Observation.Checkpoint)
	resume.Observation.ManifestHash = strings.Repeat("9", 64)
	rehashEnvelope(t, &resume)
	receipt, err := repository.Observe(ctx, observeInput(prepared(t, resume), "a"))
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Value.Parity != "mismatched" || receipt.Value.Operation != checkpointshadowstore.OperationResumeAdvance {
		t.Fatalf("receipt=%#v", receipt.Value)
	}
	head, err := repository.ReadHead(ctx, "workspace-test", "run-test")
	if err != nil {
		t.Fatal(err)
	}
	if !head.MismatchLatched || head.Operation != checkpointshadowstore.OperationCheckpointCommit || head.MatchedSourceSequence == nil || *head.MatchedSourceSequence != 1 {
		t.Fatalf("head=%#v", head)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE workflow_control_checkpoint_shadow_heads DISABLE TRIGGER workflow_control_checkpoint_shadow_head_transition`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workflow_control_checkpoint_shadow_heads SET observation_hash=decode($1,'hex') WHERE workspace_id=$2 AND run_id=$3`, strings.Repeat("0", 64), "workspace-test", "run-test"); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ReadHead(ctx, "workspace-test", "run-test"); !checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorIntegrity) {
		t.Fatalf("corrupt head=%v", err)
	}
}

func TestCommitAndReconciliationDoubleUnknownFailsClosed(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	rollback := func(ctx context.Context, tx pgx.Tx) error {
		_ = tx.Rollback(ctx)
		return errors.New("commit outcome unknown")
	}
	repository := NewWithCommitters(pool, rollback, rollback)
	if _, err := repository.Observe(context.Background(), observeInput(prepared(t, envelope(t, 1, 2, 0, 0)), "b")); !checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorCommitUnknown) {
		t.Fatalf("double unknown=%v", err)
	}
	var receipts int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM workflow_control_checkpoint_shadow_receipts`).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 0 {
		t.Fatalf("double unknown persisted %d receipts", receipts)
	}
}

func TestGS9CRestartQualification(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	first := prepared(t, envelope(t, 1, 2, 0, 0))
	input := observeInput(first, "c")
	receipt, err := New(pool).Observe(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	restarted := New(pool)
	head, err := restarted.ReadHead(ctx, "workspace-test", "run-test")
	if err != nil || head.SourceSequence != 1 {
		t.Fatalf("restart head=%#v err=%v", head, err)
	}
	read, err := restarted.ReadReceipt(ctx, "workspace-test", input.IdempotencyKey)
	if err != nil || !bytes.Equal(read.ExactBytes, receipt.ExactBytes) {
		t.Fatalf("restart receipt=%#v err=%v", read.Value, err)
	}
	replay, err := restarted.Observe(ctx, input)
	if err != nil || !replay.Replay || !bytes.Equal(replay.ExactBytes, receipt.ExactBytes) {
		t.Fatalf("restart replay=%#v err=%v", replay.Value, err)
	}
}

func envelope(t *testing.T, sequence, revision, generation, phase int64) checkpointshadowstore.Envelope {
	t.Helper()
	checkpoint := &checkpointshadowstore.Checkpoint{CheckpointID: "checkpoint-" + string(rune('a'+phase)), PhaseID: fmt.Sprintf("phase-%d", phase), PhaseIndex: phase, CommitPoint: "after_phase_work", ArtifactRef: "artifacts/checkpoint.json", ArtifactHash: strings.Repeat("a", 64), CommittedRevision: revision, ResumeGeneration: generation, CommittedAt: "2026-08-12T00:00:00.000Z"}
	observation := checkpointshadowstore.Observation{Schema: checkpointshadowstore.ObservationSchema, Authority: "typescript", GoRole: "observer_only", RunID: "run-test", Revision: revision, ResumeGeneration: generation, WorkflowSourceHash: strings.Repeat("b", 64), ManifestHash: strings.Repeat("c", 64), InputHash: strings.Repeat("d", 64), Runner: checkpointshadowstore.RunnerBinding{WorkspaceID: "workspace-test", JobID: "job-test", AttemptID: "attempt-test", LeaseID: "lease-test", FencingToken: 1, CorrelationID: "correlation-test", RunnerBuildHash: strings.Repeat("e", 64)}, Checkpoint: checkpoint}
	result := checkpointshadowstore.Envelope{Schema: checkpointshadowstore.EnvelopeSchema, GoRole: "observer_only", SourceSequence: sequence, Operation: checkpointshadowstore.OperationCheckpointCommit, Observation: observation}
	rehashEnvelope(t, &result)
	return result
}

func resumeEnvelope(t *testing.T, sequence, revision, generation int64, prior checkpointshadowstore.Checkpoint) checkpointshadowstore.Envelope {
	t.Helper()
	nextIndex := prior.PhaseIndex + 1
	nextID := fmt.Sprintf("phase-%d", nextIndex)
	observation := checkpointshadowstore.Observation{Schema: checkpointshadowstore.ObservationSchema, Authority: "typescript", GoRole: "observer_only", RunID: "run-test", Revision: revision, ResumeGeneration: generation, WorkflowSourceHash: strings.Repeat("b", 64), ManifestHash: strings.Repeat("c", 64), InputHash: strings.Repeat("d", 64), Runner: checkpointshadowstore.RunnerBinding{WorkspaceID: "workspace-test", JobID: "job-test", AttemptID: "attempt-resume", LeaseID: "lease-resume", FencingToken: 2, CorrelationID: "correlation-test", RunnerBuildHash: strings.Repeat("e", 64)}, PriorCheckpoint: &prior, NextPhaseID: &nextID, NextPhaseIndex: &nextIndex}
	result := checkpointshadowstore.Envelope{Schema: checkpointshadowstore.EnvelopeSchema, GoRole: "observer_only", SourceSequence: sequence, Operation: checkpointshadowstore.OperationResumeAdvance, Observation: observation}
	rehashEnvelope(t, &result)
	return result
}

func observeInput(value checkpointshadowstore.PreparedObservation, keyCharacter string) checkpointshadowstore.ObserveInput {
	key := checkpointshadowstore.IdempotencyPrefix + strings.Repeat(keyCharacter, 64)
	return checkpointshadowstore.ObserveInput{Prepared: value, IdempotencyKey: key, RequestFingerprint: checkpointshadowstore.Fingerprint("POST", "/v1/shadow/workflow-control/checkpoints", key, value.ExactBody), ServiceBuildHash: strings.Repeat("f", 64)}
}
func rehashEnvelope(t *testing.T, value *checkpointshadowstore.Envelope) {
	t.Helper()
	body, err := canonicaljson.Encode(value.Observation)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	value.ObservationHash = hex.EncodeToString(digest[:])
}
func prepared(t *testing.T, value checkpointshadowstore.Envelope) checkpointshadowstore.PreparedObservation {
	t.Helper()
	body, err := canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	result, err := checkpointshadowstore.PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
