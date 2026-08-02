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

func TestAuthorityUncommittedAmbiguousOutcomePersistsReconciliationReceipt(t *testing.T) {
	pool := testsupport.Open(t)
	commitErr := errors.New("injected ambiguous commit without a durable receipt")
	repository := &Repository{pool: pool, commitTransaction: func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Rollback(ctx); err != nil {
			return err
		}
		return commitErr
	}}
	_, accept := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	reconciled, err := repository.Mutate(context.Background(), accept)
	if err != nil || reconciled.Status != authoritystore.ReceiptReconciliationRequired ||
		reconciled.AcceptedRevision != nil || reconciled.TargetRevision == nil || *reconciled.TargetRevision != 1 ||
		reconciled.TargetState != "pending" || reconciled.ReconciliationToken == "" ||
		reconciled.CommittedAt != nil || len(reconciled.RecordBytes) != 0 {
		t.Fatalf("reconciled = %+v err=%v", reconciled, err)
	}
	replay, err := repository.Mutate(context.Background(), accept)
	if err != nil || replay.Status != authoritystore.ReceiptReconciliationRequired || replay.ReceiptID != reconciled.ReceiptID {
		t.Fatalf("replay = %+v err=%v", replay, err)
	}
	persisted, err := repository.ReadReceipt(context.Background(), accept.Prepared.WorkspaceID, accept.IdempotencyKey)
	if err != nil || persisted.ReceiptID != reconciled.ReceiptID || persisted.Status != authoritystore.ReceiptReconciliationRequired {
		t.Fatalf("persisted = %+v err=%v", persisted, err)
	}
	if _, err := repository.Read(context.Background(), accept.Prepared.WorkspaceID, accept.Prepared.PlanID); !authoritystore.IsCode(err, authoritystore.ErrorNotFound) {
		t.Fatalf("uncommitted authority head err=%v", err)
	}
	statistics, err := repository.Statistics(context.Background())
	if err != nil || statistics.Plans != 0 || statistics.Receipts != 1 || statistics.ReconciliationPending != 1 || statistics.AuditPending != 0 {
		t.Fatalf("statistics = %+v err=%v", statistics, err)
	}
}
