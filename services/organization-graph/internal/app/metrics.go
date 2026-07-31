package app

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
	"sync"
)

type metricKey struct {
	Route  string
	Method string
	Status int
}

type ingestMetricKey struct {
	Operation string
	Status    string
}

type counters struct {
	mu                   sync.Mutex
	http                 map[metricKey]uint64
	ingest               map[ingestMetricKey]uint64
	casConflicts         map[string]uint64
	idempotencyConflicts map[string]uint64
	reconciliation       map[string]uint64
}

func newCounters() *counters {
	result := &counters{
		http:                 map[metricKey]uint64{},
		ingest:               map[ingestMetricKey]uint64{},
		casConflicts:         map[string]uint64{},
		idempotencyConflicts: map[string]uint64{},
		reconciliation:       map[string]uint64{},
	}
	for _, operation := range []string{OperationSnapshotIngest, OperationDeltaIngest} {
		for _, status := range []string{
			ReceiptAccepted,
			ReceiptDuplicate,
			ReceiptReconciliationRequired,
		} {
			result.ingest[ingestMetricKey{Operation: operation, Status: status}] = 0
		}
		result.casConflicts[operation] = 0
		result.idempotencyConflicts[operation] = 0
		result.reconciliation[operation] = 0
	}
	return result
}

func (value *counters) recordHTTP(route, method string, status int) {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.http[metricKey{Route: route, Method: method, Status: status}]++
}

func (value *counters) recordIngest(operation, status string) {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.ingest[ingestMetricKey{Operation: operation, Status: status}]++
	if status == ReceiptReconciliationRequired {
		value.reconciliation[operation]++
	}
}

func (value *counters) recordConflict(operation string) {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.casConflicts[operation]++
}

func (value *counters) recordIdempotencyConflict(operation string) {
	value.mu.Lock()
	defer value.mu.Unlock()
	value.idempotencyConflicts[operation]++
}

func (value *counters) render(store StoreMetrics) []byte {
	value.mu.Lock()
	defer value.mu.Unlock()

	var output bytes.Buffer
	output.WriteString("# HELP openslack_graph_http_requests_total HTTP requests handled by the Organization Graph service.\n")
	output.WriteString("# TYPE openslack_graph_http_requests_total counter\n")
	httpKeys := make([]metricKey, 0, len(value.http))
	for key := range value.http {
		httpKeys = append(httpKeys, key)
	}
	sort.Slice(httpKeys, func(left, right int) bool {
		if httpKeys[left].Route != httpKeys[right].Route {
			return httpKeys[left].Route < httpKeys[right].Route
		}
		if httpKeys[left].Method != httpKeys[right].Method {
			return httpKeys[left].Method < httpKeys[right].Method
		}
		return httpKeys[left].Status < httpKeys[right].Status
	})
	for _, key := range httpKeys {
		fmt.Fprintf(&output,
			"openslack_graph_http_requests_total{route=%q,method=%q,status=%q} %d\n",
			key.Route,
			key.Method,
			strconv.Itoa(key.Status),
			value.http[key],
		)
	}

	output.WriteString("# HELP openslack_graph_ingest_total Durable graph ingest receipts by operation and status.\n")
	output.WriteString("# TYPE openslack_graph_ingest_total counter\n")
	ingestKeys := make([]ingestMetricKey, 0, len(value.ingest))
	for key := range value.ingest {
		ingestKeys = append(ingestKeys, key)
	}
	sort.Slice(ingestKeys, func(left, right int) bool {
		if ingestKeys[left].Operation != ingestKeys[right].Operation {
			return ingestKeys[left].Operation < ingestKeys[right].Operation
		}
		return ingestKeys[left].Status < ingestKeys[right].Status
	})
	for _, key := range ingestKeys {
		fmt.Fprintf(&output,
			"openslack_graph_ingest_total{operation=%q,status=%q} %d\n",
			key.Operation,
			key.Status,
			value.ingest[key],
		)
	}

	output.WriteString("# HELP openslack_graph_cas_conflicts_total Graph ingest cursor or revision CAS conflicts.\n")
	output.WriteString("# TYPE openslack_graph_cas_conflicts_total counter\n")
	for _, operation := range sortedMetricOperations(value.casConflicts) {
		fmt.Fprintf(&output,
			"openslack_graph_cas_conflicts_total{operation=%q} %d\n",
			operation,
			value.casConflicts[operation],
		)
	}

	output.WriteString("# HELP openslack_graph_idempotency_conflicts_total Graph ingest idempotency keys reused with a different request fingerprint.\n")
	output.WriteString("# TYPE openslack_graph_idempotency_conflicts_total counter\n")
	for _, operation := range sortedMetricOperations(value.idempotencyConflicts) {
		fmt.Fprintf(&output,
			"openslack_graph_idempotency_conflicts_total{operation=%q} %d\n",
			operation,
			value.idempotencyConflicts[operation],
		)
	}

	output.WriteString("# HELP openslack_graph_reconciliation_total Ambiguous graph commits requiring reconciliation.\n")
	output.WriteString("# TYPE openslack_graph_reconciliation_total counter\n")
	for _, operation := range sortedMetricOperations(value.reconciliation) {
		fmt.Fprintf(&output,
			"openslack_graph_reconciliation_total{operation=%q} %d\n",
			operation,
			value.reconciliation[operation],
		)
	}

	writeGauge(&output, "openslack_graph_published_scenarios", "Published graph scenario heads.", float64(store.PublishedScenarios))
	writeGauge(&output, "openslack_graph_published_head_revision_max", "Maximum published graph head revision.", float64(store.PublishedHeadRevisionMax))
	writeGauge(&output, "openslack_graph_reconciliation_pending", "Persisted reconciliation receipts awaiting resolution.", float64(store.ReconciliationPending))
	if store.ShadowBacklog != nil {
		writeGauge(&output, "openslack_graph_shadow_backlog", "Pending shadow ingest records.", float64(*store.ShadowBacklog))
	}
	if store.ShadowLagSeconds != nil {
		writeGauge(&output, "openslack_graph_shadow_lag_seconds", "Age in seconds of the oldest pending shadow record.", *store.ShadowLagSeconds)
	}
	output.WriteString("# HELP openslack_graph_parity_mismatches_total Persisted TS and Go shadow parity mismatches.\n")
	output.WriteString("# TYPE openslack_graph_parity_mismatches_total counter\n")
	if store.ParityMismatchesTotal != nil {
		fmt.Fprintf(&output, "openslack_graph_parity_mismatches_total %d\n", *store.ParityMismatchesTotal)
	}
	return output.Bytes()
}

func writeGauge(output *bytes.Buffer, name, help string, value float64) {
	fmt.Fprintf(output, "# HELP %s %s\n", name, help)
	fmt.Fprintf(output, "# TYPE %s gauge\n", name)
	fmt.Fprintf(output, "%s %s\n", name, strconv.FormatFloat(value, 'f', -1, 64))
}

func sortedMetricOperations(values map[string]uint64) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}
