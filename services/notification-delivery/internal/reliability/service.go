// Package reliability projects the authoritative global Store outbox snapshot
// into the three low-cardinality day-one reliability metrics.
package reliability

import (
	"context"
	"fmt"
	"io"
	"math"
	"strconv"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore"
)

type Store interface {
	QueryOutbox(context.Context, notificationstore.ActorContext, []string) (notificationstore.OutboxProjection, error)
}

type Snapshot struct {
	PendingCount            int
	OldestPendingAgeSeconds float64
	DeadCount               int
	ObservedAt              time.Time
}

type Service struct {
	store   Store
	timeout time.Duration
}

func New(store Store, timeout time.Duration) (*Service, error) {
	if store == nil || timeout <= 0 {
		return nil, fmt.Errorf("reliability: invalid dependency or timeout")
	}
	return &Service{store: store, timeout: timeout}, nil
}

func (s *Service) Collect(ctx context.Context) (Snapshot, error) {
	queryCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	actor := notificationstore.ActorContext{
		Kind: notificationstore.ActorSystem, ActorID: "reliability-observability",
		VendorScope: []string{"*"}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityReadAllNotifications},
	}
	projection, err := s.store.QueryOutbox(queryCtx, actor, nil)
	if err != nil {
		return Snapshot{}, fmt.Errorf("collect global outbox: %w", err)
	}
	if projection.PendingCount < 0 || projection.DeadCount < 0 || math.IsNaN(projection.OldestPendingAgeSeconds) || math.IsInf(projection.OldestPendingAgeSeconds, 0) || projection.OldestPendingAgeSeconds < 0 {
		return Snapshot{}, fmt.Errorf("invalid Store projection")
	}
	return Snapshot{projection.PendingCount, projection.OldestPendingAgeSeconds, projection.DeadCount, time.Now().UTC()}, nil
}

func WritePrometheus(w io.Writer, snapshot Snapshot) error {
	lines := []struct {
		name  string
		help  string
		value string
	}{
		{"rc_wsman_outbox_pending", "Number of pending notifications in the global outbox.", strconv.Itoa(snapshot.PendingCount)},
		{"rc_wsman_oldest_pending_age_seconds", "Age in seconds of the oldest pending notification.", strconv.FormatFloat(snapshot.OldestPendingAgeSeconds, 'g', -1, 64)},
		{"rc_wsman_dead_notifications", "Number of notifications currently in dead state.", strconv.Itoa(snapshot.DeadCount)},
	}
	for _, metric := range lines {
		if _, err := fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s %s\n", metric.name, metric.help, metric.name, metric.name, metric.value); err != nil {
			return err
		}
	}
	return nil
}
