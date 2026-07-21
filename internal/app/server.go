// Package app owns the composition root and HTTP lifecycle facade.
//
// B1 scope: chi v5 router skeleton with liveness and metrics/readiness
// placeholders, plus graceful shutdown.  No business handlers are wired here
// until later batches.
package app

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Server is the HTTP lifecycle wrapper.  It exposes only liveness and metrics
// readiness in B1; business routes are added by later implementation batches.
type Server struct {
	http        *http.Server
	pool        *pgxpool.Pool
	logger      *slog.Logger
	metricsPath string
	ready       func() bool
}

// NewServer builds a chi router with the B1 handlers.
// ready defaults to true only when a non-nil pool has been supplied; callers
// should override it with a real readiness predicate before accepting traffic.
func NewServer(addr, metricsPath string, pool *pgxpool.Pool, logger *slog.Logger) *Server {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)

	s := &Server{
		pool:        pool,
		logger:      logger,
		metricsPath: metricsPath,
		ready:       func() bool { return pool != nil },
	}

	r.Get("/healthz", s.handleHealthz)
	r.Get(s.metricsPath, s.handleMetrics)

	s.http = &http.Server{
		Addr:         addr,
		Handler:      r,
		BaseContext:  func(_ net.Listener) context.Context { return context.Background() },
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	return s
}

// SetReady replaces the readiness predicate.  It is used once startup has
// completed (database reachable, schema compatible, dependencies wired).
func (s *Server) SetReady(ready func() bool) {
	s.ready = ready
}

// Handler exposes the router for tests.
func (s *Server) Handler() http.Handler {
	return s.http.Handler
}

// Run starts the HTTP listener and blocks until the supplied context is
// cancelled or the listener fails.  On cancellation it performs a graceful
// shutdown bounded by shutdownTimeout.
func (s *Server) Run(ctx context.Context, shutdownTimeout time.Duration) error {
	errCh := make(chan error, 1)
	go func() {
		s.logger.Info("http_server_listening", "addr", s.http.Addr)
		if err := s.http.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		return s.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}

// Shutdown closes the listener and waits for active requests to finish.
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("http_server_shutting_down")
	return s.http.Shutdown(ctx)
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if s.ready == nil || !s.ready() {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	promhttp.Handler().ServeHTTP(w, r)
}
