package runnerscheduler

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerprotocols"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

func TestSchedulerSurfacesUnsettledSessionFailure(t *testing.T) {
	now := time.Now().UTC()
	store := &schedulerStore{lease: testLease(now), settleErr: runnerstore.Failure(runnerstore.ErrorDatabase, "settlement failed", nil)}
	scheduler := testScheduler(t, store, now)
	err := scheduler.Run(t.Context())
	if !runnerstore.IsCode(err, runnerstore.ErrorDatabase) {
		t.Fatalf("scheduler silently dropped unsettled session failure: %v", err)
	}
}

func TestSchedulerRateLimitsSettledRetryableSessionFailure(t *testing.T) {
	now := time.Now().UTC()
	store := &schedulerStore{lease: testLease(now), settledView: runnerstore.JobView{State: runnerstore.JobQueued}}
	scheduler := testScheduler(t, store, now)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	if err := scheduler.Run(ctx); err != nil {
		t.Fatalf("settled retryable failure stopped scheduler: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.claims > 4 {
		t.Fatalf("settled failure was hot-looped: claims=%d", store.claims)
	}
}

func TestSchedulerRequiresAndConsumesV2AuthorityRecovery(t *testing.T) {
	now := time.Now().UTC()
	base := testScheduler(t, &schedulerStore{}, now).config
	base.AuthorityRecovery = nil
	if _, err := New(base); err == nil || !strings.Contains(err.Error(), "authority recovery store is required") {
		t.Fatalf("v2 scheduler accepted without startup recovery capability: %v", err)
	}
	base.AuthorityRecovery = authorityRecoveryFunc(func(context.Context, string, time.Time, int) (runnerstore.V2AuthorityRecoverySummary, error) {
		return runnerstore.V2AuthorityRecoverySummary{Examined: 1, Reconciled: 2}, nil
	})
	scheduler, err := New(base)
	if err != nil {
		t.Fatalf("construct runtime-delivery scheduler: %v", err)
	}
	if err := scheduler.Run(t.Context()); err == nil || !strings.Contains(err.Error(), "invalid recovery summary") {
		t.Fatalf("scheduler discarded an invalid startup recovery summary: %v", err)
	}
}

func testScheduler(t testing.TB, store *schedulerStore, now time.Time) *Scheduler {
	t.Helper()
	if store.lease.RequiredProtocolVersion == "" {
		store.lease = testLease(now)
		store.lease.RequiredProtocolVersion = runnerprotocols.V2
	}
	session := protocolSessionFunc(func(context.Context, runnerstore.AttemptLease) error {
		if store.settleErr != nil {
			return store.settleErr
		}
		return &sessionRunError{err: errors.New("settled retryable failure"), disposition: sessionErrorSettled}
	})
	recovery := authorityRecoveryFunc(func(context.Context, string, time.Time, int) (runnerstore.V2AuthorityRecoverySummary, error) {
		return runnerstore.V2AuthorityRecoverySummary{}, nil
	})
	scheduler, err := New(Config{Store: store, V2Session: session, AuthorityRecovery: recovery, WorkspaceID: "workspace-1", SupervisorInstanceID: "supervisor-1", MaxProcesses: 1, LeaseOfferTimeout: time.Second, LeaseDuration: time.Second, PollInterval: 10 * time.Millisecond, RecoveryInterval: time.Second, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	return scheduler
}

type schedulerStore struct {
	runnerstore.Store
	mu          sync.Mutex
	lease       runnerstore.AttemptLease
	claims      int
	settledView runnerstore.JobView
	settleErr   error
}

type authorityRecoveryFunc func(context.Context, string, time.Time, int) (runnerstore.V2AuthorityRecoverySummary, error)

type protocolSessionFunc func(context.Context, runnerstore.AttemptLease) error

func (function protocolSessionFunc) Run(ctx context.Context, lease runnerstore.AttemptLease) error {
	return function(ctx, lease)
}

func (function authorityRecoveryFunc) RecoverAuthorityBindingsAtStartup(ctx context.Context, workspaceID string, before time.Time, limit int) (runnerstore.V2AuthorityRecoverySummary, error) {
	return function(ctx, workspaceID, before, limit)
}

var _ SessionStore = (*schedulerStore)(nil)

func (store *schedulerStore) ClaimNext(context.Context, runnerstore.ClaimInput) (runnerstore.AttemptLease, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.claims++
	if store.claims == 1 {
		return store.lease, nil
	}
	return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorNoWork, "no work", nil)
}

func (store *schedulerStore) RecordAttemptFailure(context.Context, runnerstore.AttemptFailureInput) (runnerstore.JobView, error) {
	return store.settledView, store.settleErr
}

func (store *schedulerStore) RecoverOrphans(context.Context, string, time.Time, int) ([]runnerstore.RecoveryResult, error) {
	return nil, nil
}

func (store *schedulerStore) RecoverExpired(context.Context, runnerstore.RecoverExpiredInput) ([]runnerstore.RecoveryResult, error) {
	return nil, nil
}
