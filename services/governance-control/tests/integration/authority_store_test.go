package integration_test

import (
	"context"
	"sync"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore"
	authoritypostgres "github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

func TestAuthorityAcceptAuditAndTransitionAreDurableAndIdempotent(t *testing.T) {
	pool := testsupport.Open(t)
	repository := authoritypostgres.New(pool)
	_, accept := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	receipt, err := repository.Mutate(context.Background(), accept)
	if err != nil || receipt.Status != authoritystore.ReceiptAccepted || receipt.AcceptedRevision == nil || *receipt.AcceptedRevision != 1 {
		t.Fatalf("accept = %+v err=%v", receipt, err)
	}
	replay, err := repository.Mutate(context.Background(), accept)
	if err != nil || replay.Status != authoritystore.ReceiptDuplicate || replay.ReceiptID != receipt.ReceiptID {
		t.Fatalf("replay = %+v err=%v", replay, err)
	}
	conflicting := accept
	conflicting.RequestFingerprint = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	if _, err := repository.Mutate(context.Background(), conflicting); !authoritystore.IsCode(err, authoritystore.ErrorIdempotencyConflict) {
		t.Fatalf("fingerprint conflict = %v", err)
	}
	pending, err := repository.ReadPendingAudit(context.Background(), testsupport.WorkspaceID, testsupport.PlanID, 1)
	if err != nil || pending.Status != "pending" || pending.Operation != authoritystore.OperationAccept ||
		pending.RecordHash != receipt.RecordHash || pending.Route.RoutingEpoch != 7 || pending.ServiceBuildSHA != receipt.ServiceBuildSHA {
		t.Fatalf("pending audit point read = %+v err=%v", pending, err)
	}
	if _, err := repository.ReadPendingAudit(context.Background(), testsupport.WorkspaceID, testsupport.PlanID, 2); !authoritystore.IsCode(err, authoritystore.ErrorNotFound) {
		t.Fatalf("absent audit was exposed as pending: %v", err)
	}

	_, audit := testsupport.AuthorityAudit(t, "plan.previewed", "pending", 1, 7)
	auditReceipt, err := repository.RecordAudit(context.Background(), audit)
	if err != nil || auditReceipt.Status != "recorded" {
		t.Fatalf("audit = %+v err=%v", auditReceipt, err)
	}
	auditReplay, err := repository.RecordAudit(context.Background(), audit)
	if err != nil || auditReplay.Status != "duplicate" || auditReplay.RecordedAt != auditReceipt.RecordedAt {
		t.Fatalf("audit replay = %+v err=%v", auditReplay, err)
	}
	if _, err := repository.ReadPendingAudit(context.Background(), testsupport.WorkspaceID, testsupport.PlanID, 1); !authoritystore.IsCode(err, authoritystore.ErrorNotFound) {
		t.Fatalf("recorded audit was exposed as pending: %v", err)
	}

	_, claim := testsupport.AuthorityRequest(t, authoritystore.OperationClaimExecution, "executing-record-validation-and-read-model", 1, 7)
	claimed, err := repository.Mutate(context.Background(), claim)
	if err != nil || claimed.AcceptedRevision == nil || *claimed.AcceptedRevision != 2 || claimed.ExecutionID == "" {
		t.Fatalf("claim = %+v err=%v", claimed, err)
	}
	read, err := repository.Read(context.Background(), testsupport.WorkspaceID, testsupport.PlanID)
	if err != nil || read.Route.RoutingEpoch != 7 || read.RecordHash != claimed.RecordHash {
		t.Fatalf("read = %+v err=%v", read, err)
	}
	statistics, err := repository.Statistics(context.Background())
	if err != nil || statistics.Plans != 1 || statistics.AuditPending != 1 {
		t.Fatalf("statistics = %+v err=%v", statistics, err)
	}
}

func TestAuthorityCASAllowsOneTransitionWinner(t *testing.T) {
	pool := testsupport.Open(t)
	repository := authoritypostgres.New(pool)
	_, accept := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	if _, err := repository.Mutate(context.Background(), accept); err != nil {
		t.Fatal(err)
	}
	_, audit := testsupport.AuthorityAudit(t, "plan.previewed", "pending", 1, 7)
	if _, err := repository.RecordAudit(context.Background(), audit); err != nil {
		t.Fatal(err)
	}
	_, claim := testsupport.AuthorityRequest(t, authoritystore.OperationClaimExecution, "executing-record-validation-and-read-model", 1, 7)
	_, cancel := testsupport.AuthorityRequest(t, authoritystore.OperationCancel, "cancelled-record-validation-and-read-model", 1, 7)
	var wait sync.WaitGroup
	wait.Add(2)
	errorsSeen := make(chan error, 2)
	for _, input := range []authoritystore.MutateInput{claim, cancel} {
		input := input
		go func() {
			defer wait.Done()
			_, err := repository.Mutate(context.Background(), input)
			errorsSeen <- err
		}()
	}
	wait.Wait()
	close(errorsSeen)
	successes, conflicts := 0, 0
	for err := range errorsSeen {
		if err == nil {
			successes++
		} else if authoritystore.IsCode(err, authoritystore.ErrorConflict) {
			conflicts++
		} else {
			t.Fatalf("unexpected error %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("success/conflict = %d/%d", successes, conflicts)
	}
}

func TestAuthorityTransitionCannotAdvancePastAPendingPreviousAudit(t *testing.T) {
	pool := testsupport.Open(t)
	repository := authoritypostgres.New(pool)
	_, accept := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	if _, err := repository.Mutate(context.Background(), accept); err != nil {
		t.Fatal(err)
	}
	_, claim := testsupport.AuthorityRequest(t, authoritystore.OperationClaimExecution, "executing-record-validation-and-read-model", 1, 7)
	if _, err := repository.Mutate(context.Background(), claim); !authoritystore.IsCode(err, authoritystore.ErrorConflict) {
		t.Fatalf("claim advanced past pending accept audit: %v", err)
	}
	_, previewAudit := testsupport.AuthorityAudit(t, "plan.previewed", "pending", 1, 7)
	if _, err := repository.RecordAudit(context.Background(), previewAudit); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Mutate(context.Background(), claim); err != nil {
		t.Fatalf("claim after audit acknowledgement: %v", err)
	}
	_, complete := testsupport.AuthorityRequest(t, authoritystore.OperationCompleteExecution, "succeeded-record-validation-and-read-model", 2, 7)
	if _, err := repository.Mutate(context.Background(), complete); !authoritystore.IsCode(err, authoritystore.ErrorConflict) {
		t.Fatalf("complete advanced past pending claim audit: %v", err)
	}
	_, claimAudit := testsupport.AuthorityAudit(t, "plan.confirmed", "executing", 2, 7)
	if _, err := repository.RecordAudit(context.Background(), claimAudit); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Mutate(context.Background(), complete); err != nil {
		t.Fatalf("complete after audit acknowledgement: %v", err)
	}
	statistics, err := repository.Statistics(context.Background())
	if err != nil || statistics.AuditPending != 1 {
		t.Fatalf("terminal audit pending invariant = %+v err=%v", statistics, err)
	}
}
