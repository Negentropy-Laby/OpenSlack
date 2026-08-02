package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

func TestCommittedResponseLossRecoversDurableReceipt(t *testing.T) {
	pool := testsupport.Open(t)
	commitErr := errors.New("injected committed response loss")
	repository := &Repository{pool: pool, commitTransaction: func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return commitErr
	}}
	_, input := testsupport.PendingObservation(t, 1)
	recovered, err := repository.Observe(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Status != shadowstore.ReceiptAccepted {
		t.Fatalf("recovered = %+v", recovered)
	}
	replay, err := repository.Observe(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if replay.Status != shadowstore.ReceiptDuplicate || replay.ReceiptID != recovered.ReceiptID {
		t.Fatalf("replay = %+v", replay)
	}
	projection, err := repository.Projection(context.Background(), testsupport.WorkspaceID, testsupport.PlanID)
	if err != nil || projection.MatchedRecordRevision != 1 {
		t.Fatalf("projection = %+v err=%v", projection, err)
	}
}
