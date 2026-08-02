// Package app exposes the bounded GS5 governance shadow HTTP surface.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
)

const (
	RouteObservation     = shadowstore.ObservationPath
	RouteProjection      = "/v1/shadow/governance/plans/{planId}/projection"
	RouteLive            = "/health/live"
	RouteReady           = "/health/ready"
	RouteVersion         = "/health/version"
	RouteMetrics         = "/metrics"
	HeaderWorkspaceID    = "X-OpenSlack-Workspace-ID"
	MaxResponseBodyBytes = 2 * 1024 * 1024
)

var buildSHAPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Options struct {
	Store    shadowstore.Store
	BuildSHA string
	Logger   *slog.Logger
}

type Service struct {
	store      shadowstore.Store
	buildSHA   string
	logger     *slog.Logger
	handler    http.Handler
	requests   atomic.Int64
	accepted   atomic.Int64
	duplicates atomic.Int64
	mismatches atomic.Int64
	conflicts  atomic.Int64
}

func New(options Options) (*Service, error) {
	if options.Store == nil {
		return nil, fmt.Errorf("governance shadow Store is required")
	}
	if !buildSHAPattern.MatchString(options.BuildSHA) {
		return nil, fmt.Errorf("service build SHA must be 64 lowercase hexadecimal characters")
	}
	if options.Logger == nil {
		options.Logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	service := &Service{store: options.Store, buildSHA: options.BuildSHA, logger: options.Logger}
	service.handler = service.routes()
	return service, nil
}

func (service *Service) Handler() http.Handler { return service.handler }

func (service *Service) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+RouteObservation, service.handleObservation)
	mux.HandleFunc("GET "+RouteProjection, service.handleProjection)
	mux.HandleFunc("GET "+RouteLive, service.handleLive)
	mux.HandleFunc("GET "+RouteReady, service.handleReady)
	mux.HandleFunc("GET "+RouteVersion, service.handleVersion)
	mux.HandleFunc("GET "+RouteMetrics, service.handleMetrics)
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		service.requests.Add(1)
		mux.ServeHTTP(w, request)
	})
}

func (service *Service) Run(ctx context.Context, bind string, shutdownDeadline time.Duration) error {
	listener, err := net.Listen("tcp", bind)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer listener.Close()
	server := &http.Server{
		Addr: bind, Handler: service.Handler(), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 35 * time.Second, IdleTimeout: 60 * time.Second,
		MaxHeaderBytes: 16 * 1024,
	}
	done := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		done <- err
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownDeadline)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		_ = server.Close()
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return <-done
}
