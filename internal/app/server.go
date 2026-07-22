// Package app owns the composition root and HTTP lifecycle facade.
//
// B1 scope: chi v5 router skeleton with liveness and metrics/readiness
// placeholders, plus graceful shutdown.  B3 wires the public intake and vendor
// administration endpoints.
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
	"rc_wsman/internal/calleraccess"
	"rc_wsman/internal/notificationstore"
	"rc_wsman/internal/operationscontrol"
	"rc_wsman/internal/reliability"
	"rc_wsman/internal/vendorregistry"
)

// Deps holds the B3 business-layer dependencies injected into the HTTP server.
type Deps struct {
	Store          Store
	Authenticator  Authenticator
	VendorRegistry VendorRegistry
	Operations     OperationsControl
	Reliability    Reliability
}

// Store is the handler view of the notification store boundary.
type Store interface {
	Intake(ctx context.Context, in notificationstore.ValidatedIntake) (notificationstore.IntakeResult, error)
}

// Authenticator is the handler view of the caller access boundary.
type Authenticator interface {
	AuthenticateCaller(ctx context.Context, bearer string) (calleraccess.CallerPrincipal, error)
	AuthenticateOperator(ctx context.Context, bearer string) (calleraccess.OperatorPrincipal, error)
	ApplyRateLimit(principalID string, opClass string) (time.Duration, error)
}

// VendorRegistry is the handler view of the vendor registry boundary.
type VendorRegistry interface {
	ExecuteCommand(ctx context.Context, actor vendorregistry.ActorContext, cmd vendorregistry.AdminCommand) (vendorregistry.AdminResult, error)
	IsVendorActive(ctx context.Context, actor vendorregistry.ActorContext, vendorID string) (bool, error)
	ListVendors(ctx context.Context, actor vendorregistry.ActorContext, filter vendorregistry.ScopeFilter, cursor string, limit int) (vendorregistry.Page[vendorregistry.VendorListItem], error)
	DescribeVendorState(ctx context.Context, actor vendorregistry.ActorContext, vendorID string) (vendorregistry.VendorStateSummary, error)
	ListEndpointVersions(ctx context.Context, actor vendorregistry.ActorContext, vendorID string, cursor string, limit int) (vendorregistry.Page[vendorregistry.EndpointVersionListItem], int64, error)
	ListAdminAuditEvents(ctx context.Context, actor vendorregistry.ActorContext, filter vendorregistry.ScopeFilter, cursor string, limit int) (vendorregistry.Page[vendorregistry.AdminAuditListItem], error)
}

type OperationsControl interface {
	QueryOutbox(context.Context, calleraccess.OperatorPrincipal, []string) (operationscontrol.OutboxProjection, error)
	QueryNotification(context.Context, calleraccess.OperatorPrincipal, string) (operationscontrol.NotificationStatus, error)
	ListDead(context.Context, calleraccess.OperatorPrincipal, []string, int, string) (operationscontrol.DeadPage, error)
	ListAttemptHistory(context.Context, calleraccess.OperatorPrincipal, string, int, string) (operationscontrol.AttemptPage, error)
	PreviewReplay(context.Context, calleraccess.OperatorPrincipal, []string, string) ([]operationscontrol.ReplayPreviewItem, error)
	ExecuteReplay(context.Context, calleraccess.OperatorPrincipal, []operationscontrol.ReplayExecuteInput, string) (operationscontrol.ReplayExecuteResult, error)
}

type Reliability interface {
	Collect(context.Context) (reliability.Snapshot, error)
}

// Server is the HTTP lifecycle wrapper.  It exposes liveness, metrics/readiness
// and the B3 business routes.
type Server struct {
	http             *http.Server
	pool             *pgxpool.Pool
	logger           *slog.Logger
	metricsPath      string
	deploymentDigest string
	ready            func() bool
	deps             Deps
}

// NewServer builds a chi router with the B1 handlers.
// ready defaults to true only when a non-nil pool has been supplied; callers
// should override it with a real readiness predicate before accepting traffic.
func NewServer(addr, metricsPath, deploymentDigest string, pool *pgxpool.Pool, logger *slog.Logger) *Server {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)

	s := &Server{
		pool:             pool,
		logger:           logger,
		metricsPath:      metricsPath,
		deploymentDigest: deploymentDigest,
		ready:            func() bool { return pool != nil },
	}
	r.Use(s.requestLogger)

	r.Get("/health/live", s.handleLive)
	r.Get("/health/ready", s.handleReady)
	r.Get(s.metricsPath, s.handleMetrics)

	// Business routes.
	r.Post("/v1/notifications", s.handleSubmitNotification)
	r.Route("/v1/vendor-admin", func(r chi.Router) {
		r.Post("/commands", s.handleVendorAdminCommand)
	})
	r.Get("/v1/vendors", s.handleListVendors)
	r.Get("/v1/vendors/{vendor_id}", s.handleDescribeVendor)
	r.Get("/v1/vendors/{vendor_id}/versions", s.handleListEndpointVersions)
	r.Get("/v1/vendor-admin/audit-events", s.handleListAdminAuditEvents)
	r.Route("/v1/ops", func(r chi.Router) {
		r.Get("/outbox", s.handleOpsOutbox)
		r.Get("/notifications/{notification_id}", s.handleOpsNotification)
		r.Get("/notifications/{notification_id}/attempts", s.handleOpsAttempts)
		r.Get("/dead", s.handleOpsDead)
		r.Post("/replays/preview", s.handleOpsReplayPreview)
		r.Post("/replays/execute", s.handleOpsReplayExecute)
	})

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

// SetDeps injects the business-layer dependencies.  It must be called before the
// server accepts traffic if B3 handlers are required.
func (s *Server) SetDeps(deps Deps) {
	s.deps = deps
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

func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		s.logger.Info("http_request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", middleware.GetReqID(r.Context()),
		)
	})
}

func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if s.ready == nil || !s.ready() {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("not ready"))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ready"))
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if s.ready == nil || !s.ready() {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	if s.deps.Reliability == nil {
		http.Error(w, "metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	snapshot, err := s.deps.Reliability.Collect(r.Context())
	if err != nil {
		http.Error(w, "metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	if err := reliability.WritePrometheus(w, snapshot); err != nil {
		s.logger.Warn("metrics_encode_failed")
	}
}
