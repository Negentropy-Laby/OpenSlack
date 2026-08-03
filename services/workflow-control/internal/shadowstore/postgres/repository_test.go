package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

func TestRunLockKeyIsUnambiguousAcrossComponentBoundaries(t *testing.T) {
	left := runLockKey(workflowcontrol.ShadowSource{WorkspaceID: "ab", RunID: "c"})
	right := runLockKey(workflowcontrol.ShadowSource{WorkspaceID: "a", RunID: "bc"})
	if left == right {
		t.Fatalf("run lock keys collide: %q", left)
	}
}

func TestCommitResponseLossRecoversDurableAcceptedReceipt(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	input := testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))
	commitResponseLost := errors.New("simulated response loss after commit")
	repository := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return commitResponseLost
	})

	first, err := repository.Observe(context.Background(), input)
	if err != nil {
		t.Fatalf("recover committed receipt: %v", err)
	}
	if first.Status != shadowstore.ReceiptAccepted || first.CommittedAt == nil {
		t.Fatalf("unexpected recovered receipt: %#v", first)
	}

	replay, err := New(pool).Observe(context.Background(), input)
	if err != nil {
		t.Fatalf("replay committed observation: %v", err)
	}
	if replay.Status != shadowstore.ReceiptDuplicate || replay.ReceiptID != first.ReceiptID {
		t.Fatalf("replay did not resolve to the durable receipt: first=%#v replay=%#v", first, replay)
	}
	projection, err := New(pool).Projection(context.Background(), testsupport.WorkspaceID, testsupport.RunID)
	if err != nil {
		t.Fatalf("read recovered projection: %v", err)
	}
	if projection.SourceSequence != 1 || projection.MatchedSourceSequence != 1 {
		t.Fatalf("unexpected recovered head: %#v", projection)
	}
}

func TestUnknownCommitPersistsStableReconciliationReceipt(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	input := testsupport.ObserveInput(t, testsupport.Envelope(t, 1, workflowcontrol.RunRunning))
	commitOutcomeUnknown := errors.New("simulated commit outcome unknown")
	repository := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Rollback(ctx); err != nil {
			return err
		}
		return commitOutcomeUnknown
	})

	first, err := repository.Observe(context.Background(), input)
	if err != nil {
		t.Fatalf("persist reconciliation receipt: %v", err)
	}
	if first.Status != shadowstore.ReceiptReconciliationRequired || first.Parity != shadowstore.ParityUnknown ||
		first.ReconciliationToken == nil || first.CommittedAt != nil || first.ObservationHash != "" {
		t.Fatalf("unexpected reconciliation receipt: %#v", first)
	}

	replay, err := repository.Observe(context.Background(), input)
	if err != nil {
		t.Fatalf("replay reconciliation receipt: %v", err)
	}
	if replay.Status != shadowstore.ReceiptReconciliationRequired || replay.ReceiptID != first.ReceiptID ||
		replay.ReconciliationToken == nil || *replay.ReconciliationToken != *first.ReconciliationToken {
		t.Fatalf("reconciliation replay was not stable: first=%#v replay=%#v", first, replay)
	}
	if _, err := repository.Projection(context.Background(), testsupport.WorkspaceID, testsupport.RunID); !shadowstore.IsCode(err, shadowstore.ErrorNotFound) {
		t.Fatalf("rolled-back observation unexpectedly advanced the head: %v", err)
	}
	statistics, err := repository.Statistics(context.Background())
	if err != nil {
		t.Fatalf("read reconciliation statistics: %v", err)
	}
	if statistics.ReconciliationPending != 1 || statistics.Runs != 0 {
		t.Fatalf("unexpected reconciliation statistics: %#v", statistics)
	}
}
