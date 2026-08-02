package integration_test

import (
	"context"
	"sync"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
	shadowpostgres "github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

func TestObservationIdempotencyMismatchAndMatchedHead(t *testing.T) {
	pool := testsupport.Open(t)
	repository := shadowpostgres.New(pool)
	_, first := testsupport.PendingObservation(t, 1)
	accepted, err := repository.Observe(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	if accepted.Status != shadowstore.ReceiptAccepted || accepted.Parity != shadowstore.ParityMatched {
		t.Fatalf("accepted = %+v", accepted)
	}
	duplicate, err := repository.Observe(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.Status != shadowstore.ReceiptDuplicate || duplicate.ReceiptID != accepted.ReceiptID {
		t.Fatalf("duplicate = %+v", duplicate)
	}

	_, second := testsupport.PendingObservation(t, 2)
	mismatch, err := repository.Observe(context.Background(), second)
	if err != nil {
		t.Fatal(err)
	}
	if mismatch.Parity != shadowstore.ParityMismatched || mismatch.MismatchCode != "record_revision_mismatch" {
		t.Fatalf("mismatch = %+v", mismatch)
	}
	projection, err := repository.Projection(context.Background(), testsupport.WorkspaceID, testsupport.PlanID)
	if err != nil {
		t.Fatal(err)
	}
	if projection.SourceSequence != 2 || projection.MatchedRecordRevision != 1 || projection.Parity != shadowstore.ParityMismatched {
		t.Fatalf("projection = %+v", projection)
	}

	conflicting := second
	conflicting.IdempotencyKey = first.IdempotencyKey
	if _, err := repository.Observe(context.Background(), conflicting); !shadowstore.IsCode(err, shadowstore.ErrorInputInvalid) {
		t.Fatalf("non-derived idempotency key = %v", err)
	}
}

func TestSourceSequenceCASHasOneWinner(t *testing.T) {
	pool := testsupport.Open(t)
	repository := shadowpostgres.New(pool)
	_, first := testsupport.PendingObservation(t, 1)
	if _, err := repository.Observe(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	_, left := testsupport.PendingObservation(t, 2)
	_, right := testsupport.PendingObservationExpected(t, 2, 99)
	var wait sync.WaitGroup
	wait.Add(2)
	errorsSeen := make(chan error, 2)
	for _, input := range []shadowstore.ObserveInput{left, right} {
		input := input
		go func() {
			defer wait.Done()
			_, err := repository.Observe(context.Background(), input)
			errorsSeen <- err
		}()
	}
	wait.Wait()
	close(errorsSeen)
	successes, conflicts := 0, 0
	for err := range errorsSeen {
		if err == nil {
			successes++
		} else if shadowstore.IsCode(err, shadowstore.ErrorSequenceConflict) {
			conflicts++
		} else {
			t.Fatalf("unexpected error %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("success/conflict = %d/%d", successes, conflicts)
	}
}

func TestImmutableObservationRows(t *testing.T) {
	pool := testsupport.Open(t)
	repository := shadowpostgres.New(pool)
	_, first := testsupport.PendingObservation(t, 1)
	if _, err := repository.Observe(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE governance_shadow_observations SET parity='mismatched'`); err == nil {
		t.Fatal("immutable observation updated")
	}
	if _, err := pool.Exec(context.Background(), `DELETE FROM governance_shadow_receipts`); err == nil {
		t.Fatal("immutable receipt deleted")
	}
}
