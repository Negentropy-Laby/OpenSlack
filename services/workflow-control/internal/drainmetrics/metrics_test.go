package drainmetrics

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

type fixtureReader struct {
	called    int
	workspace string
	epoch     int64
	values    map[string]int64
}

func (r *fixtureReader) DrainStatistics(_ context.Context, w string, e int64) (map[string]int64, error) {
	r.called++
	r.workspace = w
	r.epoch = e
	return r.values, nil
}
func TestScopedDrainRead(t *testing.T) {
	r := &fixtureReader{values: map[string]int64{"active_runs": 1, "outbox_pending": 0}}
	request := httptest.NewRequest("GET", "/metrics?drainWorkspace=workspace.test&drainEpoch=9", nil)
	response := httptest.NewRecorder()
	if !Handle(response, request, r, "workspace.test", strings.Repeat("a", 64), "authority", func(e int64) bool { return e == 9 }) || response.Code != 200 || r.called != 1 || r.workspace != "workspace.test" || r.epoch != 9 || !strings.Contains(response.Body.String(), "openslack_drain_active_runs{") {
		t.Fatalf("scoped read: %d %s %+v", response.Code, response.Body.String(), r)
	}
}
func TestInvalidScopeDoesNotRead(t *testing.T) {
	for _, query := range []string{"drainWorkspace=other&drainEpoch=9", "drainWorkspace=workspace.test&drainEpoch=0", "drainWorkspace=workspace.test&drainEpoch=9&drainEpoch=9", "drainWorkspace=workspace.test&drainEpoch=09", "drainWorkspace=workspace.test&drainEpoch=9&extra=1"} {
		t.Run(query, func(t *testing.T) {
			r := &fixtureReader{}
			response := httptest.NewRecorder()
			Handle(response, httptest.NewRequest("GET", "/metrics?"+query, nil), r, "workspace.test", strings.Repeat("a", 64), "authority", func(e int64) bool { return e == 9 })
			if response.Code != 400 || r.called != 0 {
				t.Fatalf("invalid scope read: %d %+v", response.Code, r)
			}
		})
	}
}
