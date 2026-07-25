package app

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"rc_wsman/internal/calleraccess"
	"rc_wsman/internal/notificationstore"
	"rc_wsman/internal/vendorregistry"
)

type errorResponse struct {
	RequestID string `json:"request_id"`
	Error     struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type successResponse struct {
	RequestID string `json:"request_id"`
	Data      any    `json:"data"`
}

const maxJSONRequestBytes int64 = 1 << 20

var (
	errUnsupportedJSON = errors.New("content type must be application/json")
	errJSONTooLarge    = errors.New("request body too large")
)

func writeError(w http.ResponseWriter, status int, code, message, requestID string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	resp := errorResponse{}
	resp.RequestID = requestID
	resp.Error.Code = code
	resp.Error.Message = message
	_ = json.NewEncoder(w).Encode(resp)
}

func writeSuccess(w http.ResponseWriter, status int, requestID string, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(successResponse{RequestID: requestID, Data: data})
}

func decodeStrictJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return errUnsupportedJSON
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONRequestBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return errJSONTooLarge
		}
		return fmt.Errorf("decode json: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("request body must contain one JSON value")
	}
	return nil
}

func requestID(r *http.Request) string {
	return middleware.GetReqID(r.Context())
}

func toVRActorContext(a calleraccess.AttenuatedContext) vendorregistry.ActorContext {
	return vendorregistry.ActorContext{
		Kind:         a.Kind,
		ActorID:      a.ActorID,
		VendorScope:  vendorregistry.VendorScope{Kind: "vendor_ids", VendorIDs: a.VendorScope},
		Capabilities: a.Capabilities,
	}
}

func toVRAdminActorContext(a calleraccess.AttenuatedContext, operation string) vendorregistry.ActorContext {
	actor := vendorregistry.ActorContext{Kind: a.Kind, ActorID: a.ActorID, Capabilities: a.Capabilities}
	if operation == vendorregistry.OpRegister {
		actor.VendorScope = vendorregistry.VendorScope{Kind: "owning_scopes", OwningScopes: []string{a.OwningScope}}
	} else {
		actor.VendorScope = vendorregistry.VendorScope{Kind: "vendor_ids", VendorIDs: a.VendorScope}
	}
	return actor
}

func (s *Server) handleSubmitNotification(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "missing or invalid Bearer token", requestID(r))
		return
	}
	cp, err := s.deps.Authenticator.AuthenticateCaller(r.Context(), authHeader)
	if err != nil {
		writeAuthenticationError(w, r, err)
		return
	}
	if !cp.HasCapability(calleraccess.CapabilitySubmitNotification) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "missing capability", requestID(r))
		return
	}

	idempotencyKey := r.Header.Get("Idempotency-Key")
	if err := notificationstore.ValidateIdempotencyKey(idempotencyKey); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "missing or invalid Idempotency-Key", requestID(r))
		return
	}

	var body struct {
		VendorID      *string `json:"vendor_id"`
		PayloadBase64 *string `json:"payload_base64"`
	}
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid request body", requestID(r))
		return
	}
	if body.VendorID == nil || body.PayloadBase64 == nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "missing required request field", requestID(r))
		return
	}

	if err := cp.AuthorizeVendor(*body.VendorID); err != nil {
		writeError(w, http.StatusNotFound, "VENDOR_UNAVAILABLE", "vendor unavailable", requestID(r))
		return
	}

	if retryAfter, err := s.deps.Authenticator.ApplyRateLimit(cp.PrincipalID, "caller"); err != nil {
		w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())))
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "rate limit exceeded", requestID(r))
		return
	}

	actor := toVRActorContext(cp.NewIngressContext())
	active, err := s.deps.VendorRegistry.IsVendorActive(r.Context(), actor, *body.VendorID)
	if err != nil {
		writeError(w, http.StatusNotFound, "VENDOR_UNAVAILABLE", "vendor unavailable", requestID(r))
		return
	}
	if !active {
		writeError(w, http.StatusNotFound, "VENDOR_UNAVAILABLE", "vendor unavailable", requestID(r))
		return
	}

	payload, err := base64.StdEncoding.DecodeString(*body.PayloadBase64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "payload_base64 invalid", requestID(r))
		return
	}
	if len(payload) > notificationstore.PayloadMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "payload exceeds maximum size", requestID(r))
		return
	}

	intake := notificationstore.ValidatedIntake{
		CallerID:       cp.PrincipalID,
		VendorID:       *body.VendorID,
		Payload:        payload,
		IdempotencyKey: idempotencyKey,
	}

	result, err := s.deps.Store.Intake(r.Context(), intake)
	if err != nil {
		if notificationstore.IsRejection(err, notificationstore.RejectionIdempotencyConflict) {
			writeError(w, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "idempotency key conflict", requestID(r))
			return
		}
		writeError(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "intake unavailable", requestID(r))
		return
	}

	w.Header().Set("X-Notification-Service-Deployment-Digest", s.deploymentDigest)
	writeSuccess(w, http.StatusAccepted, requestID(r), map[string]any{
		"notification_id":   result.NotificationID,
		"state":             notificationstore.StatePending,
		"accepted_at":       result.AcceptedAt.UTC().Format(time.RFC3339Nano),
		"idempotent_replay": result.IdempotentReplay,
	})
}

type adminCommandBody struct {
	Operation              string          `json:"operation"`
	VendorID               string          `json:"vendor_id"`
	ExpectedRecordRevision *int64          `json:"expected_record_revision"`
	IdempotencyKey         string          `json:"idempotency_key"`
	Body                   *map[string]any `json:"body"`
}

func (s *Server) handleVendorAdminCommand(w http.ResponseWriter, r *http.Request) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "missing or invalid Bearer token", requestID(r))
		return
	}

	op, err := s.deps.Authenticator.AuthenticateOperator(r.Context(), authHeader)
	if err != nil {
		writeAuthenticationError(w, r, err)
		return
	}

	var req adminCommandBody
	if err := decodeStrictJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_COMMAND", "invalid request body", requestID(r))
		return
	}
	if req.ExpectedRecordRevision == nil || req.Body == nil {
		writeError(w, http.StatusBadRequest, "INVALID_COMMAND", "missing required command field", requestID(r))
		return
	}
	if !s.enforceOperatorRateLimit(w, r, op.PrincipalID, "operator_mutation") {
		return
	}

	actor := toVRAdminActorContext(op.NewVRAdminContext(), req.Operation)
	cmd := vendorregistry.AdminCommand{
		Operation:              req.Operation,
		VendorID:               req.VendorID,
		ExpectedRecordRevision: *req.ExpectedRecordRevision,
		IdempotencyKey:         req.IdempotencyKey,
		Body:                   *req.Body,
	}
	result, err := s.deps.VendorRegistry.ExecuteCommand(r.Context(), actor, cmd)
	if err != nil {
		status, code := mapVendorAdminError(err)
		writeError(w, status, code, "command failed", requestID(r))
		return
	}

	writeSuccess(w, http.StatusOK, requestID(r), result)
}

func (s *Server) handleListVendors(w http.ResponseWriter, r *http.Request) {
	actor, err := s.authenticateReadActor(r)
	if err != nil {
		writeAuthenticationError(w, r, err)
		return
	}
	if !actor.HasCapability(vendorregistry.CapabilityRead) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "missing capability", requestID(r))
		return
	}
	if !s.enforceOperatorRateLimit(w, r, actor.ActorID, "operator_read") {
		return
	}
	if err := validateQueryKeys(r, "scope_filter[kind]", "scope_filter[vendor_ids]", "scope_filter[owning_scopes]", "cursor", "limit"); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_COMMAND", "invalid query", requestID(r))
		return
	}

	filter, err := parseScopeFilter(r)
	if err != nil {
		writeError(w, http.StatusForbidden, "FORBIDDEN_SCOPE_FILTER", "invalid scope filter", requestID(r))
		return
	}

	limit, err := parseListLimit(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_PAGE_LIMIT", "invalid page limit", requestID(r))
		return
	}
	page, err := s.deps.VendorRegistry.ListVendors(r.Context(), actor, filter, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		status, code := mapVendorReadError(err)
		writeError(w, status, code, "list failed", requestID(r))
		return
	}

	writeSuccess(w, http.StatusOK, requestID(r), map[string]any{
		"items":       page.Items,
		"next_cursor": page.NextCursor,
	})
}

func (s *Server) handleDescribeVendor(w http.ResponseWriter, r *http.Request) {
	actor, err := s.authenticateReadActor(r)
	if err != nil {
		writeAuthenticationError(w, r, err)
		return
	}
	if !actor.HasCapability(vendorregistry.CapabilityRead) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "missing capability", requestID(r))
		return
	}
	if !s.enforceOperatorRateLimit(w, r, actor.ActorID, "operator_read") {
		return
	}
	if err := validateQueryKeys(r); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_COMMAND", "invalid query", requestID(r))
		return
	}

	vendorID := chi.URLParam(r, "vendor_id")
	summary, err := s.deps.VendorRegistry.DescribeVendorState(r.Context(), actor, vendorID)
	if err != nil {
		status, code := mapVendorReadError(err)
		writeError(w, status, code, "describe failed", requestID(r))
		return
	}

	writeSuccess(w, http.StatusOK, requestID(r), summary)
}

func (s *Server) handleListEndpointVersions(w http.ResponseWriter, r *http.Request) {
	actor, err := s.authenticateReadActor(r)
	if err != nil {
		writeAuthenticationError(w, r, err)
		return
	}
	if !actor.HasCapability(vendorregistry.CapabilityReadHistory) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "missing capability", requestID(r))
		return
	}
	if !s.enforceOperatorRateLimit(w, r, actor.ActorID, "operator_read") {
		return
	}
	if err := validateQueryKeys(r, "cursor", "limit"); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_COMMAND", "invalid query", requestID(r))
		return
	}

	vendorID := chi.URLParam(r, "vendor_id")
	limit, err := parseListLimit(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_PAGE_LIMIT", "invalid page limit", requestID(r))
		return
	}
	page, snapshotCap, err := s.deps.VendorRegistry.ListEndpointVersions(r.Context(), actor, vendorID, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		status, code := mapVendorReadError(err)
		writeError(w, status, code, "list versions failed", requestID(r))
		return
	}

	writeSuccess(w, http.StatusOK, requestID(r), map[string]any{
		"items":                       page.Items,
		"next_cursor":                 page.NextCursor,
		"snapshot_max_config_version": snapshotCap,
	})
}

func (s *Server) handleListAdminAuditEvents(w http.ResponseWriter, r *http.Request) {
	actor, err := s.authenticateReadActor(r)
	if err != nil {
		writeAuthenticationError(w, r, err)
		return
	}
	if !actor.HasCapability(vendorregistry.CapabilityReadAudit) {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "missing capability", requestID(r))
		return
	}
	if !s.enforceOperatorRateLimit(w, r, actor.ActorID, "operator_read") {
		return
	}
	if err := validateQueryKeys(r, "scope_filter[kind]", "scope_filter[vendor_ids]", "scope_filter[owning_scopes]", "cursor", "limit"); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_COMMAND", "invalid query", requestID(r))
		return
	}

	filter, err := parseScopeFilter(r)
	if err != nil {
		writeError(w, http.StatusForbidden, "FORBIDDEN_SCOPE_FILTER", "invalid scope filter", requestID(r))
		return
	}

	limit, err := parseListLimit(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_PAGE_LIMIT", "invalid page limit", requestID(r))
		return
	}
	page, err := s.deps.VendorRegistry.ListAdminAuditEvents(r.Context(), actor, filter, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		status, code := mapVendorReadError(err)
		writeError(w, status, code, "list audit events failed", requestID(r))
		return
	}

	writeSuccess(w, http.StatusOK, requestID(r), map[string]any{
		"items":                  page.Items,
		"next_cursor":            page.NextCursor,
		"snapshot_max_audit_seq": page.SnapshotMaxSeq,
	})
}

func (s *Server) authenticateReadActor(r *http.Request) (vendorregistry.ActorContext, error) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		return vendorregistry.ActorContext{}, errors.New("missing bearer")
	}
	op, err := s.deps.Authenticator.AuthenticateOperator(r.Context(), authHeader)
	if err != nil {
		return vendorregistry.ActorContext{}, err
	}
	return toVRActorContext(op.NewVRAdminContext()), nil
}

func writeAuthenticationError(w http.ResponseWriter, r *http.Request, err error) {
	if calleraccess.IsRejection(err, calleraccess.RejectionAuthorityUnavailable) {
		writeError(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "authentication unavailable", requestID(r))
		return
	}
	writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication failed", requestID(r))
}

func (s *Server) enforceOperatorRateLimit(w http.ResponseWriter, r *http.Request, principalID, operationClass string) bool {
	retryAfter, err := s.deps.Authenticator.ApplyRateLimit(principalID, operationClass)
	if err == nil {
		return true
	}
	w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retryAfter.Seconds()))))
	writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "rate limit exceeded", requestID(r))
	return false
}

func parseListLimit(r *http.Request) (int, error) {
	values, present := r.URL.Query()["limit"]
	if !present {
		return 0, nil
	}
	if len(values) != 1 || values[0] == "" {
		return 0, errors.New("limit must be a single integer")
	}
	return strconv.Atoi(values[0])
}

func validateQueryKeys(r *http.Request, allowed ...string) error {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	for key, values := range r.URL.Query() {
		_, allowed := allowedSet[key]
		arrayValue := key == "scope_filter[vendor_ids]" || key == "scope_filter[owning_scopes]"
		if !allowed || len(values) == 0 || (!arrayValue && len(values) != 1) {
			return errors.New("query parameters do not match closed schema")
		}
	}
	return nil
}

func parseScopeFilter(r *http.Request) (vendorregistry.ScopeFilter, error) {
	query := r.URL.Query()
	kindValues, kindPresent := query["scope_filter[kind]"]
	if !kindPresent {
		if _, ok := query["scope_filter[vendor_ids]"]; ok {
			return vendorregistry.ScopeFilter{}, errors.New("vendor_ids requires scope_kind")
		}
		if _, ok := query["scope_filter[owning_scopes]"]; ok {
			return vendorregistry.ScopeFilter{}, errors.New("owning_scopes requires scope_kind")
		}
		return vendorregistry.ScopeFilter{}, nil
	}
	if len(kindValues) != 1 || kindValues[0] == "" {
		return vendorregistry.ScopeFilter{}, errors.New("scope_kind invalid")
	}
	switch kindValues[0] {
	case "vendor_ids":
		values, ok := query["scope_filter[vendor_ids]"]
		values = splitQueryList(values)
		if !ok || len(values) == 0 {
			return vendorregistry.ScopeFilter{}, errors.New("vendor_ids invalid")
		}
		if _, exists := query["scope_filter[owning_scopes]"]; exists {
			return vendorregistry.ScopeFilter{}, errors.New("scope filter union conflict")
		}
		return vendorregistry.ScopeFilter{Kind: "vendor_ids", VendorIDs: values}, nil
	case "owning_scopes":
		values, ok := query["scope_filter[owning_scopes]"]
		values = splitQueryList(values)
		if !ok || len(values) == 0 {
			return vendorregistry.ScopeFilter{}, errors.New("owning_scopes invalid")
		}
		if _, exists := query["scope_filter[vendor_ids]"]; exists {
			return vendorregistry.ScopeFilter{}, errors.New("scope filter union conflict")
		}
		return vendorregistry.ScopeFilter{Kind: "owning_scopes", OwningScopes: values}, nil
	default:
		return vendorregistry.ScopeFilter{}, errors.New("scope_kind invalid")
	}
}

func splitQueryList(values []string) []string {
	var out []string
	for _, value := range values {
		for _, item := range strings.Split(value, ",") {
			if item == "" {
				return nil
			}
			out = append(out, item)
		}
	}
	return out
}

func mapVendorAdminError(err error) (int, string) {
	if vendorregistry.IsAdminCommandError(err, "INVALID_ACTOR_CONTEXT") ||
		vendorregistry.IsAdminCommandError(err, "INVALID_COMMAND") ||
		vendorregistry.IsAdminCommandError(err, "INVALID_ENDPOINT_POLICY") ||
		vendorregistry.IsAdminCommandError(err, "INVALID_CREDENTIAL_REF") {
		return http.StatusBadRequest, adminErrorCode(err)
	}
	if vendorregistry.IsAdminCommandError(err, "FORBIDDEN") {
		return http.StatusForbidden, "FORBIDDEN"
	}
	if vendorregistry.IsAdminCommandError(err, "VENDOR_NOT_FOUND") {
		return http.StatusNotFound, "VENDOR_NOT_FOUND"
	}
	if vendorregistry.IsAdminCommandError(err, "VENDOR_ID_UNAVAILABLE") ||
		vendorregistry.IsAdminCommandError(err, "EXPECTED_VERSION_MISMATCH") ||
		vendorregistry.IsAdminCommandError(err, "INVALID_TRANSITION") ||
		vendorregistry.IsAdminCommandError(err, "VENDOR_DISABLED_UPDATE_FORBIDDEN") ||
		vendorregistry.IsAdminCommandError(err, "IDEMPOTENCY_CONFLICT") {
		return http.StatusConflict, adminErrorCode(err)
	}
	if vendorregistry.IsAdminCommandError(err, "COMMIT_ROLLED_BACK") ||
		vendorregistry.IsAdminCommandError(err, "COMMIT_OUTCOME_UNKNOWN") {
		return http.StatusServiceUnavailable, adminErrorCode(err)
	}
	return http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE"
}

func mapVendorReadError(err error) (int, string) {
	if vendorregistry.IsReadError(err, "INVALID_ACTOR_CONTEXT") ||
		vendorregistry.IsReadError(err, "INVALID_COMMAND") ||
		vendorregistry.IsReadError(err, "INVALID_CURSOR") ||
		vendorregistry.IsReadError(err, "INVALID_PAGE_LIMIT") {
		return http.StatusBadRequest, readErrorCode(err)
	}
	if vendorregistry.IsReadError(err, "FORBIDDEN") ||
		vendorregistry.IsReadError(err, "FORBIDDEN_SCOPE_FILTER") {
		return http.StatusForbidden, readErrorCode(err)
	}
	if vendorregistry.IsReadError(err, "VENDOR_NOT_FOUND") ||
		vendorregistry.IsReadError(err, "VERSION_NOT_FOUND") {
		return http.StatusNotFound, readErrorCode(err)
	}
	if vendorregistry.IsReadError(err, "VENDOR_INACTIVE_OR_UNKNOWN") {
		return http.StatusNotFound, "VENDOR_UNAVAILABLE"
	}
	return http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE"
}

func adminErrorCode(err error) string {
	var e vendorregistry.AdminCommandError
	if errors.As(err, &e) {
		return e.Code
	}
	return "SERVICE_UNAVAILABLE"
}

func readErrorCode(err error) string {
	var e vendorregistry.ReadError
	if errors.As(err, &e) {
		return e.Code
	}
	return "SERVICE_UNAVAILABLE"
}
