package app

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rc_wsman/internal/reliability"
)

type fixedReliability struct {
	snapshot reliability.Snapshot
	err      error
}

func (f fixedReliability) Collect(context.Context) (reliability.Snapshot, error) {
	return f.snapshot, f.err
}

func TestHealthLive(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer(":0", "/metrics", nil, logger)

	req := httptest.NewRequest(http.MethodGet, "/health/live", nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("/health/live status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != "ok" {
		t.Fatalf("/health/live body = %q, want %q", got, "ok")
	}
}

func TestHealthReady(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer(":0", "/metrics", nil, logger)
	srv.SetReady(func() bool { return false })
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("not-ready status = %d", rec.Code)
	}
	srv.SetReady(func() bool { return true })
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "ready" {
		t.Fatalf("ready response = %d %q", rec.Code, rec.Body.String())
	}
}

func TestMetrics_NotReadyReturns503(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer(":0", "/metrics", nil, logger)
	srv.SetReady(func() bool { return false })

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("/metrics status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestMetrics_ReadyReturns200(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer(":0", "/metrics", nil, logger)
	srv.SetReady(func() bool { return true })
	srv.SetDeps(Deps{Reliability: fixedReliability{snapshot: reliability.Snapshot{PendingCount: 1, ObservedAt: time.Now()}}})

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics status = %d, want %d", rec.Code, http.StatusOK)
	}
	if ct := rec.Header().Get("Content-Type"); ct == "" {
		t.Fatal("/metrics response missing Content-Type")
	}
	if got := rec.Body.String(); !strings.Contains(got, "rc_wsman_outbox_pending 1") || strings.Contains(got, "go_gc") {
		t.Fatalf("unexpected metrics: %s", got)
	}
}

func TestMetrics_CollectorFailureReturns503WithoutBusinessSamples(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := NewServer(":0", "/metrics", nil, logger)
	srv.SetReady(func() bool { return true })
	srv.SetDeps(Deps{Reliability: fixedReliability{err: context.DeadlineExceeded}})

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("/metrics status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	if body := rec.Body.String(); strings.Contains(body, "rc_wsman_") {
		t.Fatalf("failed scrape published a business sample: %q", body)
	}
}
