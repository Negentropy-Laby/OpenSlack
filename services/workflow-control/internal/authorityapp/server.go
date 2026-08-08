// Package authorityapp exposes the private, default-off GS9-B Workflow
// Control authority qualification surface. It does not activate production
// routing and never changes the TypeScript authority declaration.
package authorityapp

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
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
)

const (
	RouteAccept            = "/v1/workflow-control/runs:accept"
	RouteRunAction         = "/v1/workflow-control/runs/{runAction}"
	RouteRun               = "/v1/workflow-control/runs/{runId}"
	RouteReceipt           = "/v1/workflow-control/receipts/{idempotencyKey}"
	RouteOutbox            = "/v1/workflow-control/runs/{runId}/outbox/{revisionAction}"
	RouteLive              = "/health/live"
	RouteReady             = "/health/ready"
	RouteVersion           = "/health/version"
	RouteMetrics           = "/metrics"
	HeaderCallerID         = "X-OpenSlack-Workflow-Control-Caller-ID"
	HeaderWorkspaceID      = "X-OpenSlack-Workflow-Control-Workspace-ID"
	HeaderRoutingEpoch     = "X-OpenSlack-Workflow-Control-Routing-Epoch"
	HeaderExpectedBuildSHA = "X-OpenSlack-Workflow-Control-Expected-Build-SHA"
	HeaderFingerprint      = "X-OpenSlack-Request-Fingerprint"
	HeaderReplay           = "X-OpenSlack-Idempotent-Replay"
	MaxResponseBodyBytes   = 2 * 1024 * 1024
	requestDeadline        = 30 * time.Second
	readDeadline           = 5 * time.Second
	serverReadTimeout      = 30 * time.Second
	serverWriteTimeout     = 45 * time.Second
)

var (
	hashPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	identityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
)

type Options struct {
	Repository        authoritystore.Repository
	QualificationMode bool
	BuildSHA          string
	BearerTokenSHA256 string
	WorkspaceID       string
	CallerID          string
	RoutingEpoch      int64
	Logger            *slog.Logger
}

type Service struct {
	repository        authoritystore.Repository
	qualificationMode bool
	buildSHA          string
	workspaceID       string
	callerID          string
	routingEpoch      int64
	tokenHash         [sha256.Size]byte
	logger            *slog.Logger
	handler           http.Handler

	requests       atomic.Int64
	unauthorized   atomic.Int64
	accepted       atomic.Int64
	replays        atomic.Int64
	reconciliation atomic.Int64
	conflicts      atomic.Int64
}

func New(options Options) (*Service, error) {
	if !hashPattern.MatchString(options.BuildSHA) {
		return nil, fmt.Errorf("authority service build SHA must be a lowercase SHA-256 value")
	}
	if options.Logger == nil {
		options.Logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	service := &Service{
		repository: options.Repository, qualificationMode: options.QualificationMode,
		buildSHA: options.BuildSHA, workspaceID: options.WorkspaceID, callerID: options.CallerID,
		routingEpoch: options.RoutingEpoch, logger: options.Logger,
	}
	if options.QualificationMode {
		if options.Repository == nil || !identityPattern.MatchString(options.WorkspaceID) ||
			!identityPattern.MatchString(options.CallerID) || options.RoutingEpoch < 1 ||
			!hashPattern.MatchString(options.BearerTokenSHA256) {
			return nil, fmt.Errorf("qualification mode requires the exact repository, workspace, caller, epoch, and bearer binding")
		}
		raw, err := hex.DecodeString(options.BearerTokenSHA256)
		if err != nil || len(raw) != sha256.Size {
			return nil, fmt.Errorf("authority bearer token hash is invalid")
		}
		copy(service.tokenHash[:], raw)
	} else if options.Repository != nil || options.BearerTokenSHA256 != "" || options.WorkspaceID != "" || options.CallerID != "" || options.RoutingEpoch != 0 {
		return nil, fmt.Errorf("disabled authority service must not retain authority bindings")
	}
	service.handler = service.routes()
	return service, nil
}

func (service *Service) Handler() http.Handler { return service.handler }

func (service *Service) routes() http.Handler {
	mux := http.NewServeMux()
	if service.qualificationMode {
		protected := func(handler http.HandlerFunc) http.Handler { return service.requireIdentity(handler) }
		mux.Handle("POST "+RouteAccept, protected(service.handleAccept))
		mux.Handle("POST "+RouteRunAction, protected(service.handleTransition))
		mux.Handle("GET "+RouteRun, protected(service.handleReadRun))
		mux.Handle("GET "+RouteReceipt, protected(service.handleReadReceipt))
		mux.Handle("GET "+RouteOutbox, protected(service.handleReadOutbox))
		mux.Handle("GET "+RouteMetrics, protected(service.handleMetrics))
	} else {
		mux.HandleFunc("GET "+RouteMetrics, service.handleMetrics)
	}
	mux.HandleFunc("GET "+RouteLive, service.handleLive)
	mux.HandleFunc("GET "+RouteReady, service.handleReady)
	mux.HandleFunc("GET "+RouteVersion, service.handleVersion)
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		service.requests.Add(1)
		if request.URL.RawPath != "" || path.Clean(request.URL.Path) != request.URL.Path || strings.Contains(request.URL.Path, "//") {
			writeFailure(w, http.StatusNotFound, "WORKFLOW_CONTROL_AUTHORITY_NOT_FOUND", "authority path was not found")
			return
		}
		mux.ServeHTTP(w, request)
	})
}

func (service *Service) requireIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		authorizations := request.Header.Values("Authorization")
		valid := len(authorizations) == 1
		var token string
		if valid {
			const prefix = "Bearer "
			value := authorizations[0]
			valid = len(value) > len(prefix) && len(value) <= len(prefix)+4096 && strings.HasPrefix(value, prefix)
			if valid {
				token = value[len(prefix):]
				valid = token != "" && !containsASCIIWhitespace(token)
			}
		}
		digest := sha256.Sum256([]byte(token))
		if subtle.ConstantTimeCompare(digest[:], service.tokenHash[:]) != 1 || !valid {
			service.unauthorized.Add(1)
			w.Header().Set("WWW-Authenticate", `Bearer realm="openslack-workflow-control-authority"`)
			writeFailure(w, http.StatusUnauthorized, "WORKFLOW_CONTROL_AUTHORITY_UNAUTHORIZED", "authority bearer identity is invalid")
			return
		}
		caller, callerOK := oneHeader(request, HeaderCallerID)
		workspace, workspaceOK := oneHeader(request, HeaderWorkspaceID)
		epoch, epochOK := oneHeader(request, HeaderRoutingEpoch)
		build, buildOK := oneHeader(request, HeaderExpectedBuildSHA)
		if !callerOK || !workspaceOK || !epochOK || !buildOK || caller != service.callerID ||
			workspace != service.workspaceID || epoch != strconv.FormatInt(service.routingEpoch, 10) || build != service.buildSHA {
			writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_AUTHORITY_BINDING_INVALID", "authority request does not match the exact qualification binding")
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
		ReadTimeout: serverReadTimeout, WriteTimeout: serverWriteTimeout,
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

func oneHeader(request *http.Request, name string) (string, bool) {
	values := request.Header.Values(name)
	returnValue := ""
	if len(values) == 1 {
		returnValue = values[0]
	}
	return returnValue, len(values) == 1 && returnValue != ""
}
