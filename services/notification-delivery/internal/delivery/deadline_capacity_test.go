package delivery

import (
	"context"
	"net/http"
	"net/netip"
	"sync"
	"testing"
	"time"

	"rc_wsman/internal/notificationstore"
)

type deadlineMatrixStore struct {
	*runnerStore
	mu          sync.Mutex
	remaining   int
	seq         int
	cycleStart  time.Time
	leaseExpiry time.Time
	transitions []notificationstore.TransitionRequest
}

func (s *deadlineMatrixStore) ClaimNext(context.Context, notificationstore.ActorContext, *notificationstore.ClaimFilter, time.Duration) (notificationstore.LeaseClaim, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.remaining == 0 {
		return notificationstore.LeaseClaim{}, notificationstore.ErrNoEligibleNotification
	}
	s.remaining--
	s.seq++
	return notificationstore.LeaseClaim{
		NotificationID: "deadline-" + itoa(s.seq), LeaseID: "lease-" + itoa(s.seq),
		LeaseExpiresAt: s.leaseExpiry, Version: 2, Payload: []byte(`{"event":"deadline"}`), VendorID: "vendor-a",
		DeliveryCycleStartedAt: s.cycleStart, CreatedAt: s.cycleStart,
	}, nil
}

func (s *deadlineMatrixStore) Transition(_ context.Context, _ notificationstore.ActorContext, req notificationstore.TransitionRequest) (notificationstore.TransitionResult, error) {
	s.mu.Lock()
	s.transitions = append(s.transitions, req)
	s.mu.Unlock()
	return notificationstore.TransitionResult{}, nil
}

type deadlineBarrierTransport struct {
	total   int
	clock   *mutableClock
	cutoff  time.Time
	mu      sync.Mutex
	started int
	release chan struct{}
}

func (t *deadlineBarrierTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration, string) (TransportResponse, error) {
	t.mu.Lock()
	t.started++
	if t.started == t.total {
		t.clock.Set(t.cutoff)
		close(t.release)
	}
	t.mu.Unlock()
	<-t.release
	return TransportResponse{StatusCode: http.StatusServiceUnavailable, Header: make(http.Header)}, nil
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	b := [20]byte{}
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b[i:])
}

func newDeadlineMatrixRunner(t *testing.T, count int, now time.Time, transport HTTPTransport) (*Runner, *deadlineMatrixStore, *mutableClock, time.Time) {
	t.Helper()
	cfg := DefaultConfig()
	cycleStart := now.Add(-cfg.MaxAge).Add(cfg.HTTPHardTimeout).Add(cfg.ResultCommitMargin).Add(time.Second)
	cutoff := cycleStart.Add(cfg.MaxAge).Add(-cfg.HTTPHardTimeout).Add(-cfg.ResultCommitMargin)
	clock := &mutableClock{now: now}
	store := &deadlineMatrixStore{runnerStore: &runnerStore{}, remaining: count, cycleStart: cycleStart, leaseExpiry: cutoff.Add(time.Minute)}
	policy, err := NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := NewRunner(cfg, store, snapshotReader{snapshot: validSnapshot()}, fixedCredentialResolver{}, &sequenceResolver{answers: [][]netip.Addr{{netip.MustParseAddr("8.8.8.8")}}}, transport, policy, clock, fixedRNG{})
	if err != nil {
		t.Fatal(err)
	}
	return runner, store, clock, cutoff
}

func runDeadlineMatrix(t *testing.T, runner *Runner, count int) {
	t.Helper()
	var wg sync.WaitGroup
	errCh := make(chan error, count)
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claimed, err := runner.RunOnce(context.Background(), runnerActor())
			if err != nil || !claimed {
				errCh <- &matrixError{claimed: claimed, err: err}
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
}

type matrixError struct {
	claimed bool
	err     error
}

func (e *matrixError) Error() string {
	if e.err != nil {
		return "deadline matrix runner error: " + e.err.Error()
	}
	return "deadline matrix did not claim"
}

func TestDeadlineBacklogPathAMatrixTerminatesOnceWithoutSend(t *testing.T) {
	for _, count := range []int{1, 5, 10, 25, 50, 100, 200, 500} {
		t.Run("N="+itoa(count), func(t *testing.T) {
			now := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
			transport := &fakeHTTPTransport{status: 204}
			runner, store, clock, cutoff := newDeadlineMatrixRunner(t, count, now, transport)
			clock.Set(cutoff)
			runDeadlineMatrix(t, runner, count)
			if transport.calls != 0 || len(store.transitions) != count {
				t.Fatalf("sends=%d transitions=%d want 0/%d", transport.calls, len(store.transitions), count)
			}
			for _, tr := range store.transitions {
				if tr.RequestedTransition != notificationstore.TransitionDie || tr.NextAttemptAt != nil || tr.DeliveryResult == nil || tr.DeliveryResult.ResultKind != notificationstore.ResultKindPolicyTermination || tr.DeliveryResult.Reason != notificationstore.ReasonDeadlineExceeded {
					t.Fatalf("invalid Path A transition: %+v", tr)
				}
			}
			if claimed, err := runner.RunOnce(context.Background(), runnerActor()); err != nil || claimed {
				t.Fatalf("second claim claimed=%v err=%v", claimed, err)
			}
		})
	}
}

func TestDeadlineBacklogPathBMatrixPreservesActualResultAndTerminatesOnce(t *testing.T) {
	for _, count := range []int{1, 5, 10, 25} {
		t.Run("N="+itoa(count), func(t *testing.T) {
			now := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
			clock := &mutableClock{now: now}
			transport := &deadlineBarrierTransport{total: count, clock: clock, release: make(chan struct{})}
			runner, store, runnerClock, cutoff := newDeadlineMatrixRunner(t, count, now, transport)
			transport.clock = runnerClock
			transport.cutoff = cutoff
			runDeadlineMatrix(t, runner, count)
			if transport.started != count || len(store.transitions) != count {
				t.Fatalf("sends=%d transitions=%d want %d", transport.started, len(store.transitions), count)
			}
			for _, tr := range store.transitions {
				if tr.RequestedTransition != notificationstore.TransitionDie || tr.NextAttemptAt != nil || tr.DeliveryResult == nil || tr.DeliveryResult.ResultKind != notificationstore.ResultKindHTTPResponse || tr.DeliveryResult.HTTPStatus != 503 || tr.DeliveryResult.OutcomeClass != notificationstore.OutcomeClassPermanentFailure || tr.DeliveryResult.Reason != notificationstore.ReasonDeadlineExceeded {
					t.Fatalf("invalid Path B transition: %+v", tr)
				}
			}
			if claimed, err := runner.RunOnce(context.Background(), runnerActor()); err != nil || claimed {
				t.Fatalf("second claim claimed=%v err=%v", claimed, err)
			}
		})
	}
}
