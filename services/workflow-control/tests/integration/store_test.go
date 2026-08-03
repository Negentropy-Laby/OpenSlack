package integration_test

import (
	"context"
	"strings"
	"testing"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore"
	shadowpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

func TestFirstDuplicateAndMismatchDoNotAdvanceMatchedHead(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := shadowpostgres.New(pool)
	ctx := context.Background()

	firstInput := testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))
	first, err := repository.Observe(ctx, firstInput)
	if err != nil {
		t.Fatalf("observe first matched value: %v", err)
	}
	if first.Status != shadowstore.ReceiptAccepted || first.Parity != shadowstore.ParityMatched || first.CommittedAt == nil {
		t.Fatalf("unexpected first receipt: %#v", first)
	}

	duplicate, err := repository.Observe(ctx, firstInput)
	if err != nil {
		t.Fatalf("observe duplicate value: %v", err)
	}
	if duplicate.Status != shadowstore.ReceiptDuplicate || duplicate.ReceiptID != first.ReceiptID ||
		duplicate.CommittedAt == nil || !duplicate.CommittedAt.Equal(*first.CommittedAt) {
		t.Fatalf("duplicate did not replay durable receipt: first=%#v duplicate=%#v", first, duplicate)
	}

	drifted := testsupport.Envelope(t, 2, workflowcontrol.RunPaused)
	drifted.Projection.Status = workflowcontrol.RunCompleted
	mismatch, err := repository.Observe(ctx, testsupport.ObserveInput(t, drifted))
	if err != nil {
		t.Fatalf("observe projection mismatch: %v", err)
	}
	if mismatch.Status != shadowstore.ReceiptAccepted || mismatch.Parity != shadowstore.ParityMismatched || mismatch.MismatchCode != "projection_mismatch" {
		t.Fatalf("unexpected mismatch receipt: %#v", mismatch)
	}

	projection, err := repository.Projection(ctx, testsupport.WorkspaceID, testsupport.RunID)
	if err != nil {
		t.Fatalf("read projection: %v", err)
	}
	if projection.SourceSequence != 2 || projection.MatchedSourceSequence != 1 ||
		projection.ReadModel.Status != workflowcontrol.RunRunning || projection.Parity != shadowstore.ParityMismatched ||
		projection.MatchedObservations != 1 || projection.MismatchedObservations != 1 {
		t.Fatalf("mismatch advanced matched state or counts are wrong: %#v", projection)
	}
}

func TestSourceSequenceConflictDoesNotAdvanceHead(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := shadowpostgres.New(pool)
	ctx := context.Background()
	if _, err := repository.Observe(ctx, testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))); err != nil {
		t.Fatalf("seed first sequence: %v", err)
	}

	_, err := repository.Observe(ctx, testsupport.ObserveInput(t, testsupport.Envelope(t, 3, workflowcontrol.RunCompleted)))
	if !shadowstore.IsCode(err, shadowstore.ErrorSequenceConflict) {
		t.Fatalf("sequence gap error = %v, want %s", err, shadowstore.ErrorSequenceConflict)
	}
	projection, err := repository.Projection(ctx, testsupport.WorkspaceID, testsupport.RunID)
	if err != nil {
		t.Fatalf("read head after conflict: %v", err)
	}
	if projection.SourceSequence != 1 || projection.MatchedSourceSequence != 1 || projection.MatchedObservations != 1 {
		t.Fatalf("sequence conflict advanced state: %#v", projection)
	}
}

func TestExistingIdempotencyBindingConflictFailsClosed(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	input := testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))
	if _, err := pool.Exec(ctx, `
INSERT INTO workflow_control_shadow_receipts (
    receipt_id, operation, status, parity, idempotency_key,
    request_fingerprint, workspace_id, run_id, source_sequence,
    observation_digest, reconciliation_token
) VALUES (
    'receipt-conflict', 'observation_ingest', 'reconciliation_required', 'unknown', $1,
    decode(repeat('ff',32),'hex'), $2, $3, 1,
    decode(repeat('00',32),'hex'), 'reconcile-conflict'
)`, input.IdempotencyKey, testsupport.WorkspaceID, testsupport.RunID); err != nil {
		t.Fatalf("seed conflicting idempotency binding: %v", err)
	}

	_, err := shadowpostgres.New(pool).Observe(ctx, input)
	if !shadowstore.IsCode(err, shadowstore.ErrorIdempotencyConflict) {
		t.Fatalf("idempotency conflict error = %v, want %s", err, shadowstore.ErrorIdempotencyConflict)
	}
	statistics, err := shadowpostgres.New(pool).Statistics(ctx)
	if err != nil {
		t.Fatalf("read statistics after conflict: %v", err)
	}
	if statistics.Runs != 0 || statistics.ReconciliationPending != 1 {
		t.Fatalf("idempotency conflict mutated shadow state: %#v", statistics)
	}
}

func TestConcurrentSameSequenceHasOneWinner(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := shadowpostgres.New(pool)
	ctx := context.Background()
	if _, err := repository.Observe(ctx, testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))); err != nil {
		t.Fatalf("seed first sequence: %v", err)
	}
	inputs := []shadowstore.ObserveInput{
		testsupport.ObserveInput(t, testsupport.Envelope(t, 2, workflowcontrol.RunPaused)),
		testsupport.ObserveInput(t, testsupport.Envelope(t, 2, workflowcontrol.RunCompleted)),
	}
	type outcome struct {
		receipt shadowstore.Receipt
		err     error
	}
	results := make(chan outcome, len(inputs))
	for _, input := range inputs {
		input := input
		go func() {
			receipt, err := repository.Observe(ctx, input)
			results <- outcome{receipt: receipt, err: err}
		}()
	}
	accepted, conflicts := 0, 0
	for range inputs {
		result := <-results
		switch {
		case result.err == nil && result.receipt.Status == shadowstore.ReceiptAccepted:
			accepted++
		case shadowstore.IsCode(result.err, shadowstore.ErrorSequenceConflict):
			conflicts++
		default:
			t.Fatalf("unexpected concurrent outcome: receipt=%#v err=%v", result.receipt, result.err)
		}
	}
	if accepted != 1 || conflicts != 1 {
		t.Fatalf("concurrent outcomes: accepted=%d conflicts=%d", accepted, conflicts)
	}
	projection, err := repository.Projection(ctx, testsupport.WorkspaceID, testsupport.RunID)
	if err != nil {
		t.Fatalf("read concurrent winner: %v", err)
	}
	if projection.SourceSequence != 2 || projection.MatchedSourceSequence != 2 || projection.MatchedObservations != 2 {
		t.Fatalf("concurrent sequence did not have exactly one durable winner: %#v", projection)
	}
}

func TestObservationAndReceiptRowsAreImmutable(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	if _, err := shadowpostgres.New(pool).Observe(ctx, testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))); err != nil {
		t.Fatalf("seed immutable rows: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workflow_control_shadow_observations SET status='paused'`); err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("observation update was not rejected by immutable trigger: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM workflow_control_shadow_receipts`); err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("receipt delete was not rejected by immutable trigger: %v", err)
	}
}

func TestProjectionFailsClosedOnCorruptMatchedHead(t *testing.T) {
	tests := []struct {
		name   string
		update string
	}{
		{name: "observation hash", update: `UPDATE workflow_control_shadow_heads SET matched_observation_hash=decode(repeat('00',32),'hex')`},
		{name: "canonical envelope", update: `UPDATE workflow_control_shadow_heads SET matched_envelope_bytes=decode('7b7d','hex')`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := testsupport.OpenPostgres(t)
			ctx := context.Background()
			repository := shadowpostgres.New(pool)
			if _, err := repository.Observe(ctx, testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))); err != nil {
				t.Fatalf("seed matched head: %v", err)
			}
			if _, err := pool.Exec(ctx, test.update); err != nil {
				t.Fatalf("corrupt matched head: %v", err)
			}
			if _, err := repository.Projection(ctx, testsupport.WorkspaceID, testsupport.RunID); !shadowstore.IsCode(err, shadowstore.ErrorContentInvalid) {
				t.Fatalf("corrupt projection error = %v, want %s", err, shadowstore.ErrorContentInvalid)
			}
		})
	}
}
