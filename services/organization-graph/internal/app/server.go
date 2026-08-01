// Package app exposes the bounded Organization Graph HTTP composition surface.
package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"regexp"
	"time"
)

const (
	RouteSnapshotIngest = "/v1/graph/snapshots:ingest"
	RouteDeltaIngest    = "/v1/graph/deltas:ingest"
	RouteQuery          = "/v1/graph:query"
	RouteExplain        = "/v1/graph:explain"
	RouteScenarios      = "/v1/graph/scenarios"
	RouteLive           = "/health/live"
	RouteReady          = "/health/ready"
	RouteVersion        = "/health/version"
	RouteMetrics        = "/metrics"
)

var serviceBuildSHAPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now().UTC() }

type Options struct {
	Store                Store
	CursorSecret         []byte
	PreviousCursorSecret []byte
	BuildSHA             string
	Logger               *slog.Logger
	Clock                Clock
}

type Service struct {
	store                Store
	cursorSecret         []byte
	previousCursorSecret []byte
	buildSHA             string
	logger               *slog.Logger
	clock                Clock
	counters             *counters
	handler              http.Handler
}

func New(options Options) (*Service, error) {
	if options.Store == nil {
		return nil, fmt.Errorf("graph HTTP Store is required")
	}
	if len(options.CursorSecret) < graphCursorSecretMinBytes ||
		len(options.CursorSecret) > graphCursorSecretMaxBytes {
		return nil, fmt.Errorf("graph query cursor secret is outside its frozen bounds")
	}
	if len(options.PreviousCursorSecret) != 0 &&
		(len(options.PreviousCursorSecret) < graphCursorSecretMinBytes ||
			len(options.PreviousCursorSecret) > graphCursorSecretMaxBytes) {
		return nil, fmt.Errorf("previous graph query cursor secret is outside its frozen bounds")
	}
	if len(options.PreviousCursorSecret) != 0 && bytes.Equal(options.CursorSecret, options.PreviousCursorSecret) {
		return nil, fmt.Errorf("previous graph query cursor secret must differ from the active secret")
	}
	if !serviceBuildSHAPattern.MatchString(options.BuildSHA) {
		return nil, fmt.Errorf("graph service build SHA must be 64 lowercase hexadecimal characters")
	}
	if options.Logger == nil {
		options.Logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	if options.Clock == nil {
		options.Clock = realClock{}
	}
	service := &Service{
		store:                options.Store,
		cursorSecret:         append([]byte(nil), options.CursorSecret...),
		previousCursorSecret: append([]byte(nil), options.PreviousCursorSecret...),
		buildSHA:             options.BuildSHA,
		logger:               options.Logger,
		clock:                options.Clock,
		counters:             newCounters(),
	}
	service.handler = service.routes()
	return service, nil
}

const (
	graphCursorSecretMinBytes = 32
	graphCursorSecretMaxBytes = 1024
)

func (service *Service) Handler() http.Handler {
	return service.handler
}

func (service *Service) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+RouteSnapshotIngest, service.handleSnapshotIngest)
	mux.HandleFunc("POST "+RouteDeltaIngest, service.handleDeltaIngest)
	mux.HandleFunc("POST "+RouteQuery, service.handleQuery)
	mux.HandleFunc("POST "+RouteExplain, service.handleExplain)
	mux.HandleFunc("GET "+RouteScenarios, service.handleScenarios)
	mux.HandleFunc("GET "+RouteLive, service.handleLive)
	mux.HandleFunc("GET "+RouteReady, service.handleReady)
	mux.HandleFunc("GET "+RouteVersion, service.handleVersion)
	mux.HandleFunc("GET "+RouteMetrics, service.handleMetrics)
	return service.instrument(mux)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusWriter) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *statusWriter) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	return writer.ResponseWriter.Write(body)
}

func (service *Service) instrument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		writer := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(writer, request)
		if writer.status == 0 {
			writer.status = http.StatusOK
		}
		service.counters.recordHTTP(routeLabel(request.URL.Path), metricMethod(request.Method), writer.status)
	})
}

func metricMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodPost:
		return method
	default:
		return "other"
	}
}

func routeLabel(path string) string {
	switch path {
	case RouteSnapshotIngest, RouteDeltaIngest, RouteQuery, RouteExplain,
		RouteScenarios, RouteLive, RouteReady, RouteVersion, RouteMetrics:
		return path
	default:
		return "unmatched"
	}
}

// Run owns the HTTP listener and performs bounded graceful shutdown after the
// context is cancelled.
func (service *Service) Run(ctx context.Context, bind string, shutdownDeadline time.Duration) error {
	listener, err := net.Listen("tcp", bind)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer listener.Close()

	server := &http.Server{
		Addr:              bind,
		Handler:           service.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
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
