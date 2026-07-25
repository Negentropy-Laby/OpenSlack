// Package leaserecovery owns the in-process schedule for Store-owned expired
// lease recovery. It owns no notification state.
package leaserecovery

import (
	"context"
	"fmt"
	"time"

	"rc_wsman/internal/notificationstore"
)

type Store interface {
	RecoverExpiredLeases(context.Context, notificationstore.ActorContext, int) ([]notificationstore.RecoveredLease, error)
}

type HealthEvent struct {
	OccurredAt time.Time
	ErrorCode  string
}

type Runner struct {
	store  Store
	actor  notificationstore.ActorContext
	period time.Duration
	batch  int
	health chan<- HealthEvent
}

func New(store Store, actor notificationstore.ActorContext, period time.Duration, batch int, health chan<- HealthEvent) (*Runner, error) {
	if store == nil || period <= 0 || batch < notificationstore.RecoveryBatchMin || batch > notificationstore.RecoveryBatchMax {
		return nil, fmt.Errorf("lease recovery: invalid configuration")
	}
	if err := actor.Validate(); err != nil || actor.Kind != notificationstore.ActorSystem || !actor.HasCapability(notificationstore.CapabilityRecoverExpiredLeases) {
		return nil, fmt.Errorf("lease recovery: invalid actor")
	}
	return &Runner{store: store, actor: actor, period: period, batch: batch, health: health}, nil
}

func (r *Runner) Run(ctx context.Context) error {
	r.runOnce(ctx)
	ticker := time.NewTicker(r.period)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			r.runOnce(ctx)
		}
	}
}

func (r *Runner) RunOnce(ctx context.Context) ([]notificationstore.RecoveredLease, error) {
	return r.store.RecoverExpiredLeases(ctx, r.actor, r.batch)
}

func (r *Runner) runOnce(ctx context.Context) {
	if _, err := r.RunOnce(ctx); err != nil && ctx.Err() == nil {
		select {
		case r.health <- HealthEvent{OccurredAt: time.Now().UTC(), ErrorCode: "lease_recovery_failed"}:
		default:
		}
	}
}
