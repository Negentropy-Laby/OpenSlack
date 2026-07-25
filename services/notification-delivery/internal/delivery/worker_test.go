package delivery

import (
	"context"
	"errors"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore"
)

type workerStore struct {
	*runnerStore
	mu         sync.Mutex
	remaining  int
	seq        int
	cycleStart time.Time
}

func (s *workerStore) ClaimNext(context.Context, notificationstore.ActorContext, *notificationstore.ClaimFilter, time.Duration) (notificationstore.LeaseClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.remaining == 0 {
		return notificationstore.LeaseClaim{}, notificationstore.ErrNoEligibleNotification
	}
	s.remaining--
	s.seq++
	return notificationstore.LeaseClaim{NotificationID: "n-" + strconv.Itoa(s.seq), LeaseID: "l-" + strconv.Itoa(s.seq), LeaseExpiresAt: s.cycleStart.Add(25 * time.Hour), Version: 2, Payload: []byte(`{"x":1}`), VendorID: "vendor-a", DeliveryCycleStartedAt: s.cycleStart, CreatedAt: s.cycleStart}, nil
}

func (s *workerStore) Transition(context.Context, notificationstore.ActorContext, notificationstore.TransitionRequest) (notificationstore.TransitionResult, error) {
	return notificationstore.TransitionResult{}, nil
}

type concurrencyTransport struct {
	active atomic.Int32
	max    atomic.Int32
}

type shutdownTransport struct {
	started chan struct{}
	release chan struct{}
}

func (t *shutdownTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration, string) (TransportResponse, error) {
	close(t.started)
	<-t.release
	return TransportResponse{StatusCode: http.StatusNoContent, Header: make(http.Header)}, nil
}

type shutdownStore struct {
	*workerStore
	committed chan struct{}
}

func (s *shutdownStore) Transition(context.Context, notificationstore.ActorContext, notificationstore.TransitionRequest) (notificationstore.TransitionResult, error) {
	close(s.committed)
	return notificationstore.TransitionResult{}, nil
}

func (t *concurrencyTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration, string) (TransportResponse, error) {
	active := t.active.Add(1)
	for {
		old := t.max.Load()
		if active <= old || t.max.CompareAndSwap(old, active) {
			break
		}
	}
	time.Sleep(10 * time.Millisecond)
	t.active.Add(-1)
	return TransportResponse{StatusCode: http.StatusNoContent, Header: make(http.Header)}, nil
}

func TestWorkerGlobalConcurrencyBound(t *testing.T) {
	now := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	cfg := DefaultConfig()
	store := &workerStore{runnerStore: &runnerStore{}, remaining: 20, cycleStart: now}
	dns := &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}}}
	transport := &concurrencyTransport{}
	policy, err := NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(cfg, store, snapshotReader{snapshot: validSnapshot()}, fixedCredentialResolver{}, dns, transport, policy, &mutableClock{now: now}, fixedRNG{})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := NewWorker(runner, runnerActor(), time.Millisecond, 3, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.runOneIteration(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := transport.max.Load(); got < 2 || got > 3 {
		t.Fatalf("max concurrency = %d, want 2..3", got)
	}
}

func TestWorkerRejectsIntervalBeyondDeadlineClaimBudget(t *testing.T) {
	now := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	cfg := DefaultConfig()
	store := &workerStore{runnerStore: &runnerStore{}, cycleStart: now}
	policy, err := NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(cfg, store, snapshotReader{snapshot: validSnapshot()}, fixedCredentialResolver{}, &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}}}, &fakeHTTPTransport{status: 204}, policy, &mutableClock{now: now}, fixedRNG{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewWorker(runner, runnerActor(), cfg.DeadlineClaimBudget+time.Nanosecond, 1, nil); err == nil {
		t.Fatal("worker accepted interval beyond DEADLINE_CLAIM_BUDGET")
	}
}

func TestWorkerShutdownWaitsForSentAttemptResultCommit(t *testing.T) {
	now := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	cfg := DefaultConfig()
	store := &shutdownStore{
		workerStore: &workerStore{runnerStore: &runnerStore{}, remaining: 1, cycleStart: now},
		committed:   make(chan struct{}),
	}
	transport := &shutdownTransport{started: make(chan struct{}), release: make(chan struct{})}
	policy, err := NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(cfg, store, snapshotReader{snapshot: validSnapshot()}, fixedCredentialResolver{}, &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}}}, transport, policy, &mutableClock{now: now}, fixedRNG{})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := NewWorker(runner, runnerActor(), time.Millisecond, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- worker.Run(ctx) }()
	select {
	case <-transport.started:
	case <-time.After(time.Second):
		t.Fatal("attempt was not sent")
	}
	cancel()
	select {
	case err := <-done:
		t.Fatalf("worker returned before sent attempt completed: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(transport.release)
	select {
	case <-store.committed:
	case <-time.After(time.Second):
		t.Fatal("sent attempt result was not committed during shutdown")
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("worker shutdown error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not return after result commit")
	}
}

func TestHealthErrorCodePreservesSanitizedSignal(t *testing.T) {
	if got := healthErrorCode(newHealthSignal("registry_access_failure", errors.New("detail"))); got != "registry_access_failure" {
		t.Fatalf("health error code = %q", got)
	}
}
