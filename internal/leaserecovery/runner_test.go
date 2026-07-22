package leaserecovery

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"rc_wsman/internal/notificationstore"
)

type fakeStore struct {
	calls atomic.Int64
	err   error
}

func (f *fakeStore) RecoverExpiredLeases(context.Context, notificationstore.ActorContext, int) ([]notificationstore.RecoveredLease, error) {
	f.calls.Add(1)
	return nil, f.err
}

func recoveryActor() notificationstore.ActorContext {
	return notificationstore.ActorContext{Kind: notificationstore.ActorSystem, ActorID: "recovery-1", VendorScope: []string{"*"}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityRecoverExpiredLeases}}
}

func TestRunnerSweepsImmediatelyThenStopsOnCancellation(t *testing.T) {
	store := &fakeStore{}
	runner, err := New(store, recoveryActor(), time.Hour, 100, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	deadline := time.After(time.Second)
	for store.calls.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("initial sweep did not run")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("run returned %v", err)
	}
}

func TestRunnerEmitsSanitizedHealthEvent(t *testing.T) {
	store := &fakeStore{err: errors.New("secret database detail")}
	health := make(chan HealthEvent, 1)
	runner, _ := New(store, recoveryActor(), time.Hour, 100, health)
	runner.runOnce(t.Context())
	event := <-health
	if event.ErrorCode != "lease_recovery_failed" {
		t.Fatalf("event=%+v", event)
	}
}
