package runnerscheduler

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

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

func testScheduler(t testing.TB, store SessionStore, now time.Time) *Scheduler {
	t.Helper()
	session, err := NewSession(SessionConfig{Store: store, Launcher: processLauncherFunc(func(context.Context) (WorkerProcess, error) { return nil, errors.New("launch failed") }), ControlBuildHash: strings.Repeat("f", 64), HeartbeatInterval: time.Second, LeaseOfferTimeout: time.Second, CancelWindow: time.Second, CancelGrace: 10 * time.Millisecond, TerminalExitGrace: 10 * time.Millisecond, PollInterval: 10 * time.Millisecond, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := New(Config{Store: store, Session: session, WorkspaceID: "workspace-1", SupervisorInstanceID: "supervisor-1", MaxProcesses: 1, LeaseOfferTimeout: time.Second, LeaseDuration: time.Second, PollInterval: 10 * time.Millisecond, RecoveryInterval: time.Second, Now: func() time.Time { return now }})
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
