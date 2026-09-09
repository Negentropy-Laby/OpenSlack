package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

func TestRecoveryRetryPreservesCallerCancellationAfterTransportFailure(t *testing.T) {
	for _, kind := range []string{"cancelled", "deadline", "active", "committed"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if kind == "deadline" {
				var stop context.CancelFunc
				ctx, stop = context.WithDeadline(ctx, time.Now().Add(-time.Nanosecond))
				defer stop()
			}
			transport := errors.New("transport interrupted without a context cause")
			failure := databaseFailure("database operation", transport)
			calls := 0
			value, err := retryRecoveryTransaction(ctx, nil, noRecoveryLease, func(context.Context) (int, error) {
				calls++
				if kind == "cancelled" || kind == "committed" {
					cancel()
				}
				if kind == "committed" {
					return 1, nil
				}
				return 0, failure
			})
			if calls != 1 {
				t.Fatal("transport failure was replayed")
			}
			if kind == "committed" {
				if err != nil || value != 1 {
					t.Fatal("cancellation erased a successful result", err)
				}
				return
			}
			if !errors.Is(err, transport) || !runnerstore.IsCode(err, runnerstore.ErrorDatabase) {
				t.Fatal("transport evidence or public classification changed", err)
			}
			if kind == "active" {
				if err != failure {
					t.Fatal("active caller error changed", err)
				}
			} else if !errors.Is(err, ctx.Err()) {
				t.Fatal("caller cancellation was lost", err)
			}
		})
	}
}
