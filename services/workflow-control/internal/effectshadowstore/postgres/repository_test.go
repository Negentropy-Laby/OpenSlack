package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/effectshadowstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

type effectGolden struct {
	SourceEnvelopes map[string]struct {
		CanonicalBytes string `json:"canonicalBytes"`
	} `json:"sourceEnvelopes"`
}

func effectPrepared(t *testing.T, name string) effectshadowstore.PreparedObservation {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "..", "packages", "workflows", "contracts", "workflow-effect-shadow", "v1", "golden-vectors.json")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var golden effectGolden
	if err := json.Unmarshal(body, &golden); err != nil {
		t.Fatal(err)
	}
	vector, ok := golden.SourceEnvelopes[name]
	if !ok {
		t.Fatalf("missing effect golden %q", name)
	}
	prepared, err := effectshadowstore.PrepareObservation(append([]byte(vector.CanonicalBytes), '\n'))
	if err != nil {
		t.Fatal(err)
	}
	return prepared
}

func effectInput(prepared effectshadowstore.PreparedObservation, _ string) effectshadowstore.ObserveInput {
	key := effectshadowstore.IdempotencyPrefix + prepared.EnvelopeHash
	return effectshadowstore.ObserveInput{
		Prepared:           prepared,
		IdempotencyKey:     key,
		RequestFingerprint: effectshadowstore.Fingerprint("POST", effectshadowstore.Route, key, prepared.ExactBody),
		ServiceBuildHash:   strings.Repeat("f", 64),
	}
}

func effectReprepare(t *testing.T, prepared effectshadowstore.PreparedObservation) effectshadowstore.PreparedObservation {
	t.Helper()
	observationBytes, err := canonicaljson.Encode(prepared.Envelope.Observation)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.New()
	_, _ = hash.Write([]byte("openslack.workflow-effect-control.observation.v1\x00"))
	_, _ = hash.Write(observationBytes)
	prepared.Envelope.ObservationHash = hex.EncodeToString(hash.Sum(nil))
	envelopeBytes, err := canonicaljson.Encode(prepared.Envelope)
	if err != nil {
		t.Fatal(err)
	}
	result, err := effectshadowstore.PrepareObservation(append(envelopeBytes, '\n'))
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestGS9DEffectShadowLifecycleOutboxAndExactReplay(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := New(pool)
	ctx := context.Background()
	created := effectInput(effectPrepared(t, "approvalCreated"), "1")
	first, err := repository.Observe(ctx, created)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := repository.Observe(ctx, created)
	if err != nil || !replay.Replay || !bytes.Equal(first.ExactBytes, replay.ExactBytes) {
		t.Fatalf("created replay=%#v err=%v", replay.Value, err)
	}
	workspace := created.Prepared.Envelope.Observation.WorkspaceID
	if pending, err := repository.ReadPendingOutbox(ctx, workspace, 100, ""); err != nil || len(pending.Items) != 0 {
		t.Fatalf("created outbox=%#v err=%v", pending, err)
	}
	for index, item := range []struct {
		name   string
		suffix string
		event  effectshadowstore.OutboxEventType
	}{
		{name: "approvalDecided", suffix: "2", event: effectshadowstore.OutboxEffectDecisionObserved},
		{name: "auditRecorded", suffix: "3", event: effectshadowstore.OutboxEffectAuditRecorded},
	} {
		input := effectInput(effectPrepared(t, item.name), item.suffix)
		if _, err := repository.Observe(ctx, input); err != nil {
			t.Fatalf("%s: %v", item.name, err)
		}
		pending, err := repository.ReadPendingOutbox(ctx, workspace, 100, "")
		if err != nil || len(pending.Items) != index+1 || pending.Items[index].EventType != item.event || pending.Items[index].Status != "pending" || pending.Items[index].Payload.GoEffectDecisionAuthority || pending.Items[index].Payload.GoEffectExecutionAuthority {
			t.Fatalf("%s outbox=%#v err=%v", item.name, pending, err)
		}
	}
	head, err := repository.ReadHead(ctx, workspace, created.Prepared.Envelope.Observation.RunID, created.Prepared.Envelope.Observation.OccurrenceID, created.Prepared.Envelope.Observation.ApprovalID)
	if err != nil || head.SourceSequence != 3 || head.MatchedSourceSequence == nil || *head.MatchedSourceSequence != 3 || head.MismatchLatched {
		t.Fatalf("head=%#v err=%v", head, err)
	}
	statistics, err := repository.Statistics(ctx)
	if err != nil || statistics.Heads != 1 || statistics.Observations != 3 || statistics.Receipts != 3 || statistics.OutboxPending != 2 || statistics.ReconciliationPending != 0 {
		t.Fatalf("statistics=%#v err=%v", statistics, err)
	}
	if _, err := repository.ReadPendingOutbox(ctx, workspace, 0, ""); !effectshadowstore.IsCode(err, effectshadowstore.ErrorInputInvalid) {
		t.Fatalf("invalid outbox limit=%v", err)
	}
}

func TestGS9DEffectShadowOutboxPaginationTraversesBeyondFirstHundred(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := New(pool)
	ctx := context.Background()
	const workspace = "workspace-page"
	base := time.Date(2026, 8, 14, 1, 2, 3, 123000000, time.UTC)
	for index := 0; index < 101; index++ {
		runID := fmt.Sprintf("run-page-%03d", index)
		approvalID := fmt.Sprintf("WFAPPROVAL-page-%03d", index)
		observationID := fmt.Sprintf("wecs-observation-page-%03d", index)
		eventID := fmt.Sprintf("WECS-OUTBOX-page-%03d", index)
		occurrenceDigest := sha256.Sum256([]byte(fmt.Sprintf("occurrence-%03d", index)))
		occurrenceID := "WFOCCURRENCE-" + hex.EncodeToString(occurrenceDigest[:])
		observationDigest := sha256.Sum256([]byte(observationID))
		auditDigest := sha256.Sum256([]byte(runID + "\x00" + approvalID + "\x00decision-revision-1"))
		payload := effectshadowstore.OutboxPayload{
			Schema: effectshadowstore.OutboxPayloadSchema, EventID: eventID,
			EventType: effectshadowstore.OutboxEffectDecisionObserved, Authority: "typescript", GoRole: "observer_only",
			NonAuthorizingObservation: true, GoEffectDecisionAuthority: false, GoEffectExecutionAuthority: false,
			WorkspaceID: workspace, RunID: runID, OccurrenceID: occurrenceID, ApprovalID: approvalID,
			SourceSequence: 2, Operation: effectshadowstore.OperationApprovalDecided, ObservationID: observationID,
			ObservationHash: hex.EncodeToString(observationDigest[:]), ApprovalStatus: "approved", Decision: "approved",
			AuditEventID: "WFAPPROVAL-AUDIT-" + hex.EncodeToString(auditDigest[:]), BindingHash: strings.Repeat("a", 64),
			ObservedAt: "2026-08-14T01:02:03.000Z",
		}
		if err := effectshadowstore.ValidateOutboxPayload(payload); err != nil {
			t.Fatal(err)
		}
		exact, err := canonicaljson.Encode(payload)
		if err != nil {
			t.Fatal(err)
		}
		payloadDigest := sha256.Sum256(exact)
		if _, err := pool.Exec(ctx, `INSERT INTO workflow_control_effect_shadow_observations (observation_id,workspace_id,run_id,occurrence_id,approval_id,source_sequence,operation,parity,envelope_hash,exact_envelope_bytes,observation_hash,exact_observation_bytes,recorded_at) VALUES ($1,$2,$3,$4,$5,2,'approval_decided','matched',$6,'{}',$7,'{}',$8)`, observationID, workspace, runID, occurrenceID, approvalID, observationDigest[:], observationDigest[:], base.Add(time.Duration(index)*time.Microsecond)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO workflow_control_effect_shadow_outbox (event_id,event_type,workspace_id,run_id,occurrence_id,approval_id,source_sequence,operation,observation_id,observation_hash,payload_hash,canonical_payload_bytes,recorded_at) VALUES ($1,'effect_decision_observed',$2,$3,$4,$5,2,'approval_decided',$6,$7,$8,$9,$10)`, eventID, workspace, runID, occurrenceID, approvalID, observationID, observationDigest[:], payloadDigest[:], exact, base.Add(time.Duration(index)*time.Microsecond)); err != nil {
			t.Fatal(err)
		}
	}

	seen := make(map[string]bool, 101)
	cursor := ""
	for {
		page, err := repository.ReadPendingOutbox(ctx, workspace, 17, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if page.Count != len(page.Items) || page.Count > 17 {
			t.Fatalf("page count=%d items=%d", page.Count, len(page.Items))
		}
		for _, item := range page.Items {
			if seen[item.EventID] {
				t.Fatalf("duplicate outbox event %s", item.EventID)
			}
			seen[item.EventID] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 101 {
		t.Fatalf("traversed %d outbox events, want 101", len(seen))
	}
}

func TestGS9DEffectShadowMismatchDoesNotCreateOutbox(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := New(pool)
	ctx := context.Background()
	created := effectInput(effectPrepared(t, "approvalCreated"), "4")
	if _, err := repository.Observe(ctx, created); err != nil {
		t.Fatal(err)
	}
	decided := effectPrepared(t, "approvalDecided")
	decided.Envelope.Observation.EffectHash = strings.Repeat("0", 64)
	decided.Envelope.Observation.EffectID = "workflow-effect:sha256:" + decided.Envelope.Observation.EffectHash
	decided = effectReprepare(t, decided)
	receipt, err := repository.Observe(ctx, effectInput(decided, "5"))
	if err != nil || receipt.Value.Parity != "mismatched" {
		t.Fatalf("mismatch receipt=%#v err=%v", receipt.Value, err)
	}
	pending, err := repository.ReadPendingOutbox(ctx, created.Prepared.Envelope.Observation.WorkspaceID, 100, "")
	if err != nil || len(pending.Items) != 0 {
		t.Fatalf("mismatched outbox=%#v err=%v", pending, err)
	}
}

func TestGS9DEffectShadowCommittedResponseLossKeepsOutboxAtomic(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	ctx := context.Background()
	normal := New(pool)
	if _, err := normal.Observe(ctx, effectInput(effectPrepared(t, "approvalCreated"), "6")); err != nil {
		t.Fatal(err)
	}
	responseLost := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errors.New("response lost")
	})
	decision := effectInput(effectPrepared(t, "approvalDecided"), "7")
	receipt, err := responseLost.Observe(ctx, decision)
	if err != nil || receipt.Value.Status != "accepted" {
		t.Fatalf("response loss receipt=%#v err=%v", receipt.Value, err)
	}
	pending, err := normal.ReadPendingOutbox(ctx, decision.Prepared.Envelope.Observation.WorkspaceID, 100, "")
	if err != nil || len(pending.Items) != 1 || pending.Items[0].EventType != effectshadowstore.OutboxEffectDecisionObserved {
		t.Fatalf("response loss outbox=%#v err=%v", pending, err)
	}
}

func TestGS9DEffectShadowRejectsCorruptOutboxPayload(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := New(pool)
	ctx := context.Background()
	if _, err := repository.Observe(ctx, effectInput(effectPrepared(t, "approvalCreated"), "8")); err != nil {
		t.Fatal(err)
	}
	decision := effectInput(effectPrepared(t, "approvalDecided"), "9")
	if _, err := repository.Observe(ctx, decision); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE workflow_control_effect_shadow_outbox DISABLE TRIGGER workflow_control_effect_shadow_outbox_immutable`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workflow_control_effect_shadow_outbox SET canonical_payload_bytes=canonical_payload_bytes || decode('20','hex')`); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ReadPendingOutbox(ctx, decision.Prepared.Envelope.Observation.WorkspaceID, 100, ""); !effectshadowstore.IsCode(err, effectshadowstore.ErrorIntegrity) {
		t.Fatalf("corrupt outbox=%v", err)
	}
}

func TestGS9DEffectShadowConflictsConcurrencyAndStoredIntegrity(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	repository := New(pool)
	ctx := context.Background()
	created := effectInput(effectPrepared(t, "approvalCreated"), "a")
	if _, err := repository.Observe(ctx, created); err != nil {
		t.Fatal(err)
	}
	conflicting := created
	conflicting.RequestFingerprint = strings.Repeat("0", 64)
	if _, err := repository.Observe(ctx, conflicting); !effectshadowstore.IsCode(err, effectshadowstore.ErrorIdempotencyConflict) {
		t.Fatalf("fingerprint conflict=%v", err)
	}
	if _, err := repository.Observe(ctx, effectInput(effectPrepared(t, "auditRecorded"), "b")); !effectshadowstore.IsCode(err, effectshadowstore.ErrorConflict) {
		t.Fatalf("sequence gap=%v", err)
	}
	decision := effectPrepared(t, "approvalDecided")
	alternative := effectPrepared(t, "approvalDecided")
	alternative.Envelope.Observation.ApprovalHash = strings.Repeat("e", 64)
	alternative = effectReprepare(t, alternative)
	inputs := []effectshadowstore.ObserveInput{effectInput(decision, "c"), effectInput(alternative, "d")}
	var wait sync.WaitGroup
	errorsSeen := make(chan error, len(inputs))
	for _, input := range inputs {
		wait.Add(1)
		go func(input effectshadowstore.ObserveInput) {
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
		case effectshadowstore.IsCode(err, effectshadowstore.ErrorConflict):
			conflicts++
		default:
			t.Fatalf("concurrent decision=%v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent outcomes success=%d conflict=%d", successes, conflicts)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE workflow_control_effect_shadow_receipts DISABLE TRIGGER workflow_control_effect_shadow_receipts_immutable`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workflow_control_effect_shadow_receipts SET exact_receipt_bytes='{}'::bytea WHERE idempotency_key=$1`, created.IdempotencyKey); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ReadReceipt(ctx, created.Prepared.Envelope.Observation.WorkspaceID, created.IdempotencyKey); !effectshadowstore.IsCode(err, effectshadowstore.ErrorIntegrity) {
		t.Fatalf("corrupt receipt=%v", err)
	}
	if _, err := pool.Exec(ctx, `ALTER TABLE workflow_control_effect_shadow_heads DISABLE TRIGGER workflow_control_effect_shadow_head_transition`); err != nil {
		t.Fatal(err)
	}
	o := created.Prepared.Envelope.Observation
	if _, err := pool.Exec(ctx, `UPDATE workflow_control_effect_shadow_heads SET last_observation_hash=decode(repeat('00',32),'hex') WHERE workspace_id=$1 AND run_id=$2 AND occurrence_id=$3 AND approval_id=$4`, o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ReadHead(ctx, o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID); !effectshadowstore.IsCode(err, effectshadowstore.ErrorIntegrity) {
		t.Fatalf("corrupt head=%v", err)
	}
}

func TestGS9DEffectShadowCommitUnknownReconciliationAndDoubleUnknown(t *testing.T) {
	t.Run("rollback becomes durable reconciliation", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		rollback := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
			_ = tx.Rollback(ctx)
			return errors.New("commit outcome unknown")
		})
		input := effectInput(effectPrepared(t, "approvalCreated"), "e")
		receipt, err := rollback.Observe(context.Background(), input)
		if err != nil || receipt.Value.Status != "reconciliation_required" || receipt.Value.Parity != "unknown" || receipt.Value.ReconciliationToken == nil {
			t.Fatalf("reconciliation=%#v err=%v", receipt.Value, err)
		}
		replay, err := New(pool).Observe(context.Background(), input)
		if err != nil || !replay.Replay || !bytes.Equal(receipt.ExactBytes, replay.ExactBytes) {
			t.Fatalf("reconciliation replay=%#v err=%v", replay.Value, err)
		}
		pending, err := New(pool).ReadPendingOutbox(context.Background(), input.Prepared.Envelope.Observation.WorkspaceID, 100, "")
		if err != nil || len(pending.Items) != 0 {
			t.Fatalf("reconciliation outbox=%#v err=%v", pending, err)
		}
		resolver := New(pool)
		resolver.commitResolution = func(ctx context.Context, tx pgx.Tx) error {
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			return errors.New("resolution response lost")
		}
		resolved, err := resolver.ResolveReconciliation(context.Background(), effectshadowstore.ResolveInput{ReconciliationToken: *receipt.Value.ReconciliationToken, ObserveInput: input})
		if err != nil || resolved.Value.Status != "accepted" || !resolved.Replay {
			t.Fatalf("resolved reconciliation=%#v replay=%t err=%v", resolved.Value, resolved.Replay, err)
		}
		resolvedReplay, err := New(pool).ResolveReconciliation(context.Background(), effectshadowstore.ResolveInput{ReconciliationToken: *receipt.Value.ReconciliationToken, ObserveInput: input})
		if err != nil || !resolvedReplay.Replay || !bytes.Equal(resolved.ExactBytes, resolvedReplay.ExactBytes) {
			t.Fatalf("resolution replay=%#v replay=%t err=%v", resolvedReplay.Value, resolvedReplay.Replay, err)
		}
		originalReplay, err := New(pool).Observe(context.Background(), input)
		if err != nil || originalReplay.Value.Status != "reconciliation_required" || !bytes.Equal(receipt.ExactBytes, originalReplay.ExactBytes) {
			t.Fatalf("original receipt changed=%#v err=%v", originalReplay.Value, err)
		}
		if _, err := New(pool).Observe(context.Background(), effectInput(effectPrepared(t, "approvalDecided"), "1")); err != nil {
			t.Fatalf("next source sequence after resolution: %v", err)
		}
		statistics, err := New(pool).Statistics(context.Background())
		if err != nil || statistics.ReconciliationPending != 0 || statistics.Observations != 2 {
			t.Fatalf("resolution statistics=%#v err=%v", statistics, err)
		}
	})

	t.Run("double unknown fails closed", func(t *testing.T) {
		pool := testsupport.OpenPostgres(t)
		rollback := func(ctx context.Context, tx pgx.Tx) error {
			_ = tx.Rollback(ctx)
			return errors.New("commit outcome unknown")
		}
		repository := NewWithCommitters(pool, rollback, rollback)
		if _, err := repository.Observe(context.Background(), effectInput(effectPrepared(t, "approvalCreated"), "f")); !effectshadowstore.IsCode(err, effectshadowstore.ErrorCommitUnknown) {
			t.Fatalf("double unknown=%v", err)
		}
		var receipts, outbox int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM workflow_control_effect_shadow_receipts`).Scan(&receipts); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM workflow_control_effect_shadow_outbox`).Scan(&outbox); err != nil {
			t.Fatal(err)
		}
		if receipts != 0 || outbox != 0 {
			t.Fatalf("double unknown receipts=%d outbox=%d", receipts, outbox)
		}
	})
}

func TestGS9DEffectShadowCommitUnknownRereadsReceiptAfterScopeLock(t *testing.T) {
	pool := testsupport.OpenPostgres(t)
	input := effectInput(effectPrepared(t, "approvalCreated"), "a")
	reached := make(chan struct{})
	release := make(chan struct{})
	unknown := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		_ = tx.Rollback(ctx)
		return errors.New("commit outcome unknown")
	})
	unknown.beforeReconcileLock = func() {
		close(reached)
		<-release
	}
	type outcome struct {
		receipt effectshadowstore.Receipt
		err     error
	}
	result := make(chan outcome, 1)
	go func() {
		receipt, err := unknown.Observe(context.Background(), input)
		result <- outcome{receipt: receipt, err: err}
	}()
	<-reached
	accepted, err := New(pool).Observe(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	recovered := <-result
	if recovered.err != nil || !bytes.Equal(recovered.receipt.ExactBytes, accepted.ExactBytes) || recovered.receipt.Value.Status != "accepted" {
		t.Fatalf("recovered=%#v err=%v accepted=%#v", recovered.receipt.Value, recovered.err, accepted.Value)
	}
}
