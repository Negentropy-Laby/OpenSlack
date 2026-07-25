package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"sync"
	"testing"
	"time"

	"rc_wsman/internal/notificationstore"
)

// TestCapacityBaseline is deliberately opt-in: it writes 1,100 samples to its
// process-isolated schema and reports measurements for the current machine. It
// establishes an engineering baseline, not an SLA.
func TestCapacityBaseline(t *testing.T) {
	if os.Getenv("RUN_CAPACITY_BASELINE") != "1" {
		t.Skip("set RUN_CAPACITY_BASELINE=1 for the local capacity baseline")
	}
	f := newStoreFixture(t)
	ctx := context.Background()
	vendorID := "vendor-capacity-baseline"
	f.seedVendor(ctx, vendorID)
	callerID := "caller-capacity-baseline"
	defer func() {
		_, _ = f.pool.Exec(context.Background(), `DELETE FROM notifications WHERE vendor_id=$1`, vendorID)
	}()
	measureRelationSizes := func() map[string]int64 {
		sizes := map[string]int64{}
		for _, relation := range []string{"notifications", "delivery_attempts"} {
			var tableBytes, indexBytes int64
			if err := f.pool.QueryRow(ctx, `SELECT pg_relation_size($1), pg_indexes_size($1)`, relation).Scan(&tableBytes, &indexBytes); err != nil {
				t.Fatal(err)
			}
			sizes[relation+"_table_bytes"] = tableBytes
			sizes[relation+"_index_bytes"] = indexBytes
		}
		return sizes
	}
	relationSizesBefore := measureRelationSizes()

	type sampleSet struct {
		Name    string        `json:"name"`
		Count   int           `json:"count"`
		Payload int           `json:"payload_bytes"`
		P50     time.Duration `json:"p50"`
		P95     time.Duration `json:"p95"`
		P99     time.Duration `json:"p99"`
		Total   time.Duration `json:"total"`
	}
	runIntake := func(name string, count, payloadBytes int, keyOffset int) sampleSet {
		payload := make([]byte, payloadBytes)
		for i := range payload {
			payload[i] = 'x'
		}
		latencies := make([]time.Duration, 0, count)
		started := time.Now()
		for i := 0; i < count; i++ {
			one := time.Now()
			_, err := f.repo.Intake(ctx, notificationstore.ValidatedIntake{
				CallerID: callerID, VendorID: vendorID, Payload: payload,
				IdempotencyKey: fmt.Sprintf("capacity-%d", keyOffset+i),
			})
			if err != nil {
				t.Fatalf("intake %s[%d]: %v", name, i, err)
			}
			latencies = append(latencies, time.Since(one))
		}
		sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
		percentile := func(p float64) time.Duration {
			idx := int(float64(len(latencies)-1) * p)
			return latencies[idx]
		}
		return sampleSet{Name: name, Count: count, Payload: payloadBytes, P50: percentile(.50), P95: percentile(.95), P99: percentile(.99), Total: time.Since(started)}
	}
	small := runIntake("small", 1000, 1024, 0)
	large := runIntake("large", 100, notificationstore.PayloadMaxBytes, 1000)

	actor := workerActor(vendorID)
	drainStarted := time.Now()
	var wg sync.WaitGroup
	errCh := make(chan error, 5)
	var delivered int
	var deliveredMu sync.Mutex
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				claim, err := f.repo.ClaimNext(ctx, actor, nil, 30*time.Second)
				if errors.Is(err, notificationstore.ErrNoEligibleNotification) {
					return
				}
				if err != nil {
					errCh <- err
					return
				}
				_, err = f.repo.Transition(ctx, actor, notificationstore.TransitionRequest{
					NotificationID: claim.NotificationID, ExpectedState: notificationstore.StateInFlight,
					ExpectedVersion: claim.Version, LeaseID: claim.LeaseID, RequestedTransition: notificationstore.TransitionSucceed,
					DeliveryResult: &notificationstore.DeliveryResult{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassSuccess, HTTPStatus: 204},
				})
				if err != nil {
					errCh <- err
					return
				}
				deliveredMu.Lock()
				delivered++
				deliveredMu.Unlock()
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
	drainDuration := time.Since(drainStarted)
	if delivered != 1100 {
		t.Fatalf("delivered=%d want=1100", delivered)
	}

	global := notificationstore.ActorContext{Kind: notificationstore.ActorSystem, ActorID: "capacity-metrics", VendorScope: []string{"*"}, Capabilities: []notificationstore.Capability{notificationstore.CapabilityReadAllNotifications}}
	projection, err := f.repo.QueryOutbox(ctx, global, nil)
	if err != nil {
		t.Fatal(err)
	}
	var postgresVersion, plan string
	if err := f.pool.QueryRow(ctx, `SELECT version()`).Scan(&postgresVersion); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `EXPLAIN (FORMAT JSON) SELECT notification_id FROM notifications WHERE state='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at, notification_id LIMIT 1`).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	relationSizesAfter := measureRelationSizes()
	relationSizeGrowth := make(map[string]int64, len(relationSizesAfter))
	for name, after := range relationSizesAfter {
		relationSizeGrowth[name] = after - relationSizesBefore[name]
		if relationSizeGrowth[name] <= 0 {
			t.Fatalf("relation %s did not grow: before=%d after=%d", name, relationSizesBefore[name], after)
		}
	}
	report := map[string]any{
		"environment":           map[string]any{"postgres": postgresVersion, "workers": 5},
		"intake":                []sampleSet{small, large},
		"drain":                 map[string]any{"delivered": delivered, "duration": drainDuration.String(), "per_second": float64(delivered) / drainDuration.Seconds(), "vendor_latency": "in-process result commit baseline"},
		"outbox_after_drain":    projection,
		"claim_query_plan":      plan,
		"relation_sizes_before": relationSizesBefore,
		"relation_sizes_after":  relationSizesAfter,
		"relation_size_growth":  relationSizeGrowth,
	}
	b, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("CAPACITY_BASELINE %s", b)
}
