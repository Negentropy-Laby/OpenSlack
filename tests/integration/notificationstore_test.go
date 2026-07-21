package integration_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"rc_wsman/internal/notificationstore"
	"rc_wsman/internal/notificationstore/postgres"
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
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	t.Cleanup(pool.Close)
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
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
		Kind:    notificationstore.ActorWorker,
		ActorID: "worker-it",
		VendorScope: scope,
		Capabilities: []notificationstore.Capability{
			notificationstore.CapabilityClaimDelivery,
			notificationstore.CapabilityRecordDeliveryResult,
		},
	}
}

func systemActor(scope ...string) notificationstore.ActorContext {
	return notificationstore.ActorContext{
		Kind:    notificationstore.ActorSystem,
		ActorID: "system-it",
		VendorScope: scope,
		Capabilities: []notificationstore.Capability{
			notificationstore.CapabilityRecoverExpiredLeases,
		},
	}
}

func operatorActor(scope ...string) notificationstore.ActorContext {
	return notificationstore.ActorContext{
		Kind:    notificationstore.ActorOperator,
		ActorID: "op-it",
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
