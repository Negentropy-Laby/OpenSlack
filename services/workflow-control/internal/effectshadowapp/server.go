// Package effectshadowapp exposes the default-off GS9-D observation API.
package effectshadowapp

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
	"mime"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/effectshadowstore"
)

const requestDeadline = 30 * time.Second
const readTimeout = 30 * time.Second
const writeTimeout = 45 * time.Second

type Options struct {
	QualificationMode                                  bool
	BuildSHA, BearerTokenSHA256, WorkspaceID, CallerID string
	Store                                              effectshadowstore.Store
	Logger                                             *slog.Logger
}
type Service struct {
	options                                              Options
	handler                                              http.Handler
	workspaceDigest, callerDigest, bearerDigest          [sha256.Size]byte
	requests, unauthorized, accepts, replays, mismatches atomic.Int64
}

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var identityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)

func New(options Options) (*Service, error) {
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.QualificationMode && (options.Store == nil || !hashPattern.MatchString(options.BuildSHA) || !hashPattern.MatchString(options.BearerTokenSHA256) || !identityPattern.MatchString(options.WorkspaceID) || !identityPattern.MatchString(options.CallerID)) {
		return nil, fmt.Errorf("effect qualification bindings are incomplete or invalid")
	}
	if !options.QualificationMode && options.Store != nil {
		return nil, fmt.Errorf("disabled effect shadow cannot have a store")
	}
	service := &Service{options: options}
	service.workspaceDigest = sha256.Sum256([]byte(options.WorkspaceID))
	service.callerDigest = sha256.Sum256([]byte(options.CallerID))
	if options.QualificationMode {
		expected, _ := hex.DecodeString(options.BearerTokenSHA256)
		copy(service.bearerDigest[:], expected)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", service.handleLive)
	mux.HandleFunc("GET /health/ready", service.handleReady)
	mux.HandleFunc("GET /version", service.handleVersion)
	mux.HandleFunc("GET /metrics", service.handleMetrics)
	if options.QualificationMode {
		mux.Handle("POST "+effectshadowstore.Route, service.requireIdentity(http.HandlerFunc(service.handleObserve)))
		mux.Handle("POST "+effectshadowstore.ReconciliationResolveRoutePrefix+"{token}"+effectshadowstore.ReconciliationResolveRouteSuffix, service.requireIdentity(http.HandlerFunc(service.handleResolveReconciliation)))
		mux.Handle("GET /v1/shadow/workflow-control/runs/{runId}/occurrences/{occurrenceId}/approvals/{approvalId}/head", service.requireIdentity(http.HandlerFunc(service.handleReadHead)))
		mux.Handle("GET /v1/shadow/workflow-control/receipts/{idempotencyKey}", service.requireIdentity(http.HandlerFunc(service.handleReadReceipt)))
		mux.Handle("GET "+effectshadowstore.OutboxRoute, service.requireIdentity(http.HandlerFunc(service.handleReadOutbox)))
	}
	service.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { service.requests.Add(1); mux.ServeHTTP(w, r) })
	return service, nil
}
func (s *Service) Handler() http.Handler { return s.handler }
func (s *Service) Run(ctx context.Context, bind string, shutdown time.Duration) error {
	server := &http.Server{Addr: bind, Handler: s.handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: readTimeout, WriteTimeout: writeTimeout, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	listener, err := net.Listen("tcp", bind)
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdown)
		defer cancel()
		shutdownErr := server.Shutdown(shutdownCtx)
		if shutdownErr != nil {
			// A timed-out graceful shutdown does not necessarily unblock Serve.
			// Close the listener/connections before draining the serve result.
			shutdownErr = errors.Join(shutdownErr, server.Close())
		}
		serveErr := <-done
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		return errors.Join(shutdownErr, serveErr)
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
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
		valid := len(authorization) == 1 && strings.HasPrefix(authorization[0], "Bearer ") && len(workspace) == 1 && constantTimeDigest(workspace[0], s.workspaceDigest) && len(caller) == 1 && constantTimeDigest(caller[0], s.callerDigest)
		if valid {
			digest := sha256.Sum256([]byte(strings.TrimPrefix(authorization[0], "Bearer ")))
			valid = subtle.ConstantTimeCompare(digest[:], s.bearerDigest[:]) == 1
		}
		if !valid {
			s.unauthorized.Add(1)
			writeError(w, http.StatusUnauthorized, "WORKFLOW_EFFECT_SHADOW_UNAUTHORIZED", "effect shadow identity is invalid")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func constantTimeDigest(actual string, expected [sha256.Size]byte) bool {
	digest := sha256.Sum256([]byte(actual))
	return subtle.ConstantTimeCompare(digest[:], expected[:]) == 1
}
func (s *Service) handleObserve(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestDeadline)
	defer cancel()
	input, ok := s.prepareObserveInput(ctx, w, r)
	if !ok {
		return
	}
	receipt, err := s.options.Store.Observe(ctx, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.writeReceipt(w, receipt)
}

func (s *Service) prepareObserveInput(ctx context.Context, w http.ResponseWriter, r *http.Request) (effectshadowstore.ObserveInput, bool) {
	mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaErr != nil || !strings.EqualFold(mediaType, "application/json") {
		writeError(w, http.StatusUnsupportedMediaType, "WORKFLOW_EFFECT_SHADOW_CONTENT_TYPE", "content type must be application/json")
		return effectshadowstore.ObserveInput{}, false
	}
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 {
		writeError(w, http.StatusUnprocessableEntity, string(effectshadowstore.ErrorInputInvalid), "exactly one idempotency key is required")
		return effectshadowstore.ObserveInput{}, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, effectshadowstore.MaxRequestBytes))
	if err != nil {
		var maxBytes *http.MaxBytesError
		switch {
		case errors.As(err, &maxBytes):
			writeError(w, http.StatusRequestEntityTooLarge, string(effectshadowstore.ErrorContentInvalid), "effect body is too large")
		case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled), ctx.Err() != nil:
			writeError(w, http.StatusRequestTimeout, "WORKFLOW_EFFECT_SHADOW_REQUEST_TIMEOUT", "effect request body timed out")
		default:
			writeError(w, http.StatusBadRequest, "WORKFLOW_EFFECT_SHADOW_REQUEST_READ_FAILED", "effect request body could not be read")
		}
		return effectshadowstore.ObserveInput{}, false
	}
	prepared, err := effectshadowstore.PrepareObservation(body)
	if err != nil {
		writeStoreError(w, err)
		return effectshadowstore.ObserveInput{}, false
	}
	if !effectshadowstore.IdempotencyKeyMatchesEnvelope(keys[0], prepared.EnvelopeHash) {
		writeError(w, http.StatusUnprocessableEntity, string(effectshadowstore.ErrorInputInvalid), "idempotency key does not bind the exact effect envelope")
		return effectshadowstore.ObserveInput{}, false
	}
	if !constantTimeDigest(prepared.Envelope.Observation.WorkspaceID, s.workspaceDigest) {
		writeError(w, http.StatusUnprocessableEntity, string(effectshadowstore.ErrorInputInvalid), "workspace binding is invalid")
		return effectshadowstore.ObserveInput{}, false
	}
	fingerprint := effectshadowstore.Fingerprint(http.MethodPost, effectshadowstore.Route, keys[0], body)
	return effectshadowstore.ObserveInput{Prepared: prepared, IdempotencyKey: keys[0], RequestFingerprint: fingerprint, ServiceBuildHash: s.options.BuildSHA}, true
}

func (s *Service) handleResolveReconciliation(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), requestDeadline)
	defer cancel()
	token := r.PathValue("token")
	if !effectshadowstore.ValidReconciliationToken(token) {
		writeError(w, http.StatusNotFound, string(effectshadowstore.ErrorNotFound), "effect reconciliation was not found")
		return
	}
	input, ok := s.prepareObserveInput(ctx, w, r)
	if !ok {
		return
	}
	receipt, err := s.options.Store.ResolveReconciliation(ctx, effectshadowstore.ResolveInput{ReconciliationToken: token, ObserveInput: input})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.writeReceipt(w, receipt)
}

func (s *Service) writeReceipt(w http.ResponseWriter, receipt effectshadowstore.Receipt) {
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
	runID := r.PathValue("runId")
	occurrenceID := r.PathValue("occurrenceId")
	approvalID := r.PathValue("approvalId")
	if !identityPattern.MatchString(runID) || !effectshadowstore.ValidOccurrenceID(occurrenceID) || !identityPattern.MatchString(approvalID) {
		writeError(w, http.StatusNotFound, string(effectshadowstore.ErrorNotFound), "effect record was not found")
		return
	}
	head, err := s.options.Store.ReadHead(r.Context(), s.options.WorkspaceID, runID, occurrenceID, approvalID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, head)
}
func (s *Service) handleReadReceipt(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("idempotencyKey")
	if !effectshadowstore.ValidIdempotencyKey(key) {
		writeError(w, http.StatusNotFound, string(effectshadowstore.ErrorNotFound), "effect record was not found")
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
func (s *Service) handleReadOutbox(w http.ResponseWriter, r *http.Request) {
	limit := effectshadowstore.MaxOutboxReadLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > effectshadowstore.MaxOutboxReadLimit {
			writeError(w, http.StatusUnprocessableEntity, string(effectshadowstore.ErrorInputInvalid), "effect outbox limit is invalid")
			return
		}
		limit = value
	}
	page, err := s.options.Store.ReadPendingOutbox(r.Context(), s.options.WorkspaceID, limit, r.URL.Query().Get("cursor"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if page.Items == nil {
		page.Items = []effectshadowstore.OutboxRead{}
		page.Count = 0
	}
	writeJSON(w, http.StatusOK, page)
}
func (s *Service) handleLive(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}
func (s *Service) handleReady(w http.ResponseWriter, r *http.Request) {
	if s.options.QualificationMode {
		if err := s.options.Store.Ready(r.Context()); err != nil {
			writeError(w, http.StatusServiceUnavailable, "WORKFLOW_EFFECT_SHADOW_NOT_READY", "effect shadow repository is unavailable")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "qualificationMode": s.options.QualificationMode})
}
func (s *Service) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"buildSha": s.options.BuildSHA, "authority": "typescript", "goRole": "observer_only", "nonAuthorizingObservation": true, "goEffectDecisionAuthority": false, "goEffectExecutionAuthority": false, "qualificationMode": s.options.QualificationMode})
}
func (s *Service) handleMetrics(w http.ResponseWriter, r *http.Request) {
	stats := effectshadowstore.Statistics{}
	if s.options.QualificationMode {
		var err error
		stats, err = s.options.Store.Statistics(r.Context())
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "WORKFLOW_EFFECT_SHADOW_METRICS_UNAVAILABLE", "effect metrics are unavailable")
			return
		}
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = fmt.Fprintf(w, "# TYPE workflow_effect_shadow_http_requests_total counter\nworkflow_effect_shadow_http_requests_total %d\n# TYPE workflow_effect_shadow_unauthorized_total counter\nworkflow_effect_shadow_unauthorized_total %d\n# TYPE workflow_effect_shadow_accepts_total counter\nworkflow_effect_shadow_accepts_total %d\n# TYPE workflow_effect_shadow_replays_total counter\nworkflow_effect_shadow_replays_total %d\n# TYPE workflow_effect_shadow_mismatches_total counter\nworkflow_effect_shadow_mismatches_total %d\n# TYPE workflow_effect_shadow_heads gauge\nworkflow_effect_shadow_heads %d\n# TYPE workflow_effect_shadow_observations gauge\nworkflow_effect_shadow_observations %d\n# TYPE workflow_effect_shadow_receipts gauge\nworkflow_effect_shadow_receipts %d\n# TYPE workflow_effect_shadow_outbox_pending gauge\nworkflow_effect_shadow_outbox_pending %d\n# TYPE workflow_effect_shadow_reconciliation_pending gauge\nworkflow_effect_shadow_reconciliation_pending %d\n", s.requests.Load(), s.unauthorized.Load(), s.accepts.Load(), s.replays.Load(), s.mismatches.Load(), stats.Heads, stats.Observations, stats.Receipts, stats.OutboxPending, stats.ReconciliationPending)
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"schema": "openslack.workflow_effect_shadow_error.v1", "code": code, "message": message})
}
func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case effectshadowstore.IsCode(err, effectshadowstore.ErrorInputInvalid), effectshadowstore.IsCode(err, effectshadowstore.ErrorContentInvalid):
		writeError(w, http.StatusUnprocessableEntity, errorCode(err), "effect observation is invalid")
	case effectshadowstore.IsCode(err, effectshadowstore.ErrorConflict), effectshadowstore.IsCode(err, effectshadowstore.ErrorIdempotencyConflict):
		writeError(w, http.StatusConflict, errorCode(err), "effect observation conflicts with stored state")
	case effectshadowstore.IsCode(err, effectshadowstore.ErrorNotFound):
		writeError(w, http.StatusNotFound, errorCode(err), "effect record was not found")
	case effectshadowstore.IsCode(err, effectshadowstore.ErrorDatabase):
		writeError(w, http.StatusServiceUnavailable, errorCode(err), "effect repository is unavailable")
	default:
		writeError(w, http.StatusInternalServerError, errorCode(err), "effect shadow integrity or commit outcome is unknown")
	}
}
func errorCode(err error) string {
	var failure *effectshadowstore.Error
	if errors.As(err, &failure) {
		return string(failure.Code)
	}
	return "WORKFLOW_EFFECT_SHADOW_INTERNAL"
}
