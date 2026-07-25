package reliability

import (
	"bytes"
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"rc_wsman/internal/notificationstore"
)

type fakeStore struct {
	projection notificationstore.OutboxProjection
	err        error
	calls      int
	actor      notificationstore.ActorContext
}

func (f *fakeStore) QueryOutbox(_ context.Context, actor notificationstore.ActorContext, filter []string) (notificationstore.OutboxProjection, error) {
	f.calls++
	f.actor = actor
	if len(filter) != 0 {
		return notificationstore.OutboxProjection{}, errors.New("collector used scoped filter")
	}
	return f.projection, f.err
}

func TestCollectPublishesOneGlobalSnapshotAndExactlyThreeMetrics(t *testing.T) {
	store := &fakeStore{projection: notificationstore.OutboxProjection{PendingCount: 3, DeadCount: 2, OldestPendingAgeSeconds: 4.5}}
	service, _ := New(store, time.Second)
	snapshot, err := service.Collect(t.Context())
	if err != nil || store.calls != 1 || store.actor.Kind != notificationstore.ActorSystem || !store.actor.HasCapability(notificationstore.CapabilityReadAllNotifications) {
		t.Fatalf("snapshot=%+v calls=%d actor=%+v err=%v", snapshot, store.calls, store.actor, err)
	}
	var body bytes.Buffer
	if err := WritePrometheus(&body, snapshot); err != nil {
		t.Fatal(err)
	}
	text := body.String()
	for _, name := range []string{"rc_wsman_outbox_pending", "rc_wsman_oldest_pending_age_seconds", "rc_wsman_dead_notifications"} {
		if strings.Count(text, "# TYPE "+name+" gauge") != 1 {
			t.Fatalf("metric %s missing or duplicated: %s", name, text)
		}
	}
	for _, forbidden := range []string{"vendor_id", "notification_id", "caller_id", "payload", "credential", "{"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("metrics contain forbidden content %q: %s", forbidden, text)
		}
	}
}

func TestCollectMapsPendingAgeAndDeadCountsIncludingEmptyOutbox(t *testing.T) {
	for name, projection := range map[string]notificationstore.OutboxProjection{
		"populated": {PendingCount: 7, DeadCount: 3, OldestPendingAgeSeconds: 12.5},
		"empty":     {PendingCount: 0, DeadCount: 0, OldestPendingAgeSeconds: 0},
	} {
		t.Run(name, func(t *testing.T) {
			service, _ := New(&fakeStore{projection: projection}, time.Second)
			snapshot, err := service.Collect(t.Context())
			if err != nil || snapshot.PendingCount != projection.PendingCount || snapshot.DeadCount != projection.DeadCount || snapshot.OldestPendingAgeSeconds != projection.OldestPendingAgeSeconds {
				t.Fatalf("snapshot=%+v projection=%+v err=%v", snapshot, projection, err)
			}
		})
	}
}

func TestCollectFailureAndInvalidProjectionPublishNothing(t *testing.T) {
	for _, store := range []*fakeStore{
		{err: errors.New("store down")},
		{projection: notificationstore.OutboxProjection{PendingCount: -1}},
		{projection: notificationstore.OutboxProjection{DeadCount: -1}},
		{projection: notificationstore.OutboxProjection{OldestPendingAgeSeconds: -1}},
		{projection: notificationstore.OutboxProjection{OldestPendingAgeSeconds: math.NaN()}},
		{projection: notificationstore.OutboxProjection{OldestPendingAgeSeconds: math.Inf(1)}},
	} {
		service, _ := New(store, time.Second)
		if snapshot, err := service.Collect(t.Context()); err == nil || snapshot != (Snapshot{}) {
			t.Fatalf("invalid collection published snapshot=%+v err=%v", snapshot, err)
		}
	}
}

type sequenceStore struct {
	calls int
}

func (s *sequenceStore) QueryOutbox(context.Context, notificationstore.ActorContext, []string) (notificationstore.OutboxProjection, error) {
	s.calls++
	if s.calls == 1 {
		return notificationstore.OutboxProjection{PendingCount: 9, DeadCount: 2, OldestPendingAgeSeconds: 3}, nil
	}
	return notificationstore.OutboxProjection{}, errors.New("authorization or Store failure")
}

func TestCollectDoesNotReusePreviousSnapshotAfterFailure(t *testing.T) {
	store := &sequenceStore{}
	service, _ := New(store, time.Second)
	first, err := service.Collect(t.Context())
	if err != nil || first.PendingCount != 9 {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	second, err := service.Collect(t.Context())
	if err == nil || second != (Snapshot{}) {
		t.Fatalf("failed collection reused prior sample: second=%+v err=%v", second, err)
	}
}

func TestCollectTimeoutFailsWithoutStaleFallback(t *testing.T) {
	store := blockingStore{}
	service, _ := New(store, time.Millisecond)
	if _, err := service.Collect(t.Context()); err == nil {
		t.Fatal("timeout did not fail collection")
	}
}

type blockingStore struct{}

func (blockingStore) QueryOutbox(ctx context.Context, _ notificationstore.ActorContext, _ []string) (notificationstore.OutboxProjection, error) {
	<-ctx.Done()
	return notificationstore.OutboxProjection{}, ctx.Err()
}
