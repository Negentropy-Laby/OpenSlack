package delivery

import (
	"context"
	"errors"
	"sync"
	"time"

	"rc_wsman/internal/notificationstore"
)

// HealthEvent is a sanitized worker health event. It carries no payload or secret.
type HealthEvent struct {
	Time           time.Time
	WorkerID       string
	NotificationID string
	ErrorCode      string
}

// Worker runs the delivery worker pool. It claims notifications from the Store,
// dispatches attempts through the Runner, and emits health events for unexpected
// failures.
type Worker struct {
	runner       *Runner
	actor        notificationstore.ActorContext
	interval     time.Duration
	concurrency  int
	healthEvents chan<- HealthEvent
}

// NewWorker builds a worker pool. The actor context determines which vendors
// this worker may claim and must carry claim_delivery + record_delivery_result
// capabilities.
func NewWorker(runner *Runner, actor notificationstore.ActorContext, interval time.Duration, concurrency int, healthEvents chan<- HealthEvent) (*Worker, error) {
	if runner == nil {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	if err := actor.Validate(); err != nil {
		return nil, err
	}
	if actor.Kind != notificationstore.ActorWorker {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	if !actor.HasCapability(notificationstore.CapabilityClaimDelivery) || !actor.HasCapability(notificationstore.CapabilityRecordDeliveryResult) {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	if interval <= 0 {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	if concurrency < 1 {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	if interval > runner.cfg.DeadlineClaimBudget {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	return &Worker{
		runner:       runner,
		actor:        actor,
		interval:     interval,
		concurrency:  concurrency,
		healthEvents: healthEvents,
	}, nil
}

// Run starts the worker pool. It runs until the context is cancelled, then waits
// for in-flight attempts to finish before returning. It does not forcibly abort
// HTTP requests in progress.
func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	var wg sync.WaitGroup
	done := make(chan error, 1)
	running := false
	start := func() {
		if running {
			return
		}
		running = true
		wg.Add(1)
		go func() {
			defer wg.Done()
			done <- w.runOneIteration(ctx)
		}()
	}
	start()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return ctx.Err()
		case <-ticker.C:
			start()
		case err := <-done:
			running = false
			if err != nil {
				w.emit(HealthEvent{Time: time.Now().UTC(), WorkerID: w.actor.ActorID, ErrorCode: healthErrorCode(err)})
			}
		}
	}
}

func healthErrorCode(err error) string {
	var signal *HealthSignalError
	if errors.As(err, &signal) && signal.Code != "" {
		return signal.Code
	}
	return "iteration_failed"
}

// runOneIteration spawns concurrency workers, each claiming until no eligible
// notification remains. It returns the first unexpected error encountered.
func (w *Worker) runOneIteration(ctx context.Context) error {
	var wg sync.WaitGroup
	errCh := make(chan error, w.concurrency)

	for i := 0; i < w.concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if err := ctx.Err(); err != nil {
					return
				}
				claimed, err := w.runner.RunOnce(ctx, w.actor)
				if err != nil {
					errCh <- err
					return
				}
				if !claimed {
					return
				}
			}
		}()
	}

	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			return err
		}
	}
	return nil
}

// RunOnce executes a single claim attempt. It is useful for integration tests.
func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	return w.runner.RunOnce(ctx, w.actor)
}

func (w *Worker) emit(ev HealthEvent) {
	if w.healthEvents != nil {
		select {
		case w.healthEvents <- ev:
		default:
		}
	}
}
