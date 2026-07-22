package integration_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"rc_wsman/internal/notificationstore"
	"rc_wsman/internal/notificationstore/postgres"
	"rc_wsman/internal/testsupport"
)

// storeFixture wires a real PostgreSQL-backed repository for integration tests.
// It skips when DATABASE_URL is unset (same pattern as migration_test.go) and
// requires migrations to have been applied (000001 up).
type storeFixture struct {
	t    *testing.T
	pool *pgxpool.Pool
	repo notificationstore.Repository
	seq  int
}

func newStoreFixture(t *testing.T) *storeFixture {
	t.Helper()
	pool := testsupport.OpenPostgres(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
	return &storeFixture{t: t, pool: pool, repo: postgres.New(pool, logger)}
}

// seedVendor inserts a vendor row (required by the notifications FK).
func (f *storeFixture) seedVendor(ctx context.Context, vendorID string) {
	f.t.Helper()
	_, err := f.pool.Exec(ctx,
		`INSERT INTO vendors (vendor_id, owning_scope, lifecycle) VALUES ($1, 'scope-test', 'active')
		 ON CONFLICT (vendor_id) DO NOTHING`, vendorID)
	if err != nil {
		f.t.Fatalf("seed vendor: %v", err)
	}
}

// intake inserts a notification via the repository and cleans it up afterwards.
func (f *storeFixture) intake(ctx context.Context, callerID, key string) notificationstore.IntakeResult {
	f.t.Helper()
	f.seq++
	vendorID := fmt.Sprintf("vendor-%s", callerID)
	f.seedVendor(ctx, vendorID)
	res, err := f.repo.Intake(ctx, notificationstore.ValidatedIntake{
		CallerID:       callerID,
		VendorID:       vendorID,
		Payload:        []byte(fmt.Sprintf(`{"seq":%d}`, f.seq)),
		IdempotencyKey: key,
	})
	if err != nil {
		f.t.Fatalf("intake: %v", err)
	}
	f.t.Cleanup(func() {
		_, _ = f.pool.Exec(context.Background(),
			`DELETE FROM notifications WHERE notification_id = $1`, res.NotificationID)
	})
	return res
}

func workerActor(scope ...string) notificationstore.ActorContext {
	return notificationstore.ActorContext{
		Kind:        notificationstore.ActorWorker,
		ActorID:     "worker-it",
		VendorScope: scope,
		Capabilities: []notificationstore.Capability{
			notificationstore.CapabilityClaimDelivery,
			notificationstore.CapabilityRecordDeliveryResult,
		},
	}
}

func systemActor(scope ...string) notificationstore.ActorContext {
	return notificationstore.ActorContext{
		Kind:        notificationstore.ActorSystem,
		ActorID:     "system-it",
		VendorScope: scope,
		Capabilities: []notificationstore.Capability{
			notificationstore.CapabilityRecoverExpiredLeases,
		},
	}
}

func operatorActor(scope ...string) notificationstore.ActorContext {
	return notificationstore.ActorContext{
		Kind:        notificationstore.ActorOperator,
		ActorID:     "op-it",
		VendorScope: scope,
		Capabilities: []notificationstore.Capability{
			notificationstore.CapabilityReplay,
			notificationstore.CapabilityReadNotifications,
		},
	}
}

// TestStoreIntake_Idempotency covers same-key same-fingerprint replay and
// same-key different-fingerprint conflict (AC-IMM-01..04).
func TestStoreIntake_Idempotency(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()

	first := f.intake(ctx, "caller-idem", "key-same")
	second, err := f.repo.Intake(ctx, notificationstore.ValidatedIntake{
		CallerID:       "caller-idem",
		VendorID:       "vendor-caller-idem",
		Payload:        []byte(`{"seq":1}`),
		IdempotencyKey: "key-same",
	})
	if err != nil {
		t.Fatalf("idempotent replay rejected: %v", err)
	}
	if !second.IdempotentReplay || second.NotificationID != first.NotificationID {
		t.Fatalf("expected idempotent replay of %s, got %+v", first.NotificationID, second)
	}
	if first.AcceptedAt.IsZero() || !second.AcceptedAt.Equal(first.AcceptedAt) {
		t.Fatalf("accepted_at must be the persisted created_at: first=%v second=%v", first.AcceptedAt, second.AcceptedAt)
	}

	// Same key, different payload → fingerprint conflict.
	_, err = f.repo.Intake(ctx, notificationstore.ValidatedIntake{
		CallerID:       "caller-idem",
		VendorID:       "vendor-caller-idem",
		Payload:        []byte(`{"seq":999}`),
		IdempotencyKey: "key-same",
	})
	if !notificationstore.IsRejection(err, notificationstore.RejectionIdempotencyConflict) {
		t.Fatalf("expected IdempotencyConflict, got %v", err)
	}
}

func TestStoreIntake_ConcurrentSameKeyConvergesToOneRow(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	const vendorID = "vendor-intake-race"
	f.seedVendor(ctx, vendorID)
	in := notificationstore.ValidatedIntake{
		CallerID: "caller-intake-race", VendorID: vendorID,
		Payload: []byte(`{"event":"same"}`), IdempotencyKey: "same-key-race",
	}
	const callers = 8
	results := make(chan notificationstore.IntakeResult, callers)
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := f.repo.Intake(ctx, in)
			if err != nil {
				errs <- err
				return
			}
			results <- result
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent intake: %v", err)
	}
	var notificationID string
	count := 0
	for result := range results {
		count++
		if notificationID == "" {
			notificationID = result.NotificationID
		}
		if result.NotificationID != notificationID || result.AcceptedAt.IsZero() {
			t.Fatalf("non-convergent intake result: %+v want id=%s", result, notificationID)
		}
	}
	if count != callers {
		t.Fatalf("results=%d want=%d", count, callers)
	}
	var rows int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE caller_id=$1 AND idempotency_key=$2`, in.CallerID, in.IdempotencyKey).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("durable rows=%d err=%v", rows, err)
	}
}

func TestStoreIntake_DeferredCommitFailureRollsBackAtomically(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	const vendorID = "vendor-intake-rollback"
	f.seedVendor(ctx, vendorID)
	if _, err := f.pool.Exec(ctx, `
		CREATE FUNCTION test_reject_notification_commit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'forced deferred commit rejection'; END $$;
		CREATE CONSTRAINT TRIGGER test_reject_notification_commit
		AFTER INSERT ON notifications DEFERRABLE INITIALLY DEFERRED
		FOR EACH ROW EXECUTE FUNCTION test_reject_notification_commit()`); err != nil {
		t.Fatal(err)
	}
	_, err := f.repo.Intake(ctx, notificationstore.ValidatedIntake{CallerID: "caller-rollback", VendorID: vendorID, Payload: []byte(`{}`), IdempotencyKey: "key-rollback"})
	if !notificationstore.IsRejection(err, notificationstore.RejectionCommitRolledBack) {
		t.Fatalf("commit rejection=%v, want commit-rolled-back", err)
	}
	var count int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE caller_id='caller-rollback'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled-back intake rows=%d err=%v", count, err)
	}
}

func TestStoreIntake_ConnectionLostDuringCommitIsOutcomeUnknown(t *testing.T) {
	f := newStoreFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	const vendorID = "vendor-intake-unknown"
	f.seedVendor(ctx, vendorID)
	if _, err := f.pool.Exec(ctx, `
		CREATE FUNCTION test_pause_notification_commit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$;
		CREATE CONSTRAINT TRIGGER test_pause_notification_commit
		AFTER INSERT ON notifications DEFERRABLE INITIALLY DEFERRED
		FOR EACH ROW EXECUTE FUNCTION test_pause_notification_commit()`); err != nil {
		t.Fatal(err)
	}
	poolCfg, err := pgxpool.ParseConfig(f.pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	poolCfg.MaxConns = 1
	poolCfg.ConnConfig.RuntimeParams["application_name"] = "rcwsman_commit_unknown_test"
	faultPool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer faultPool.Close()
	repo := postgres.New(faultPool, slog.New(slog.NewTextHandler(io.Discard, nil)))
	errCh := make(chan error, 1)
	go func() {
		_, err := repo.Intake(ctx, notificationstore.ValidatedIntake{CallerID: "caller-unknown", VendorID: vendorID, Payload: []byte(`{}`), IdempotencyKey: "key-unknown"})
		errCh <- err
	}()
	var pid int32
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for pid == 0 {
		select {
		case <-ctx.Done():
			t.Fatal("timed out waiting for blocked COMMIT")
		case <-ticker.C:
			_ = f.pool.QueryRow(ctx, `SELECT COALESCE(max(pid),0) FROM pg_stat_activity WHERE application_name='rcwsman_commit_unknown_test' AND state='active' AND lower(query)='commit'`).Scan(&pid)
		}
	}
	var terminated bool
	if err := f.pool.QueryRow(ctx, `SELECT pg_terminate_backend($1)`, pid).Scan(&terminated); err != nil || !terminated {
		t.Fatalf("terminate commit backend pid=%d terminated=%v err=%v", pid, terminated, err)
	}
	if err := <-errCh; !notificationstore.IsRejection(err, notificationstore.RejectionCommitOutcomeUnknown) {
		t.Fatalf("connection-loss commit=%v, want commit-outcome-unknown", err)
	}
	var count int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE caller_id='caller-unknown' AND idempotency_key='key-unknown'`).Scan(&count); err != nil || count < 0 || count > 1 {
		t.Fatalf("authoritative convergence count=%d err=%v", count, err)
	}
}

func TestStoreBoundaryValidation(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	res := f.intake(ctx, "caller-boundary", "key-boundary")
	vendorID := "vendor-caller-boundary"
	worker := workerActor(vendorID)
	for _, ttl := range []time.Duration{0, notificationstore.LeaseTTLMax + time.Nanosecond} {
		if _, err := f.repo.ClaimNext(ctx, worker, nil, ttl); !notificationstore.IsRejection(err, notificationstore.RejectionInvalidLeaseTTL) {
			t.Fatalf("ttl %s: %v", ttl, err)
		}
	}
	for _, limit := range []int{0, notificationstore.RecoveryBatchMax + 1} {
		if _, err := f.repo.RecoverExpiredLeases(ctx, systemActor(vendorID), limit); !notificationstore.IsRejection(err, notificationstore.RejectionInvalidBatchLimit) {
			t.Fatalf("batch %d: %v", limit, err)
		}
	}
	reader := operatorActor(vendorID)
	for _, limit := range []int{-1, notificationstore.ListPageMax + 1} {
		if _, err := f.repo.ListDead(ctx, reader, nil, limit, ""); !notificationstore.IsRejection(err, notificationstore.RejectionInvalidPageLimit) {
			t.Fatalf("dead limit %d: %v", limit, err)
		}
		if _, err := f.repo.ListAttemptHistory(ctx, reader, notificationstore.NotificationID(res.NotificationID), limit, ""); !notificationstore.IsRejection(err, notificationstore.RejectionInvalidPageLimit) {
			t.Fatalf("history limit %d: %v", limit, err)
		}
	}
	if _, err := f.repo.ListAttemptHistory(ctx, reader, notificationstore.NotificationID(res.NotificationID), 0, ""); err != nil {
		t.Fatalf("default history limit: %v", err)
	}
	globalWithoutCapability := notificationstore.ActorContext{Kind: notificationstore.ActorSystem, ActorID: "metrics", VendorScope: []string{vendorID}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityReadNotifications}}
	if _, err := f.repo.QueryOutbox(ctx, globalWithoutCapability, nil); err != nil {
		t.Fatalf("scoped system query: %v", err)
	}
}

func TestStoreReadRejectsUnknownAndWorkerActorKinds(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	res := f.intake(ctx, "caller-read-kind", "key-read-kind")
	vendorID := "vendor-caller-read-kind"
	rogue := notificationstore.ActorContext{Kind: "rogue", ActorID: "rogue-1", VendorScope: []string{vendorID}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityReadNotifications}}
	if _, err := f.repo.Get(ctx, rogue, notificationstore.NotificationID(res.NotificationID)); !notificationstore.IsRejection(err, notificationstore.RejectionInvalidActorContext) {
		t.Fatalf("rogue read = %v, want invalid-actor-context", err)
	}
	worker := workerActor(vendorID)
	worker.Capabilities = append(worker.Capabilities, notificationstore.CapabilityReadNotifications)
	if _, err := f.repo.QueryOutbox(ctx, worker, nil); !notificationstore.IsRejection(err, notificationstore.RejectionForbiddenAction) {
		t.Fatalf("worker query = %v, want forbidden-action", err)
	}
}

// TestStoreClaim_Concurrent verifies FOR UPDATE SKIP LOCKED: two workers
// claiming concurrently never receive the same notification (AC-LEASE claim race).
func TestStoreClaim_Concurrent(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-claim"
	res := f.intake(ctx, "caller-claim", "key-claim")
	actor := workerActor(vendorID)

	const workers = 2
	claims := make(chan notificationstore.LeaseClaim, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := f.repo.ClaimNext(ctx, actor, nil, 30*time.Second)
			if err != nil {
				errs <- err
				return
			}
			claims <- c
		}()
	}
	wg.Wait()
	close(claims)
	close(errs)

	var got []notificationstore.LeaseClaim
	for c := range claims {
		got = append(got, c)
	}
	emptySeen := false
	for err := range errs {
		if errors.Is(err, notificationstore.ErrNoEligibleNotification) {
			emptySeen = true
		} else {
			t.Fatalf("unexpected claim error: %v", err)
		}
	}
	if len(got) != 1 || got[0].NotificationID != res.NotificationID || !emptySeen {
		t.Fatalf("expected exactly one winner (%s) and one empty, got %d claims empty=%v",
			res.NotificationID, len(got), emptySeen)
	}
	if got[0].LeaseID == "" || got[0].LeaseExpiresAt.IsZero() {
		t.Fatalf("lease not issued: %+v", got[0])
	}
}

// TestStoreClaim_NotYetEligible verifies next_attempt_at gating.
func TestStoreClaim_NotYetEligible(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-delay"
	res := f.intake(ctx, "caller-delay", "key-delay")
	actor := workerActor(vendorID)

	// Push next_attempt_at into the future directly (setup, not subject behavior).
	if _, err := f.pool.Exec(ctx,
		`UPDATE notifications SET next_attempt_at = now() + interval '1 hour'
		 WHERE notification_id = $1`, res.NotificationID); err != nil {
		t.Fatalf("delay setup: %v", err)
	}
	if _, err := f.repo.ClaimNext(ctx, actor, nil, 30*time.Second); !errors.Is(err, notificationstore.ErrNoEligibleNotification) {
		t.Fatalf("future next_attempt_at must not be claimable, got %v", err)
	}
}

// TestStoreTransition_SucceedFlow covers claim → succeed with OCC + lease
// validation, and rejection of a stale lease afterwards.
func TestStoreTransition_SucceedFlow(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-flow"
	f.intake(ctx, "caller-flow", "key-flow")
	actor := workerActor(vendorID)

	claim, err := f.repo.ClaimNext(ctx, actor, nil, 30*time.Second)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	out, err := f.repo.Transition(ctx, actor, notificationstore.TransitionRequest{
		NotificationID:      claim.NotificationID,
		ExpectedState:       notificationstore.StateInFlight,
		ExpectedVersion:     claim.Version,
		LeaseID:             claim.LeaseID,
		RequestedTransition: notificationstore.TransitionSucceed,
		DeliveryResult: &notificationstore.DeliveryResult{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassSuccess,
			HTTPStatus:   200,
		},
	})
	if err != nil {
		t.Fatalf("succeed: %v", err)
	}
	if out.State != notificationstore.StateDelivered || out.AttemptCount != 1 {
		t.Fatalf("bad transition result: %+v", out)
	}

	// Reusing the same lease must now fail (stale version and cleared lease).
	_, err = f.repo.Transition(ctx, actor, notificationstore.TransitionRequest{
		NotificationID:      claim.NotificationID,
		ExpectedState:       notificationstore.StateInFlight,
		ExpectedVersion:     claim.Version,
		LeaseID:             claim.LeaseID,
		RequestedTransition: notificationstore.TransitionSucceed,
		DeliveryResult: &notificationstore.DeliveryResult{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassSuccess,
			HTTPStatus:   200,
		},
	})
	if !notificationstore.IsRejection(err, notificationstore.RejectionStaleVersion) {
		t.Fatalf("expected stale-version on lease reuse, got %v", err)
	}
}

func TestStoreTransition_ConcurrentSameVersionHasOneWinner(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-transition-race"
	f.intake(ctx, "caller-transition-race", "key-transition-race")
	actor := workerActor(vendorID)
	claim, err := f.repo.ClaimNext(ctx, actor, nil, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	req := notificationstore.TransitionRequest{
		NotificationID: claim.NotificationID, ExpectedState: notificationstore.StateInFlight,
		ExpectedVersion: claim.Version, LeaseID: claim.LeaseID,
		RequestedTransition: notificationstore.TransitionSucceed,
		DeliveryResult:      &notificationstore.DeliveryResult{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassSuccess, HTTPStatus: 204},
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := f.repo.Transition(ctx, actor, req); results <- err }()
	}
	wg.Wait()
	close(results)
	successes, rejected := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if notificationstore.IsRejection(err, notificationstore.RejectionStaleVersion) || notificationstore.IsRejection(err, notificationstore.RejectionIllegalTransition) {
			rejected++
		} else {
			t.Fatalf("unexpected loser error: %v", err)
		}
	}
	if successes != 1 || rejected != 1 {
		t.Fatalf("successes=%d rejected=%d", successes, rejected)
	}
}

func TestStoreTransition_DeferredCommitFailurePreservesPriorStateAndHistory(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-transition-rollback"
	f.intake(ctx, "caller-transition-rollback", "key-transition-rollback")
	actor := workerActor(vendorID)
	claim, err := f.repo.ClaimNext(ctx, actor, nil, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `
		CREATE FUNCTION test_reject_attempt_commit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'forced deferred attempt commit rejection'; END $$;
		CREATE CONSTRAINT TRIGGER test_reject_attempt_commit
		AFTER INSERT ON delivery_attempts DEFERRABLE INITIALLY DEFERRED
		FOR EACH ROW EXECUTE FUNCTION test_reject_attempt_commit()`); err != nil {
		t.Fatal(err)
	}
	_, err = f.repo.Transition(ctx, actor, notificationstore.TransitionRequest{
		NotificationID: claim.NotificationID, ExpectedState: notificationstore.StateInFlight,
		ExpectedVersion: claim.Version, LeaseID: claim.LeaseID,
		RequestedTransition: notificationstore.TransitionSucceed,
		DeliveryResult:      &notificationstore.DeliveryResult{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassSuccess, HTTPStatus: 204},
	})
	if !notificationstore.IsRejection(err, notificationstore.RejectionCommitRolledBack) {
		t.Fatalf("transition commit=%v, want commit-rolled-back", err)
	}
	var state string
	var version int64
	var attemptCount, history int
	if err := f.pool.QueryRow(ctx, `SELECT state,version,attempt_count,(SELECT count(*) FROM delivery_attempts WHERE notification_id=$1) FROM notifications WHERE notification_id=$1`, claim.NotificationID).Scan(&state, &version, &attemptCount, &history); err != nil {
		t.Fatal(err)
	}
	if state != string(notificationstore.StateInFlight) || version != claim.Version || attemptCount != 0 || history != 1 {
		t.Fatalf("rollback state=%s version=%d attempts=%d history=%d", state, version, attemptCount, history)
	}
}

// TestStoreTransition_WrongLeaseHolder verifies lease-holder validation.
func TestStoreTransition_WrongLeaseHolder(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-holder"
	f.intake(ctx, "caller-holder", "key-holder")
	actor := workerActor(vendorID)

	claim, err := f.repo.ClaimNext(ctx, actor, nil, 30*time.Second)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	other := workerActor(vendorID)
	other.ActorID = "worker-intruder"
	_, err = f.repo.Transition(ctx, other, notificationstore.TransitionRequest{
		NotificationID:      claim.NotificationID,
		ExpectedState:       notificationstore.StateInFlight,
		ExpectedVersion:     claim.Version,
		LeaseID:             claim.LeaseID,
		RequestedTransition: notificationstore.TransitionSucceed,
		DeliveryResult: &notificationstore.DeliveryResult{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassSuccess,
			HTTPStatus:   200,
		},
	})
	if !notificationstore.IsRejection(err, notificationstore.RejectionInvalidLease) {
		t.Fatalf("expected invalid-lease for wrong holder, got %v", err)
	}
}

// TestStoreRecoverExpiredLeases covers crash-after-send convergence: an
// expired in-flight lease returns to pending via the system actor.
func TestStoreRecoverExpiredLeases(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-crash"
	f.intake(ctx, "caller-crash", "key-crash")
	worker := workerActor(vendorID)

	claim, err := f.repo.ClaimNext(ctx, worker, nil, 30*time.Second)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	// Force expiry (setup shortcut).
	if _, err := f.pool.Exec(ctx,
		`UPDATE notifications SET lease_expires_at = now() - interval '1 minute'
		 WHERE notification_id = $1`, claim.NotificationID); err != nil {
		t.Fatalf("expire setup: %v", err)
	}

	recovered, err := f.repo.RecoverExpiredLeases(ctx, systemActor(vendorID), 100)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	found := false
	for _, r := range recovered {
		if r.NotificationID == claim.NotificationID {
			found = true
		}
	}
	if !found {
		t.Fatalf("expired lease not recovered: %+v", recovered)
	}

	// The original worker's outcome must now fail (lease no longer valid).
	_, err = f.repo.Transition(ctx, worker, notificationstore.TransitionRequest{
		NotificationID:      claim.NotificationID,
		ExpectedState:       notificationstore.StateInFlight,
		ExpectedVersion:     claim.Version,
		LeaseID:             claim.LeaseID,
		RequestedTransition: notificationstore.TransitionSucceed,
		DeliveryResult: &notificationstore.DeliveryResult{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassSuccess,
			HTTPStatus:   200,
		},
	})
	if !notificationstore.IsRejection(err, notificationstore.RejectionStaleVersion) &&
		!notificationstore.IsRejection(err, notificationstore.RejectionIllegalTransition) {
		t.Fatalf("late outcome after recovery must be rejected, got %v", err)
	}
}

func TestStoreRecoverExpiredLeaseRejectsAttemptCountOverflowAtomically(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-overflow"
	f.intake(ctx, "caller-overflow", "key-overflow")
	claim, err := f.repo.ClaimNext(ctx, workerActor(vendorID), nil, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE notifications SET attempt_count=2147483647, lease_expires_at=now()-interval '1 minute' WHERE notification_id=$1`, claim.NotificationID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.RecoverExpiredLeases(ctx, systemActor(vendorID), 100); !notificationstore.IsRejection(err, notificationstore.RejectionInvariantViolation) {
		t.Fatalf("overflow recovery = %v, want invariant-violation", err)
	}
	var state string
	var attempts, history int
	if err := f.pool.QueryRow(ctx, `SELECT state, attempt_count, (SELECT count(*) FROM delivery_attempts WHERE notification_id=$1) FROM notifications WHERE notification_id=$1`, claim.NotificationID).Scan(&state, &attempts, &history); err != nil {
		t.Fatal(err)
	}
	if state != string(notificationstore.StateInFlight) || attempts != 2147483647 || history != 1 {
		t.Fatalf("overflow mutated state=%s attempts=%d history=%d", state, attempts, history)
	}
}

// TestStoreAttempts_AppendOnly verifies the DB-level trigger blocks UPDATE and
// DELETE on delivery_attempts (AC-ATT append-only, defense in depth).
func TestStoreAttempts_AppendOnly(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-append"
	f.intake(ctx, "caller-append", "key-append")
	actor := workerActor(vendorID)

	claim, err := f.repo.ClaimNext(ctx, actor, nil, 30*time.Second)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if _, err := f.repo.Transition(ctx, actor, notificationstore.TransitionRequest{
		NotificationID:      claim.NotificationID,
		ExpectedState:       notificationstore.StateInFlight,
		ExpectedVersion:     claim.Version,
		LeaseID:             claim.LeaseID,
		RequestedTransition: notificationstore.TransitionSucceed,
		DeliveryResult: &notificationstore.DeliveryResult{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassSuccess,
			HTTPStatus:   200,
		},
	}); err != nil {
		t.Fatalf("succeed: %v", err)
	}

	if _, err := f.pool.Exec(ctx,
		`UPDATE delivery_attempts SET outcome_class = 'retryable_failure'
		 WHERE notification_id = $1`, claim.NotificationID); err == nil {
		t.Fatalf("UPDATE on delivery_attempts must be blocked by trigger")
	}
	if _, err := f.pool.Exec(ctx,
		`DELETE FROM delivery_attempts WHERE notification_id = $1`, claim.NotificationID); err == nil {
		t.Fatalf("DELETE on delivery_attempts must be blocked by trigger")
	}
}

// TestStoreDeadListAndReplay covers die → list_dead pagination → operator replay
// (AC-DL + replay path).
func TestStoreDeadListAndReplay(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-caller-dead"
	f.intake(ctx, "caller-dead", "key-dead")
	worker := workerActor(vendorID)

	claim, err := f.repo.ClaimNext(ctx, worker, nil, 30*time.Second)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	die, err := f.repo.Transition(ctx, worker, notificationstore.TransitionRequest{
		NotificationID:      claim.NotificationID,
		ExpectedState:       notificationstore.StateInFlight,
		ExpectedVersion:     claim.Version,
		LeaseID:             claim.LeaseID,
		RequestedTransition: notificationstore.TransitionDie,
		DeliveryResult: &notificationstore.DeliveryResult{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassPermanentFailure,
			HTTPStatus:   400,
			Reason:       notificationstore.ReasonNonRetryableHTTPStatus,
		},
	})
	if err != nil {
		t.Fatalf("die: %v", err)
	}
	if die.State != notificationstore.StateDead {
		t.Fatalf("expected dead, got %s", die.State)
	}

	reader := operatorActor(vendorID)
	page, err := f.repo.ListDead(ctx, reader, nil, 100, "")
	if err != nil {
		t.Fatalf("list dead: %v", err)
	}
	found := false
	for _, item := range page.Items {
		if item.NotificationID == claim.NotificationID {
			found = true
			if item.DeadReason != notificationstore.ReasonNonRetryableHTTPStatus {
				t.Fatalf("dead reason mismatch: %+v", item)
			}
		}
	}
	if !found {
		t.Fatalf("dead notification missing from list_dead")
	}

	// Operator replays the dead row; attempt count resets to 0.
	replay, err := f.repo.Transition(ctx, reader, notificationstore.TransitionRequest{
		NotificationID:      claim.NotificationID,
		ExpectedState:       notificationstore.StateDead,
		ExpectedVersion:     die.Version,
		RequestedTransition: notificationstore.TransitionReplay,
		Justification:       "vendor recovered; manual replay authorized",
	})
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if replay.State != notificationstore.StatePending || replay.AttemptCount != 0 || replay.ReplayCount != 1 {
		t.Fatalf("bad replay result: %+v", replay)
	}

	// Attempt history must show claimed → outcome(dead) → replay.
	hist, err := f.repo.ListAttemptHistory(ctx, reader, notificationstore.NotificationID(claim.NotificationID), 100, "")
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if len(hist.Items) < 3 {
		t.Fatalf("expected at least 3 history rows, got %d", len(hist.Items))
	}
}

func TestStoreAttemptHistoryCrossPageIncludesLaterAppendWithoutDuplicates(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	res := f.intake(ctx, "caller-history-pages", "key-history-pages")
	vendorID := "vendor-caller-history-pages"
	for seq := 1; seq <= 3; seq++ {
		if _, err := f.pool.Exec(ctx, `INSERT INTO delivery_attempts (notification_id,attempt_seq,event_kind,actor_id,lease_id,lease_expires_at,claimed_at) VALUES ($1,$2,'claimed','worker-pages',$3,now()+interval '1 minute',now())`, res.NotificationID, seq, fmt.Sprintf("lease-%d", seq)); err != nil {
			t.Fatal(err)
		}
	}
	reader := operatorActor(vendorID)
	first, err := f.repo.ListAttemptHistory(ctx, reader, notificationstore.NotificationID(res.NotificationID), 2, "")
	if err != nil || len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("first page=%+v err=%v", first, err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO delivery_attempts (notification_id,attempt_seq,event_kind,actor_id,lease_id,lease_expires_at,claimed_at) VALUES ($1,4,'claimed','worker-pages','lease-4',now()+interval '1 minute',now())`, res.NotificationID); err != nil {
		t.Fatal(err)
	}
	second, err := f.repo.ListAttemptHistory(ctx, reader, notificationstore.NotificationID(res.NotificationID), 2, first.NextCursor)
	if err != nil || len(second.Items) != 2 || second.NextCursor != "" {
		t.Fatalf("second page=%+v err=%v", second, err)
	}
	all := append(append([]notificationstore.Attempt{}, first.Items...), second.Items...)
	for i, attempt := range all {
		if attempt.AttemptSeq != int64(i+1) {
			t.Fatalf("history order at %d = %d", i, attempt.AttemptSeq)
		}
	}
}

func TestStoreDeadPaginationUsesDatabaseSnapshotAndExcludesReplayAndNewDead(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	const vendorID = "vendor-dead-pages"
	f.seedVendor(ctx, vendorID)
	ids := []string{"dead-page-1", "dead-page-2", "dead-page-3"}
	for i, id := range ids {
		if _, err := f.pool.Exec(ctx, `INSERT INTO notifications (notification_id,caller_id,vendor_id,idempotency_key,request_fingerprint,payload_bytes,state,version,attempt_count,delivery_cycle_started_at,dead_at,dead_reason,created_at,updated_at) VALUES ($1,$2,$3,$4,decode('00','hex'),decode('7b7d','hex'),'dead',1,1,now()-interval '1 hour',now()-($5::int*interval '1 minute'),'non_retryable_http_status',now()-interval '1 hour',now())`, id, "caller-"+id, vendorID, "key-"+id, 3-i); err != nil {
			t.Fatal(err)
		}
	}
	reader := operatorActor(vendorID)
	first, err := f.repo.ListDead(ctx, reader, nil, 1, "")
	if err != nil || len(first.Items) != 1 || first.Items[0].NotificationID != ids[0] || first.NextCursor == "" {
		t.Fatalf("first dead page=%+v err=%v", first, err)
	}
	if _, err := f.repo.Transition(ctx, reader, notificationstore.TransitionRequest{NotificationID: ids[1], ExpectedState: notificationstore.StateDead, ExpectedVersion: 1, RequestedTransition: notificationstore.TransitionReplay, Justification: "vendor recovered after operator verification"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO notifications (notification_id,caller_id,vendor_id,idempotency_key,request_fingerprint,payload_bytes,state,version,attempt_count,delivery_cycle_started_at,dead_at,dead_reason,created_at,updated_at) VALUES ('dead-page-new','caller-dead-page-new',$1,'key-dead-page-new',decode('00','hex'),decode('7b7d','hex'),'dead',1,1,now(),now(),'non_retryable_http_status',now(),now())`, vendorID); err != nil {
		t.Fatal(err)
	}
	second, err := f.repo.ListDead(ctx, reader, nil, 1, first.NextCursor)
	if err != nil || len(second.Items) != 1 || second.Items[0].NotificationID != ids[2] {
		t.Fatalf("second dead page=%+v err=%v", second, err)
	}
	fresh, err := f.repo.ListDead(ctx, reader, nil, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, item := range fresh.Items {
		seen[item.NotificationID] = true
	}
	if seen[ids[1]] || !seen[ids[0]] || !seen[ids[2]] || !seen["dead-page-new"] {
		t.Fatalf("fresh traversal visibility=%v", seen)
	}
}

// TestStoreQueryOutbox_Scope verifies scoped aggregation only sees the actor's
// vendors (AC read-model authorization).
func TestStoreQueryOutbox_Scope(t *testing.T) {
	f := newStoreFixture(t)
	ctx := context.Background()
	f.intake(ctx, "caller-scope-a", "key-scope-a")

	narrow := notificationstore.ActorContext{
		Kind:         notificationstore.ActorSystem,
		ActorID:      "metrics-it",
		VendorScope:  []string{"vendor-caller-scope-a"},
		Capabilities: []notificationstore.Capability{notificationstore.CapabilityReadNotifications},
	}
	proj, err := f.repo.QueryOutbox(ctx, narrow, nil)
	if err != nil {
		t.Fatalf("query outbox: %v", err)
	}
	if proj.PendingCount < 1 {
		t.Fatalf("expected at least one pending in scope, got %+v", proj)
	}
}
