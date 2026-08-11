// Package checkpointshadowapp exposes the default-off GS9-C observation API.
package checkpointshadowapp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointshadowstore"
)

const requestDeadline = 30 * time.Second
const readTimeout = 30 * time.Second
const writeTimeout = 45 * time.Second

type Options struct {
	QualificationMode                                  bool
	BuildSHA, BearerTokenSHA256, WorkspaceID, CallerID string
	Store                                              checkpointshadowstore.Store
	Logger                                             *slog.Logger
}
type Service struct {
	options                                              Options
	handler                                              http.Handler
	requests, unauthorized, accepts, replays, mismatches atomic.Int64
}

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var identityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)

func New(options Options) (*Service, error) {
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.QualificationMode && (options.Store == nil || !hashPattern.MatchString(options.BuildSHA) || !hashPattern.MatchString(options.BearerTokenSHA256) || !identityPattern.MatchString(options.WorkspaceID) || !identityPattern.MatchString(options.CallerID)) {
		return nil, fmt.Errorf("checkpoint qualification bindings are incomplete or invalid")
	}
	if !options.QualificationMode && options.Store != nil {
		return nil, fmt.Errorf("disabled checkpoint shadow cannot have a store")
	}
	service := &Service{options: options}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", service.handleLive)
	mux.HandleFunc("GET /health/ready", service.handleReady)
	mux.HandleFunc("GET /version", service.handleVersion)
	mux.HandleFunc("GET /metrics", service.handleMetrics)
	if options.QualificationMode {
		mux.Handle("POST /v1/shadow/workflow-control/checkpoints", service.requireIdentity(http.HandlerFunc(service.handleObserve)))
		mux.Handle("GET /v1/shadow/workflow-control/runs/", service.requireIdentity(http.HandlerFunc(service.handleReadHead)))
		mux.Handle("GET /v1/shadow/workflow-control/receipts/", service.requireIdentity(http.HandlerFunc(service.handleReadReceipt)))
	}
	service.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { service.requests.Add(1); mux.ServeHTTP(w, r) })
	return service, nil
}
func (s *Service) Handler() http.Handler { return s.handler }
func (s *Service) Run(ctx context.Context, bind string, shutdown time.Duration) error {
	server := &http.Server{Addr: bind, Handler: s.handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: readTimeout, WriteTimeout: writeTimeout, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	errors := make(chan error, 1)
	go func() { errors <- server.ListenAndServe() }()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdown)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-errors:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

func (s *Service) requireIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization := r.Header.Values("Authorization")
		workspace := r.Header.Values("X-OpenSlack-Workspace-ID")
		caller := r.Header.Values("X-OpenSlack-Caller-ID")
		valid := len(authorization) == 1 && strings.HasPrefix(authorization[0], "Bearer ") && len(workspace) == 1 && workspace[0] == s.options.WorkspaceID && len(caller) == 1 && caller[0] == s.options.CallerID
		if valid {
			digest := sha256.Sum256([]byte(strings.TrimPrefix(authorization[0], "Bearer ")))
			expected, _ := hex.DecodeString(s.options.BearerTokenSHA256)
			valid = subtle.ConstantTimeCompare(digest[:], expected) == 1
		}
		if !valid {
			s.unauthorized.Add(1)
			writeError(w, http.StatusUnauthorized, "WORKFLOW_CHECKPOINT_SHADOW_UNAUTHORIZED", "checkpoint shadow identity is invalid")
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (s *Service) handleObserve(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestDeadline)
	defer cancel()
	if r.Header.Get("Content-Type") != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "WORKFLOW_CHECKPOINT_SHADOW_CONTENT_TYPE", "content type must be application/json")
		return
	}
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 {
		writeError(w, http.StatusUnprocessableEntity, string(checkpointshadowstore.ErrorInputInvalid), "exactly one idempotency key is required")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, checkpointshadowstore.MaxRequestBytes))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, string(checkpointshadowstore.ErrorContentInvalid), "checkpoint body is too large")
		return
	}
	prepared, err := checkpointshadowstore.PrepareObservation(body)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if prepared.Envelope.Observation.Runner.WorkspaceID != s.options.WorkspaceID {
		writeError(w, http.StatusUnprocessableEntity, string(checkpointshadowstore.ErrorInputInvalid), "workspace binding is invalid")
		return
	}
	fingerprint := checkpointshadowstore.Fingerprint(http.MethodPost, "/v1/shadow/workflow-control/checkpoints", keys[0], body)
	receipt, err := s.options.Store.Observe(ctx, checkpointshadowstore.ObserveInput{Prepared: prepared, IdempotencyKey: keys[0], RequestFingerprint: fingerprint, ServiceBuildHash: s.options.BuildSHA})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if receipt.Replay {
		s.replays.Add(1)
		w.Header().Set("Idempotency-Replayed", "true")
	} else {
		s.accepts.Add(1)
	}
	if receipt.Value.Parity == "mismatched" && !receipt.Replay {
		s.mismatches.Add(1)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	status := http.StatusCreated
	if receipt.Value.Status == "reconciliation_required" {
		status = http.StatusAccepted
	}
	if receipt.Replay && receipt.Value.Status == "accepted" {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_, _ = w.Write(receipt.ExactBytes)
}
func (s *Service) handleReadHead(w http.ResponseWriter, r *http.Request) {
	prefix := "/v1/shadow/workflow-control/runs/"
	suffix := "/checkpoint-head"
	if !strings.HasPrefix(r.URL.Path, prefix) || !strings.HasSuffix(r.URL.Path, suffix) {
		http.NotFound(w, r)
		return
	}
	runID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, prefix), suffix)
	if runID == "" || strings.Contains(runID, "/") {
		http.NotFound(w, r)
		return
	}
	head, err := s.options.Store.ReadHead(r.Context(), s.options.WorkspaceID, runID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, head)
}
func (s *Service) handleReadReceipt(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimPrefix(r.URL.Path, "/v1/shadow/workflow-control/receipts/")
	if key == "" || strings.Contains(key, "/") {
		http.NotFound(w, r)
		return
	}
	receipt, err := s.options.Store.ReadReceipt(r.Context(), s.options.WorkspaceID, key)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(receipt.ExactBytes)
}
func (s *Service) handleLive(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}
func (s *Service) handleReady(w http.ResponseWriter, r *http.Request) {
	if s.options.QualificationMode {
		if err := s.options.Store.Ready(r.Context()); err != nil {
			writeError(w, http.StatusServiceUnavailable, "WORKFLOW_CHECKPOINT_SHADOW_NOT_READY", "checkpoint shadow repository is unavailable")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "qualificationMode": s.options.QualificationMode})
}
func (s *Service) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"buildSha": s.options.BuildSHA, "authority": "typescript", "goRole": "observer_only", "checkpointAuthority": false, "resumeAuthority": false, "qualificationMode": s.options.QualificationMode})
}
func (s *Service) handleMetrics(w http.ResponseWriter, r *http.Request) {
	stats := checkpointshadowstore.Statistics{}
	if s.options.QualificationMode {
		var err error
		stats, err = s.options.Store.Statistics(r.Context())
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "WORKFLOW_CHECKPOINT_SHADOW_METRICS_UNAVAILABLE", "checkpoint metrics are unavailable")
			return
		}
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = fmt.Fprintf(w, "# TYPE workflow_checkpoint_shadow_http_requests_total counter\nworkflow_checkpoint_shadow_http_requests_total %d\n# TYPE workflow_checkpoint_shadow_unauthorized_total counter\nworkflow_checkpoint_shadow_unauthorized_total %d\n# TYPE workflow_checkpoint_shadow_accepts_total counter\nworkflow_checkpoint_shadow_accepts_total %d\n# TYPE workflow_checkpoint_shadow_replays_total counter\nworkflow_checkpoint_shadow_replays_total %d\n# TYPE workflow_checkpoint_shadow_mismatches_total counter\nworkflow_checkpoint_shadow_mismatches_total %d\n# TYPE workflow_checkpoint_shadow_runs gauge\nworkflow_checkpoint_shadow_runs %d\n# TYPE workflow_checkpoint_shadow_observations gauge\nworkflow_checkpoint_shadow_observations %d\n# TYPE workflow_checkpoint_shadow_receipts gauge\nworkflow_checkpoint_shadow_receipts %d\n# TYPE workflow_checkpoint_shadow_reconciliation_pending gauge\nworkflow_checkpoint_shadow_reconciliation_pending %d\n", s.requests.Load(), s.unauthorized.Load(), s.accepts.Load(), s.replays.Load(), s.mismatches.Load(), stats.Runs, stats.Observations, stats.Receipts, stats.ReconciliationPending)
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"schema": "openslack.workflow_checkpoint_shadow_error.v1", "code": code, "message": message})
}
func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorInputInvalid), checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorContentInvalid):
		writeError(w, http.StatusUnprocessableEntity, errorCode(err), "checkpoint observation is invalid")
	case checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorConflict), checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorIdempotencyConflict):
		writeError(w, http.StatusConflict, errorCode(err), "checkpoint observation conflicts with stored state")
	case checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorNotFound):
		writeError(w, http.StatusNotFound, errorCode(err), "checkpoint record was not found")
	case checkpointshadowstore.IsCode(err, checkpointshadowstore.ErrorDatabase):
		writeError(w, http.StatusServiceUnavailable, errorCode(err), "checkpoint repository is unavailable")
	default:
		writeError(w, http.StatusInternalServerError, errorCode(err), "checkpoint shadow integrity or commit outcome is unknown")
	}
}
func errorCode(err error) string {
	var failure *checkpointshadowstore.Error
	if errors.As(err, &failure) {
		return string(failure.Code)
	}
	return "WORKFLOW_CHECKPOINT_SHADOW_INTERNAL"
}
