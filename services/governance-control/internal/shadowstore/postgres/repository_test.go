package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

func TestPlanLockKeyIsPostgresTextSafeAndCollisionFree(t *testing.T) {
	left := planLockKey(shadowstore.Source{WorkspaceID: "ab", PlanID: "c"})
	right := planLockKey(shadowstore.Source{WorkspaceID: "a", PlanID: "bc"})
	if left == right {
		t.Fatalf("composite identities collided: %q", left)
	}
	if strings.ContainsRune(left, '\x00') || strings.ContainsRune(right, '\x00') {
		t.Fatalf("plan advisory lock key contains a PostgreSQL-forbidden NUL")
	}
}

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
