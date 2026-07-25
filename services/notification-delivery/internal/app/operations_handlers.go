package app

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"rc_wsman/internal/calleraccess"
	"rc_wsman/internal/notificationstore"
	"rc_wsman/internal/operationscontrol"
)

func (s *Server) handleOpsOutbox(w http.ResponseWriter, r *http.Request) {
	op, ok := s.authenticateOps(w, r, "operator_read")
	if !ok {
		return
	}
	if err := validateQueryKeys(r, "vendor_id"); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid query", requestID(r))
		return
	}
	filter, err := parseOpsVendorFilter(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid query", requestID(r))
		return
	}
	result, err := s.deps.Operations.QueryOutbox(r.Context(), op, filter)
	if err != nil {
		writeOpsError(w, r, err)
		return
	}
	writeSuccess(w, http.StatusOK, requestID(r), result)
}

func (s *Server) handleOpsNotification(w http.ResponseWriter, r *http.Request) {
	op, ok := s.authenticateOps(w, r, "operator_read")
	if !ok {
		return
	}
	if err := validateQueryKeys(r); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid query", requestID(r))
		return
	}
	result, err := s.deps.Operations.QueryNotification(r.Context(), op, chi.URLParam(r, "notification_id"))
	if err != nil {
		writeOpsError(w, r, err)
		return
	}
	writeSuccess(w, http.StatusOK, requestID(r), result)
}

func (s *Server) handleOpsDead(w http.ResponseWriter, r *http.Request) {
	op, ok := s.authenticateOps(w, r, "operator_read")
	if !ok {
		return
	}
	if err := validateQueryKeys(r, "vendor_id", "cursor", "limit"); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid query", requestID(r))
		return
	}
	filter, err := parseOpsVendorFilter(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid query", requestID(r))
		return
	}
	limit, err := parseListLimit(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid limit", requestID(r))
		return
	}
	result, err := s.deps.Operations.ListDead(r.Context(), op, filter, limit, r.URL.Query().Get("cursor"))
	if err != nil {
		writeOpsError(w, r, err)
		return
	}
	writeSuccess(w, http.StatusOK, requestID(r), result)
}

func (s *Server) handleOpsAttempts(w http.ResponseWriter, r *http.Request) {
	op, ok := s.authenticateOps(w, r, "operator_read")
	if !ok {
		return
	}
	if err := validateQueryKeys(r, "cursor", "limit"); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid query", requestID(r))
		return
	}
	limit, err := parseListLimit(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid limit", requestID(r))
		return
	}
	result, err := s.deps.Operations.ListAttemptHistory(r.Context(), op, chi.URLParam(r, "notification_id"), limit, r.URL.Query().Get("cursor"))
	if err != nil {
		writeOpsError(w, r, err)
		return
	}
	writeSuccess(w, http.StatusOK, requestID(r), result)
}

func (s *Server) handleOpsReplayPreview(w http.ResponseWriter, r *http.Request) {
	op, ok := s.authenticateOps(w, r, "operator_read")
	if !ok {
		return
	}
	if err := validateQueryKeys(r); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid query", requestID(r))
		return
	}
	var body struct {
		NotificationIDs []string `json:"notification_ids"`
		Justification   string   `json:"justification"`
	}
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid request body", requestID(r))
		return
	}
	items, err := s.deps.Operations.PreviewReplay(r.Context(), op, body.NotificationIDs, body.Justification)
	if err != nil {
		writeOpsError(w, r, err)
		return
	}
	writeSuccess(w, http.StatusOK, requestID(r), map[string]any{"items": items})
}

func (s *Server) handleOpsReplayExecute(w http.ResponseWriter, r *http.Request) {
	op, ok := s.authenticateOps(w, r, "operator_mutation")
	if !ok {
		return
	}
	if err := validateQueryKeys(r); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid query", requestID(r))
		return
	}
	var body struct {
		Items         []operationscontrol.ReplayExecuteInput `json:"items"`
		Justification string                                 `json:"justification"`
	}
	if err := decodeStrictJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid request body", requestID(r))
		return
	}
	result, err := s.deps.Operations.ExecuteReplay(r.Context(), op, body.Items, body.Justification)
	if err != nil {
		writeOpsError(w, r, err)
		return
	}
	writeSuccess(w, http.StatusOK, requestID(r), result)
}

func (s *Server) authenticateOps(w http.ResponseWriter, r *http.Request, rateClass string) (calleraccess.OperatorPrincipal, bool) {
	if s.deps.Operations == nil {
		writeError(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "operations unavailable", requestID(r))
		return calleraccess.OperatorPrincipal{}, false
	}
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		writeError(w, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication failed", requestID(r))
		return calleraccess.OperatorPrincipal{}, false
	}
	op, err := s.deps.Authenticator.AuthenticateOperator(r.Context(), authHeader)
	if err != nil {
		writeAuthenticationError(w, r, err)
		return calleraccess.OperatorPrincipal{}, false
	}
	if !s.enforceOperatorRateLimit(w, r, op.PrincipalID, rateClass) {
		return calleraccess.OperatorPrincipal{}, false
	}
	return op, true
}

func parseOpsVendorFilter(r *http.Request) ([]string, error) {
	values, ok := r.URL.Query()["vendor_id"]
	if !ok {
		return nil, nil
	}
	if len(values) != 1 || values[0] == "" {
		return nil, errors.New("vendor_id must be singular")
	}
	return []string{values[0]}, nil
}

func writeOpsError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case calleraccess.IsRejection(err, calleraccess.RejectionForbidden), notificationstore.IsRejection(err, notificationstore.RejectionForbiddenAction):
		writeError(w, http.StatusForbidden, "FORBIDDEN", "operation forbidden", requestID(r))
	case notificationstore.IsRejection(err, notificationstore.RejectionNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "notification not found", requestID(r))
	case operationscontrol.IsRejection(err, operationscontrol.RejectionInvalidRequest), notificationstore.IsRejection(err, notificationstore.RejectionInvalidPageLimit), notificationstore.IsRejection(err, notificationstore.RejectionInvalidCursor):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "invalid request", requestID(r))
	default:
		writeError(w, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE", "operation unavailable", requestID(r))
	}
}
