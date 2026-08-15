// Package budgetapp exposes the private, default-off GS9-E2 durable budget
// qualification surface. It does not activate production Workflow budget
// routing, runner protocol v2, a canary, or a cutover.
package budgetapp

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

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/netbind"
)

const (
	RouteReserve             = "/v1/authority/workflow-budgets:reserve"
	RouteSettle              = "/v1/authority/workflow-budgets:settle"
	RouteAccount             = "/v1/authority/workflow-budgets/runs/{runId}/account"
	RouteReservation         = "/v1/authority/workflow-budgets/runs/{runId}/reservations/{reservationId}"
	RouteReceipt             = "/v1/authority/workflow-budgets/receipts/{idempotencyKey}"
	RouteLive                = "/health/live"
	RouteReady               = "/health/ready"
	RouteVersion             = "/health/version"
	RouteMetrics             = "/metrics"
	HeaderCallerID           = "X-OpenSlack-Workflow-Budget-Caller-ID"
	HeaderWorkspaceID        = "X-OpenSlack-Workflow-Budget-Workspace-ID"
	HeaderRoutingEpoch       = "X-OpenSlack-Workflow-Budget-Routing-Epoch"
	HeaderExpectedBuildSHA   = "X-OpenSlack-Workflow-Budget-Expected-Build-SHA"
	HeaderFingerprint        = "X-OpenSlack-Request-Fingerprint"
	HeaderReplay             = "X-OpenSlack-Idempotent-Replay"
	requestDeadline          = 30 * time.Second
	readDeadline             = 5 * time.Second
	serverReadTimeout        = 30 * time.Second
	serverWriteTimeout       = 45 * time.Second
	maxResponseBodyBytes     = budgetstore.MaxMutationResponseBytes
	metricsRepositoryTimeout = 2 * time.Second
)

var (
	hashPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	identityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
)

type Options struct {
	Repository        budgetstore.Repository
	QualificationMode bool
	BuildSHA          string
	BearerTokenSHA256 string
	WorkspaceID       string
	CallerID          string
	RoutingEpoch      int64
	Seed              budgetstore.QualificationSeed
	Logger            *slog.Logger
}

type Service struct {
	repository        budgetstore.Repository
	qualificationMode bool
	buildSHA          string
	workspaceID       string
	callerID          string
	routingEpoch      int64
	seed              budgetstore.QualificationSeed
	bearerDigest      [sha256.Size]byte
	workspaceDigest   [sha256.Size]byte
	callerDigest      [sha256.Size]byte
	logger            *slog.Logger
	handler           http.Handler

	requests                atomic.Int64
	unauthorized            atomic.Int64
	reservesReserved        atomic.Int64
	reservesRejected        atomic.Int64
	settlementsSettled      atomic.Int64
	providerReconciliations atomic.Int64
	databaseReconciliations atomic.Int64
	replays                 atomic.Int64
}

func New(options Options) (*Service, error) {
	if !hashPattern.MatchString(options.BuildSHA) {
		return nil, fmt.Errorf("budget authority service build SHA must be a lowercase SHA-256 value")
	}
	if options.Logger == nil {
		options.Logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	service := &Service{
		repository: options.Repository, qualificationMode: options.QualificationMode,
		buildSHA: options.BuildSHA, workspaceID: options.WorkspaceID, callerID: options.CallerID,
		routingEpoch: options.RoutingEpoch, seed: options.Seed, logger: options.Logger,
	}
	if options.QualificationMode {
		if options.Repository == nil || !identityPattern.MatchString(options.WorkspaceID) ||
			!identityPattern.MatchString(options.CallerID) || options.RoutingEpoch < 1 ||
			options.RoutingEpoch > 1<<53-1 || !hashPattern.MatchString(options.BearerTokenSHA256) {
			return nil, fmt.Errorf("budget qualification mode requires the exact repository, workspace, caller, epoch, and bearer binding")
		}
		if err := budgetstore.ValidateQualificationSeed(options.Seed); err != nil {
			return nil, fmt.Errorf("budget qualification seed is invalid: %w", err)
		}
		raw, err := hex.DecodeString(options.BearerTokenSHA256)
		if err != nil || len(raw) != sha256.Size {
			return nil, fmt.Errorf("budget authority bearer token hash is invalid")
		}
		copy(service.bearerDigest[:], raw)
		service.workspaceDigest = sha256.Sum256([]byte(options.WorkspaceID))
		service.callerDigest = sha256.Sum256([]byte(options.CallerID))
	} else if options.Repository != nil || options.BearerTokenSHA256 != "" || options.WorkspaceID != "" || options.CallerID != "" || options.RoutingEpoch != 0 ||
		options.Seed != (budgetstore.QualificationSeed{}) {
		return nil, fmt.Errorf("disabled budget authority service must not retain authority bindings")
	}
	service.handler = service.routes()
	return service, nil
}

func (service *Service) Handler() http.Handler { return service.handler }

func (service *Service) routes() http.Handler {
	mux := http.NewServeMux()
	if service.qualificationMode {
		protected := func(handler http.HandlerFunc) http.Handler { return service.requireIdentity(handler) }
		mux.Handle("POST "+RouteReserve, protected(service.handleReserve))
		mux.Handle("POST "+RouteSettle, protected(service.handleSettle))
		mux.Handle("GET "+RouteAccount, protected(service.handleReadAccount))
		mux.Handle("GET "+RouteReservation, protected(service.handleReadReservation))
		mux.Handle("GET "+RouteReceipt, protected(service.handleReadReceipt))
		mux.Handle("GET "+RouteMetrics, protected(service.handleMetrics))
	}
	mux.HandleFunc("GET "+RouteLive, service.handleLive)
	mux.HandleFunc("GET "+RouteReady, service.handleReady)
	mux.HandleFunc("GET "+RouteVersion, service.handleVersion)
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		service.requests.Add(1)
		if request.URL.RawPath != "" || path.Clean(request.URL.Path) != request.URL.Path || strings.Contains(request.URL.Path, "//") {
			writeFailure(w, http.StatusNotFound, "WORKFLOW_CONTROL_BUDGET_NOT_FOUND", "budget authority path was not found")
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
		caller, callerOK := oneHeader(request, HeaderCallerID)
		workspace, workspaceOK := oneHeader(request, HeaderWorkspaceID)
		epoch, epochOK := oneHeader(request, HeaderRoutingEpoch)
		build, buildOK := oneHeader(request, HeaderExpectedBuildSHA)
		valid = valid && subtle.ConstantTimeCompare(digest[:], service.bearerDigest[:]) == 1 &&
			callerOK && constantTimeText(caller, service.callerDigest) &&
			workspaceOK && constantTimeText(workspace, service.workspaceDigest) &&
			epochOK && epoch == strconv.FormatInt(service.routingEpoch, 10) &&
			buildOK && subtle.ConstantTimeCompare([]byte(build), []byte(service.buildSHA)) == 1
		if !valid {
			service.unauthorized.Add(1)
			w.Header().Set("WWW-Authenticate", `Bearer realm="openslack-workflow-budget-authority"`)
			writeFailure(w, http.StatusUnauthorized, "WORKFLOW_CONTROL_BUDGET_UNAUTHORIZED", "budget authority identity is invalid")
			return
		}
		next.ServeHTTP(w, request)
	})
}

func constantTimeText(actual string, expected [sha256.Size]byte) bool {
	digest := sha256.Sum256([]byte(actual))
	return subtle.ConstantTimeCompare(digest[:], expected[:]) == 1
}

func (service *Service) Run(ctx context.Context, bind string, shutdownDeadline time.Duration) error {
	validated, err := netbind.Validate(bind, "loopback")
	if err != nil || validated != bind {
		return fmt.Errorf("budget authority bind must be an exact loopback address: %w", err)
	}
	listener, err := net.Listen("tcp", bind)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	server := &http.Server{
		Addr: bind, Handler: service.Handler(), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: serverReadTimeout, WriteTimeout: serverWriteTimeout,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024,
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), shutdownDeadline)
	defer cancel()
	shutdownErr := server.Shutdown(shutdownContext)
	if shutdownErr != nil {
		shutdownErr = errors.Join(shutdownErr, server.Close())
	}
	serveErr := <-done
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	return errors.Join(shutdownErr, serveErr)
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
	if len(values) != 1 || values[0] == "" {
		return "", false
	}
	return values[0], true
}
