// Package runnerapp exposes the private, authenticated GS8-B runner admission
// surface. It owns runner job lifecycle admission only; TypeScript remains the
// Workflow RunStore, checkpoint, approval, budget, and effect authority.
package runnerapp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

const (
	RouteJobs                  = "/v1/runner/jobs"
	RouteV2Jobs                = "/v2/runner/jobs"
	RouteAuthorityBindingStage = "/v2/runner/authority-bindings:stage"
	RouteAuthorityBinding      = "/v2/runner/authority-bindings/{bindingAction}"
	RouteAuthorityReceipt      = "/v2/runner/authority-bindings/receipts/{idempotencyKey}"
	RouteV2RuntimeAdmission    = "/v2/runner/runtime-admissions:seal"
	RouteJob                   = "/v1/runner/jobs/{jobId}"
	RouteCancellation          = "/v1/runner/jobs/{jobId}/cancellations"
	RouteLive                  = "/health/live"
	RouteReady                 = "/health/ready"
	RouteVersion               = "/health/version"
	RouteMetrics               = "/metrics"
	HeaderWorkspaceID          = "X-OpenSlack-Workspace-ID"
	HeaderRequestFingerprint   = "X-OpenSlack-Request-Fingerprint"
	HeaderIdempotencyReplayed  = "Idempotency-Replayed"
	MaxResponseBodyBytes       = 2 * 1024 * 1024
	requestDeadline            = 30 * time.Second
	readDeadline               = 5 * time.Second
)

var (
	hashPattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	safeID            = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	bindingIDPattern  = regexp.MustCompile(`^WFRUNNER-BINDING-[0-9a-f]{64}$`)
	bindingKeyPattern = regexp.MustCompile(`^openslack\.workflow-runner-authority-binding\.v1\.[0-9a-f]{64}$`)
)

type Options struct {
	Store             runnerstore.Store
	V2Store           runnerstore.V2JobStore
	BindingStore      runnerstore.V2AuthorityBindingStore
	AdmissionStore    runnerstore.V2RuntimeAdmissionStore
	V2Qualification   bool
	V2RuntimeDelivery bool
	SchemaVersion     int64
	BuildSHA          string
	WorkspaceID       string
	BearerTokenSHA256 string
	Logger            *slog.Logger
}

type Service struct {
	store             runnerstore.Store
	v2Store           runnerstore.V2JobStore
	bindingStore      runnerstore.V2AuthorityBindingStore
	admissionStore    runnerstore.V2RuntimeAdmissionStore
	v2Enabled         bool
	v2RuntimeDelivery bool
	schemaVersion     int64
	buildSHA          string
	workspaceID       string
	tokenHash         [sha256.Size]byte
	logger            *slog.Logger
	handler           http.Handler

	requests      atomic.Int64
	unauthorized  atomic.Int64
	accepted      atomic.Int64
	duplicates    atomic.Int64
	cancellations atomic.Int64
	conflicts     atomic.Int64
}

func New(options Options) (*Service, error) {
	if options.Store == nil {
		return nil, fmt.Errorf("runner Store is required")
	}
	if !hashPattern.MatchString(options.BuildSHA) || !hashPattern.MatchString(options.BearerTokenSHA256) {
		return nil, fmt.Errorf("runner build and bearer token hashes must be full lowercase SHA-256 values")
	}
	if !safeID.MatchString(options.WorkspaceID) {
		return nil, fmt.Errorf("runner workspace identity is invalid")
	}
	tokenHash, err := hex.DecodeString(options.BearerTokenSHA256)
	if err != nil || len(tokenHash) != sha256.Size {
		return nil, fmt.Errorf("runner bearer token hash is invalid")
	}
	if options.Logger == nil {
		options.Logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	service := &Service{
		store: options.Store, buildSHA: options.BuildSHA,
		v2Store: options.V2Store, bindingStore: options.BindingStore, admissionStore: options.AdmissionStore, v2Enabled: options.V2Qualification,
		v2RuntimeDelivery: options.V2RuntimeDelivery,
		schemaVersion:     options.SchemaVersion,
		workspaceID:       options.WorkspaceID, logger: options.Logger,
	}
	if service.v2Enabled && service.v2Store == nil {
		return nil, fmt.Errorf("runner v2 qualification Store is required when enabled")
	}
	if service.v2RuntimeDelivery && !service.v2Enabled {
		return nil, fmt.Errorf("runner v2 runtime delivery requires v2 qualification")
	}
	if service.v2RuntimeDelivery && (service.bindingStore == nil || service.admissionStore == nil) {
		return nil, fmt.Errorf("runner authority-binding and runtime-admission Stores are required for runtime delivery")
	}
	if service.schemaVersion == 0 {
		service.schemaVersion = 2
	}
	copy(service.tokenHash[:], tokenHash)
	service.handler = service.routes()
	return service, nil
}

func (service *Service) Handler() http.Handler { return service.handler }

func (service *Service) routes() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("POST "+RouteJobs, service.requireIdentity(http.HandlerFunc(service.handleSubmit)))
	if service.v2Enabled {
		mux.Handle("POST "+RouteV2Jobs, service.requireIdentity(http.HandlerFunc(service.handleV2Submit)))
	}
	if service.v2RuntimeDelivery {
		mux.Handle("POST "+RouteV2RuntimeAdmission, service.requireIdentity(http.HandlerFunc(service.handleV2RuntimeAdmission)))
		mux.Handle("POST "+RouteAuthorityBindingStage, service.requireIdentity(http.HandlerFunc(service.handleAuthorityBindingStage)))
		mux.Handle("POST "+RouteAuthorityBinding, service.requireIdentity(http.HandlerFunc(service.handleAuthorityBindingAction)))
		mux.Handle("GET "+RouteAuthorityReceipt, service.requireIdentity(http.HandlerFunc(service.handleAuthorityBindingReceipt)))
	}
	mux.Handle("GET "+RouteJob, service.requireIdentity(http.HandlerFunc(service.handleReadJob)))
	mux.Handle("POST "+RouteCancellation, service.requireIdentity(http.HandlerFunc(service.handleCancellation)))
	mux.HandleFunc("GET "+RouteLive, service.handleLive)
	mux.HandleFunc("GET "+RouteReady, service.handleReady)
	mux.HandleFunc("GET "+RouteVersion, service.handleVersion)
	mux.Handle("GET "+RouteMetrics, service.requireIdentity(http.HandlerFunc(service.handleMetrics)))
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		service.requests.Add(1)
		if request.URL.RawPath != "" || path.Clean(request.URL.Path) != request.URL.Path {
			writeFailure(w, http.StatusNotFound, "WORKFLOW_RUNNER_NOT_FOUND", "runner control path was not found")
			return
		}
		mux.ServeHTTP(w, request)
	})
}

func (service *Service) requireIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		workspaces := request.Header.Values(HeaderWorkspaceID)
		authorizations := request.Header.Values("Authorization")
		valid := len(workspaces) == 1 && workspaces[0] == service.workspaceID && len(authorizations) == 1
		var token string
		if valid {
			const prefix = "Bearer "
			value := authorizations[0]
			valid = len(value) > len(prefix) && len(value) <= len(prefix)+4096 && len(value) >= len(prefix)+32 && value[:len(prefix)] == prefix
			if valid {
				token = value[len(prefix):]
				valid = token != "" && !containsASCIIWhitespace(token)
			}
		}
		digest := sha256.Sum256([]byte(token))
		valid = subtle.ConstantTimeCompare(digest[:], service.tokenHash[:]) == 1 && valid
		if !valid {
			service.unauthorized.Add(1)
			w.Header().Set("WWW-Authenticate", `Bearer realm="openslack-workflow-runner"`)
			writeFailure(w, http.StatusUnauthorized, "WORKFLOW_RUNNER_UNAUTHORIZED", "runner control identity is invalid")
			return
		}
		next.ServeHTTP(w, request)
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
		ReadTimeout: 30 * time.Second, WriteTimeout: 35 * time.Second,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024,
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
	shutdownContext, cancel := context.WithTimeout(context.Background(), shutdownDeadline)
	defer cancel()
	if err := server.Shutdown(shutdownContext); err != nil {
		_ = server.Close()
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return <-done
}

func containsASCIIWhitespace(value string) bool {
	for index := 0; index < len(value); index++ {
		switch value[index] {
		case ' ', '\t', '\r', '\n':
			return true
		}
	}
	return false
}
