// Package drainmetrics provides read-only, explicitly scoped current gauges.
// It is not an admission or budget authority.
package drainmetrics

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Reader interface {
	DrainStatistics(context.Context, string, int64) (map[string]int64, error)
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
var metricName = regexp.MustCompile(`^[a-z_]+$`)

// Handle is called behind the service's existing authentication middleware.
// A scoped query cannot fall back to unscoped or cumulative metrics.
func Handle(w http.ResponseWriter, r *http.Request, repository any, workspace, build, plane string, allowedEpoch func(int64) bool) bool {
	if r.URL.RawQuery == "" {
		return false
	}
	q, queryErr := url.ParseQuery(r.URL.RawQuery)
	epoch, err := strconv.ParseInt(q.Get("drainEpoch"), 10, 64)
	if queryErr != nil || err != nil || epoch < 1 || epoch > 9007199254740991 || strconv.FormatInt(epoch, 10) != q.Get("drainEpoch") || len(q) != 2 || len(q["drainEpoch"]) != 1 || len(q["drainWorkspace"]) != 1 || q.Get("drainWorkspace") != workspace || !safeID.MatchString(workspace) || r.ContentLength != 0 || len(r.TransferEncoding) != 0 || !allowedEpoch(epoch) {
		http.Error(w, "invalid drain scope", http.StatusBadRequest)
		return true
	}
	reader, ok := repository.(Reader)
	if !ok {
		http.Error(w, "drain evidence unavailable", http.StatusServiceUnavailable)
		return true
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	values, err := reader.DrainStatistics(ctx, workspace, epoch)
	if err != nil || len(values) == 0 {
		http.Error(w, "drain evidence unavailable", http.StatusServiceUnavailable)
		return true
	}
	names := make([]string, 0, len(values))
	for name, value := range values {
		if !metricName.MatchString(name) || value < 0 || value > 9007199254740991 {
			http.Error(w, "invalid drain evidence", http.StatusServiceUnavailable)
			return true
		}
		names = append(names, name)
	}
	sort.Strings(names)
	labels := fmt.Sprintf(`{workspace_id=%q,routing_epoch=%q,build_sha=%q,plane=%q}`, workspace, strconv.FormatInt(epoch, 10), build, plane)
	lines := []string{"openslack_drain_scope" + labels + " 1"}
	for _, name := range names {
		lines = append(lines, fmt.Sprintf("openslack_drain_%s%s %d", name, labels, values[name]))
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write([]byte(strings.Join(lines, "\n") + "\n"))
	return true
}
