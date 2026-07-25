package integration_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"rc_wsman/internal/delivery"
	"rc_wsman/internal/notificationstore"
)

type countingDeadlineTransport struct {
	status int
	calls  atomic.Int64
}

func (t *countingDeadlineTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration, string) (delivery.TransportResponse, error) {
	t.calls.Add(1)
	return delivery.TransportResponse{StatusCode: t.status, Header: make(http.Header)}, nil
}

type postgresDeadlineBarrierTransport struct {
	total   int64
	clock   *integrationMutableClock
	cutoff  time.Time
	started atomic.Int64
	once    sync.Once
	release chan struct{}
}

func (t *postgresDeadlineBarrierTransport) Do(context.Context, *http.Request, netip.Addr, time.Duration, string) (delivery.TransportResponse, error) {
	if t.started.Add(1) == t.total {
		t.clock.Set(t.cutoff)
		t.once.Do(func() { close(t.release) })
	}
	<-t.release
	return delivery.TransportResponse{StatusCode: http.StatusServiceUnavailable, Header: make(http.Header)}, nil
}

func TestDeadlineBacklogPostgresMatrixPersistsInvariants(t *testing.T) {
	if testing.Short() {
		t.Skip("PostgreSQL deadline capacity matrix is an integration test")
	}
	for _, path := range []struct {
		name   string
		counts []int
	}{
		{name: "A", counts: []int{1, 5, 10, 25, 50, 100, 200, 500}},
		{name: "B", counts: []int{1, 5, 10, 25}},
	} {
		for _, count := range path.counts {
			t.Run(fmt.Sprintf("Path%s/N=%d", path.name, count), func(t *testing.T) {
				f := newStoreFixture(t)
				ctx := context.Background()
				callerID := fmt.Sprintf("deadline-pg-%s-%d", path.name, count)
				vendorID := "vendor-" + callerID
				ids := make([]string, 0, count)
				for i := 0; i < count; i++ {
					accepted := f.intake(ctx, callerID, fmt.Sprintf("deadline-%s-%d-%d", path.name, count, i))
					ids = append(ids, accepted.NotificationID)
				}

				cfg := delivery.DefaultConfig()
				var dbNow time.Time
				if err := f.pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&dbNow); err != nil {
					t.Fatal(err)
				}
				cutoff := dbNow
				if path.name == "B" {
					cutoff = dbNow.Add(time.Second)
				}
				cycleStart := cutoff.Add(-cfg.MaxAge).Add(cfg.HTTPHardTimeout).Add(cfg.ResultCommitMargin)
				if _, err := f.pool.Exec(ctx, `UPDATE notifications SET delivery_cycle_started_at=$1 WHERE vendor_id=$2 AND state='pending'`, cycleStart, vendorID); err != nil {
					t.Fatal(err)
				}

				clock := &integrationMutableClock{now: dbNow}
				policy, err := delivery.NewAddressPolicy(cfg.DefaultAllowedPorts, cfg.DefaultForbiddenCIDRs)
				if err != nil {
					t.Fatal(err)
				}
				var transport delivery.HTTPTransport
				pathATransport := &countingDeadlineTransport{status: http.StatusNoContent}
				var pathBTransport *postgresDeadlineBarrierTransport
				if path.name == "A" {
					transport = pathATransport
				} else {
					pathBTransport = &postgresDeadlineBarrierTransport{total: int64(count), clock: clock, cutoff: cutoff, release: make(chan struct{})}
					transport = pathBTransport
				}
				runner, err := delivery.NewRunner(cfg, f.repo, acceptanceSnapshotReader{vendorID: vendorID}, integrationCredentialResolver{}, integrationDNSResolver{}, transport, policy, clock, delivery.CryptoRNG{})
				if err != nil {
					t.Fatal(err)
				}

				started := time.Now()
				concurrency := count
				if path.name == "A" && concurrency > 5 {
					concurrency = 5
				}
				jobs := make(chan struct{}, count)
				for range count {
					jobs <- struct{}{}
				}
				close(jobs)
				errCh := make(chan error, count)
				var wg sync.WaitGroup
				for range concurrency {
					wg.Add(1)
					go func() {
						defer wg.Done()
						for range jobs {
							claimed, runErr := runner.RunOnce(ctx, workerActor(vendorID))
							if runErr != nil || !claimed {
								errCh <- fmt.Errorf("claimed=%v: %w", claimed, runErr)
							}
						}
					}()
				}
				wg.Wait()
				close(errCh)
				for runErr := range errCh {
					t.Fatal(runErr)
				}
				duration := time.Since(started)

				expectedAttempts := 0
				if path.name == "A" {
					if pathATransport.calls.Load() != 0 {
						t.Fatalf("Path A sent %d requests", pathATransport.calls.Load())
					}
				} else {
					expectedAttempts = 1
					if pathBTransport.started.Load() != int64(count) {
						t.Fatalf("Path B started %d requests, want %d", pathBTransport.started.Load(), count)
					}
				}
				var rows int
				var stateOK, attemptsOK, deadlineOK, nextAttemptOK bool
				if err := f.pool.QueryRow(ctx, `
					SELECT count(*), bool_and(state='dead'), bool_and(attempt_count=$2),
					       bool_and(dead_at <= delivery_cycle_started_at + interval '24 hours'),
					       bool_and(next_attempt_at IS NULL)
					FROM notifications WHERE vendor_id=$1
				`, vendorID, expectedAttempts).Scan(&rows, &stateOK, &attemptsOK, &deadlineOK, &nextAttemptOK); err != nil {
					t.Fatal(err)
				}
				if rows != count || !stateOK || !attemptsOK || !deadlineOK || !nextAttemptOK {
					t.Fatalf("persisted invariants rows=%d state=%v attempts=%v deadline=%v next=%v", rows, stateOK, attemptsOK, deadlineOK, nextAttemptOK)
				}
				var historyRows int
				if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM delivery_attempts WHERE notification_id = ANY($1)`, ids).Scan(&historyRows); err != nil {
					t.Fatal(err)
				}
				if historyRows != count*2 {
					t.Fatalf("history rows=%d want=%d", historyRows, count*2)
				}
				if claim, err := f.repo.ClaimNext(ctx, workerActor(vendorID), nil, cfg.LeaseTTL); !errors.Is(err, notificationstore.ErrNoEligibleNotification) {
					t.Fatalf("second claim=%+v err=%v", claim, err)
				}
				t.Logf("POSTGRES_DEADLINE_PATH path=%s n=%d concurrency=%d duration=%s rows=%d history=%d", path.name, count, concurrency, duration, rows, historyRows)
			})
		}
	}
}
