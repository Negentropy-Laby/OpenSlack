package postgres

import (
	"bytes"
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

func TestGS9BAuthorityAcceptAndByteIdenticalReplay(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := New(pool)
	input := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)

	first, err := repository.Mutate(context.Background(), input)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	replay, err := repository.Mutate(context.Background(), input)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if first.Value.Status != authoritycontract.ReceiptAccepted || replay.Value.Status != authoritycontract.ReceiptAccepted ||
		!replay.Replay || first.ReceiptID != replay.ReceiptID || !bytes.Equal(first.ExactBytes, replay.ExactBytes) {
		t.Fatalf("receipt replay changed immutable result: first=%#v replay=%#v", first, replay)
	}
	head, err := repository.Read(context.Background(), input.Prepared.Envelope.WorkspaceID, input.Prepared.Envelope.RunID)
	if err != nil || head.Revision != 1 || head.State != authoritycontract.RunCreated {
		t.Fatalf("head=%#v err=%v", head, err)
	}
	outbox, err := repository.ReadOutbox(context.Background(), head.WorkspaceID, head.RunID, head.Revision)
	if err != nil || outbox.Status != "pending" || outbox.EventType != authoritystore.OutboxEventType {
		t.Fatalf("outbox=%#v err=%v", outbox, err)
	}
	statistics, err := repository.Statistics(context.Background())
	if err != nil || statistics.Runs != 1 || statistics.Receipts != 1 || statistics.TransitionEvents != 1 || statistics.OutboxPending != 1 {
		t.Fatalf("statistics=%#v err=%v", statistics, err)
	}
}

func TestGS9BAuthorityReadRejectsTamperedCanonicalRecordBytes(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := New(pool)
	input := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)
	if _, err := repository.Mutate(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `
		UPDATE workflow_control_runs
		SET revision=revision+1,
		    canonical_record_bytes=canonical_record_bytes || decode('20','hex')
		WHERE workspace_id=$1 AND run_id=$2`,
		input.Prepared.Envelope.WorkspaceID, input.Prepared.Envelope.RunID,
	); err != nil {
		t.Fatalf("tamper canonical record bytes: %v", err)
	}
	if _, err := repository.Read(context.Background(), input.Prepared.Envelope.WorkspaceID, input.Prepared.Envelope.RunID); !authoritystore.IsCode(err, authoritystore.ErrorIntegrity) {
		t.Fatalf("tampered canonical record bytes err=%v, want %s", err, authoritystore.ErrorIntegrity)
	}
}

func TestGS9BAuthorityReadRejectsTamperedCanonicalOutboxBytes(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := New(pool)
	input := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)
	if _, err := repository.Mutate(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	tamperAuthorityRow(t, pool,
		`ALTER TABLE workflow_control_outbox DISABLE TRIGGER workflow_control_outbox_transition`,
		`UPDATE workflow_control_outbox SET canonical_payload_bytes=canonical_payload_bytes || decode('20','hex') WHERE workspace_id=$1 AND run_id=$2 AND run_revision=1`,
		`ALTER TABLE workflow_control_outbox ENABLE TRIGGER workflow_control_outbox_transition`,
		input.Prepared.Envelope.WorkspaceID, input.Prepared.Envelope.RunID,
	)
	if _, err := repository.ReadOutbox(context.Background(), input.Prepared.Envelope.WorkspaceID, input.Prepared.Envelope.RunID, 1); !authoritystore.IsCode(err, authoritystore.ErrorIntegrity) {
		t.Fatalf("tampered canonical outbox bytes err=%v, want %s", err, authoritystore.ErrorIntegrity)
	}
}

func TestGS9BAuthorityRejectsCorruptStoredReceiptAsIntegrityFailure(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := New(pool)
	input := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)
	if _, err := repository.Mutate(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	tamperAuthorityRow(t, pool,
		`ALTER TABLE workflow_control_transition_receipts DISABLE TRIGGER workflow_control_transition_receipts_immutable`,
		`UPDATE workflow_control_transition_receipts SET exact_receipt_bytes=convert_to(replace(convert_from(exact_receipt_bytes, 'UTF8'), '"correlationId":"correlation-test"', '"correlationId":"correlation-corrupt"'), 'UTF8') WHERE idempotency_key=$1`,
		`ALTER TABLE workflow_control_transition_receipts ENABLE TRIGGER workflow_control_transition_receipts_immutable`,
		input.IdempotencyKey,
	)
	for label, err := range map[string]error{
		"get":    receiptReadError(repository, input),
		"replay": receiptReplayError(repository, input),
	} {
		if !authoritystore.IsCode(err, authoritystore.ErrorIntegrity) || authoritystore.IsCode(err, authoritystore.ErrorDatabase) {
			t.Fatalf("corrupt receipt %s err=%v, want %s and not %s", label, err, authoritystore.ErrorIntegrity, authoritystore.ErrorDatabase)
		}
	}
}

func TestGS9BAuthorityReadyUsesLightweightProbe(t *testing.T) {
	if err := New(openAuthorityPostgres(t)).Ready(context.Background()); err != nil {
		t.Fatalf("lightweight readiness probe: %v", err)
	}
}

func TestGS9BAuthorityMutationRemainsCompatibleWithoutBudgetNamespace(t *testing.T) {
	pool := openAuthorityPostgres(t)
	if _, err := pool.Exec(context.Background(), `
DROP TABLE workflow_control_budget_reconciliations;
DROP TABLE workflow_control_budget_receipts;
DROP TABLE workflow_control_budget_reservations;
DROP TABLE workflow_control_budget_ledger;
DROP TABLE workflow_control_budget_accounts;`); err != nil {
		t.Fatalf("remove empty later budget namespace: %v", err)
	}
	repository := New(pool)
	accept := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)
	if _, err := repository.Mutate(context.Background(), accept); err != nil {
		t.Fatalf("accept without budget namespace: %v", err)
	}
	created := authoritycontract.RunCreated
	transition := mutationInput(t, authoritystore.OperationTransition, &created, authoritycontract.RunRunning, 1)
	if _, err := repository.Mutate(context.Background(), transition); err != nil {
		t.Fatalf("transition without budget namespace: %v", err)
	}
	head, err := repository.Read(context.Background(), "workspace-test", "run-test")
	if err != nil || head.Revision != 2 || head.State != authoritycontract.RunRunning {
		t.Fatalf("head without budget namespace=%#v err=%v", head, err)
	}
}

func TestGS9BAuthoritySameKeyDifferentFingerprintConflicts(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := New(pool)
	input := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)
	if _, err := repository.Mutate(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	input.RequestFingerprint = "sha256:" + strings.Repeat("f", 64)
	if _, err := repository.Mutate(context.Background(), input); !authoritystore.IsCode(err, authoritystore.ErrorIdempotencyConflict) {
		t.Fatalf("same key with different fingerprint err=%v", err)
	}
}

func TestGS9BAuthorityTransitionCASAndOutboxAtomicity(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := New(pool)
	accept := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)
	if _, err := repository.Mutate(context.Background(), accept); err != nil {
		t.Fatal(err)
	}
	created := authoritycontract.RunCreated
	transition := mutationInput(t, authoritystore.OperationTransition, &created, authoritycontract.RunRunning, 1)
	if _, err := repository.Mutate(context.Background(), transition); err != nil {
		t.Fatalf("transition: %v", err)
	}
	head, err := repository.Read(context.Background(), "workspace-test", "run-test")
	if err != nil || head.Revision != 2 || head.State != authoritycontract.RunRunning {
		t.Fatalf("head=%#v err=%v", head, err)
	}
	if _, err := repository.ReadOutbox(context.Background(), head.WorkspaceID, head.RunID, 2); err != nil {
		t.Fatalf("read transition outbox: %v", err)
	}
	stale := mutationInput(t, authoritystore.OperationTransition, &created, authoritycontract.RunCancelled, 1)
	if _, err := repository.Mutate(context.Background(), stale); !authoritystore.IsCode(err, authoritystore.ErrorConflict) {
		t.Fatalf("stale transition err=%v", err)
	}
	statistics, err := repository.Statistics(context.Background())
	if err != nil || statistics.Runs != 1 || statistics.Receipts != 2 || statistics.TransitionEvents != 2 || statistics.OutboxPending != 2 {
		t.Fatalf("statistics=%#v err=%v", statistics, err)
	}
}

func TestGS9BAuthorityRouteDriftConflicts(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := New(pool)
	if _, err := repository.Mutate(context.Background(), mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)); err != nil {
		t.Fatal(err)
	}
	created := authoritycontract.RunCreated
	drifted := mutationInputWithRoute(t, authoritystore.OperationTransition, &created, authoritycontract.RunRunning, 1, 8, strings.Repeat("e", 64))
	if _, err := repository.Mutate(context.Background(), drifted); !authoritystore.IsCode(err, authoritystore.ErrorConflict) {
		t.Fatalf("route drift err=%v", err)
	}
	head, err := repository.Read(context.Background(), "workspace-test", "run-test")
	if err != nil || head.Revision != 1 || head.Route.RoutingEpoch != 7 {
		t.Fatalf("route drift changed head: head=%#v err=%v", head, err)
	}
}

func TestGS9BAuthorityConcurrentCASHasOneWinner(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := New(pool)
	if _, err := repository.Mutate(context.Background(), mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)); err != nil {
		t.Fatal(err)
	}
	created := authoritycontract.RunCreated
	inputs := []authoritystore.MutateInput{
		mutationInput(t, authoritystore.OperationTransition, &created, authoritycontract.RunRunning, 1),
		mutationInput(t, authoritystore.OperationTransition, &created, authoritycontract.RunCancelled, 1),
	}
	var wait sync.WaitGroup
	errorsSeen := make(chan error, len(inputs))
	for _, input := range inputs {
		wait.Add(1)
		go func(current authoritystore.MutateInput) {
			defer wait.Done()
			_, err := repository.Mutate(context.Background(), current)
			errorsSeen <- err
		}(input)
	}
	wait.Wait()
	close(errorsSeen)
	accepted, conflicts := 0, 0
	for err := range errorsSeen {
		if err == nil {
			accepted++
		} else if authoritystore.IsCode(err, authoritystore.ErrorConflict) {
			conflicts++
		} else {
			t.Fatalf("unexpected concurrent error: %v", err)
		}
	}
	if accepted != 1 || conflicts != 1 {
		t.Fatalf("accepted=%d conflicts=%d", accepted, conflicts)
	}
}

func TestGS9BAuthorityCommittedResponseLossRecoversExactReceipt(t *testing.T) {
	pool := openAuthorityPostgres(t)
	responseLost := errors.New("injected committed response loss")
	repository := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return responseLost
	})
	input := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)
	recovered, err := repository.Mutate(context.Background(), input)
	if err != nil || recovered.Value.Status != authoritycontract.ReceiptAccepted {
		t.Fatalf("recovered=%#v err=%v", recovered, err)
	}
	persisted, err := New(pool).ReadReceipt(context.Background(), "workspace-test", input.IdempotencyKey)
	if err != nil || !bytes.Equal(recovered.ExactBytes, persisted.ExactBytes) {
		t.Fatalf("persisted=%#v err=%v", persisted, err)
	}
}

func TestGS9BAuthorityUnknownCommitPersistsReconciliationWithoutHead(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := NewWithCommitter(pool, rollbackWithError("injected ambiguous uncommitted outcome"))
	input := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)
	reconciled, err := repository.Mutate(context.Background(), input)
	if err != nil || reconciled.Value.Status != authoritycontract.ReceiptReconciliationRequired || reconciled.Value.AcceptedRevision != nil ||
		reconciled.Value.RecordHash != nil || reconciled.Value.CommittedAt != nil || reconciled.Value.ReconciliationToken == nil {
		t.Fatalf("reconciled=%#v err=%v", reconciled, err)
	}
	if _, err := New(pool).Read(context.Background(), "workspace-test", "run-test"); !authoritystore.IsCode(err, authoritystore.ErrorNotFound) {
		t.Fatalf("ambiguous uncommitted mutation advanced head: %v", err)
	}
	statistics, err := New(pool).Statistics(context.Background())
	if err != nil || statistics.Runs != 0 || statistics.TransitionEvents != 0 || statistics.OutboxPending != 0 || statistics.ReconciliationPending != 1 {
		t.Fatalf("statistics=%#v err=%v", statistics, err)
	}
	replay, err := New(pool).Mutate(context.Background(), input)
	if err != nil || !bytes.Equal(reconciled.ExactBytes, replay.ExactBytes) || !replay.Replay {
		t.Fatalf("reconciliation replay=%#v err=%v", replay, err)
	}
}

func TestGS9BAuthorityDoubleUnknownFailsClosed(t *testing.T) {
	pool := openAuthorityPostgres(t)
	repository := NewWithCommitters(
		pool,
		rollbackWithError("injected primary commit unknown"),
		rollbackWithError("injected reconciliation commit unknown"),
	)
	input := mutationInput(t, authoritystore.OperationAccept, nil, authoritycontract.RunCreated, 0)
	if _, err := repository.Mutate(context.Background(), input); !authoritystore.IsCode(err, authoritystore.ErrorCommitUnknown) {
		t.Fatalf("double unknown err=%v", err)
	}
	statistics, err := New(pool).Statistics(context.Background())
	if err != nil || statistics.Runs != 0 || statistics.Receipts != 0 || statistics.ReconciliationPending != 0 {
		t.Fatalf("double unknown persisted an unconfirmed claim: statistics=%#v err=%v", statistics, err)
	}
}

func mutationInput(t testing.TB, operation authoritystore.Operation, from *authoritystore.RunState, to authoritystore.RunState, expectedRevision int64) authoritystore.MutateInput {
	return mutationInputWithRoute(t, operation, from, to, expectedRevision, 7, strings.Repeat("d", 64))
}

func mutationInputWithRoute(
	t testing.TB,
	operation authoritystore.Operation,
	from *authoritystore.RunState,
	to authoritystore.RunState,
	expectedRevision int64,
	routingEpoch int64,
	build string,
) authoritystore.MutateInput {
	t.Helper()
	route := authoritystore.Route{Backend: authoritystore.Backend, Authority: authoritystore.Authority, RoutingEpoch: routingEpoch, AuthorityBuildHash: build}
	schema := authoritystore.TransitionSchema
	if operation == authoritystore.OperationAccept {
		schema = authoritystore.AcceptSchema
	}
	envelope := authoritystore.RequestEnvelope{
		Schema: schema, Operation: operation, WorkspaceID: "workspace-test", RunID: "run-test",
		Expected: authoritystore.ExpectedBinding{Revision: expectedRevision, State: from, ResumeGeneration: 0},
		Route:    route, CorrelationID: "correlation-test",
		Record: authoritystore.RunRecord{
			Schema: authoritystore.RunRecordSchema, WorkspaceID: "workspace-test", RunID: "run-test",
			WorkflowID: "workflow-test", WorkflowVersion: "1.0.0",
			WorkflowSourceHash: strings.Repeat("a", 64), ManifestHash: strings.Repeat("b", 64),
			InputHash: strings.Repeat("c", 64), Route: route, State: to,
			Revision: expectedRevision + 1, ResumeGeneration: 0,
		},
	}
	body, err := canonicaljson.Encode(envelope)
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	prepared, err := authoritystore.PrepareRequest(body, "caller-test", envelope.WorkspaceID, strconv.FormatInt(routingEpoch, 10), build)
	if err != nil {
		t.Fatalf("prepare mutation: %v", err)
	}
	return authoritystore.MutateInput{
		Prepared: prepared, IdempotencyKey: authoritystore.ExpectedIdempotencyKey(body),
		RequestFingerprint: authoritystore.RequestFingerprint("POST", authoritystore.RequestPath(operation, envelope.RunID), prepared),
		ServiceBuildHash:   build,
	}
}

func rollbackWithError(message string) func(context.Context, pgx.Tx) error {
	return func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Rollback(ctx); err != nil {
			return err
		}
		return errors.New(message)
	}
}

func receiptReadError(repository *Repository, input authoritystore.MutateInput) error {
	_, err := repository.ReadReceipt(context.Background(), input.Prepared.Envelope.WorkspaceID, input.IdempotencyKey)
	return err
}

func receiptReplayError(repository *Repository, input authoritystore.MutateInput) error {
	_, err := repository.Mutate(context.Background(), input)
	return err
}

func tamperAuthorityRow(t *testing.T, pool *pgxpool.Pool, disableTrigger, update, enableTrigger string, arguments ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), disableTrigger); err != nil {
		t.Fatalf("disable immutable trigger: %v", err)
	}
	triggerEnabled := false
	t.Cleanup(func() {
		if !triggerEnabled {
			_, _ = pool.Exec(context.Background(), enableTrigger)
		}
	})
	if _, err := pool.Exec(context.Background(), update, arguments...); err != nil {
		t.Fatalf("tamper stored authority row: %v", err)
	}
	if _, err := pool.Exec(context.Background(), enableTrigger); err != nil {
		t.Fatalf("restore immutable trigger: %v", err)
	}
	triggerEnabled = true
}

func openAuthorityPostgres(t testing.TB) *pgxpool.Pool {
	t.Helper()
	return testsupport.OpenPostgres(t)
}
