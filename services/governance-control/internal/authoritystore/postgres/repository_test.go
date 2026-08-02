package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

func TestAuthorityCommittedResponseLossRecoversReceiptAndAuditAck(t *testing.T) {
	pool := testsupport.Open(t)
	commitErr := errors.New("injected committed response loss")
	repository := &Repository{pool: pool, commitTransaction: func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return commitErr
	}}
	_, accept := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	recovered, err := repository.Mutate(context.Background(), accept)
	if err != nil || recovered.Status != authoritystore.ReceiptAccepted {
		t.Fatalf("recovered = %+v err=%v", recovered, err)
	}
	replay, err := repository.Mutate(context.Background(), accept)
	if err != nil || replay.Status != authoritystore.ReceiptDuplicate || replay.ReceiptID != recovered.ReceiptID {
		t.Fatalf("replay = %+v err=%v", replay, err)
	}

	repository.commitAuditTransaction = func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return commitErr
	}
	_, audit := testsupport.AuthorityAudit(t, "plan.previewed", "pending", 1, 7)
	auditRecovered, err := repository.RecordAudit(context.Background(), audit)
	if err != nil || auditRecovered.Status != "recorded" {
		t.Fatalf("audit recovered = %+v err=%v", auditRecovered, err)
	}
	auditReplay, err := repository.RecordAudit(context.Background(), audit)
	if err != nil || auditReplay.Status != "duplicate" {
		t.Fatalf("audit replay = %+v err=%v", auditReplay, err)
	}
}
