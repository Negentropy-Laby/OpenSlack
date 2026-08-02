package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/canonicaljson"
)

const (
	RouteAuthorityAccept       = "/v1/governance/plans:accept"
	RouteAuthorityRead         = "/v1/governance/plans/{planId}"
	RouteAuthorityReceipt      = "/v1/governance/receipts/{idempotencyKey}"
	RouteAuthorityAudit        = "/v1/governance/plans/{planId}/authority-events/{acceptedRevision}:record"
	RouteAuthorityPendingAudit = "/v1/governance/plans/{planId}/authority-events/{acceptedRevision}:pending"
)

var transitionRoutes = map[string]authoritystore.Operation{
	"/v1/governance/plans/{planId}:claim-execution":        authoritystore.OperationClaimExecution,
	"/v1/governance/plans/{planId}:complete-execution":     authoritystore.OperationCompleteExecution,
	"/v1/governance/plans/{planId}:cancel":                 authoritystore.OperationCancel,
	"/v1/governance/plans/{planId}:expire":                 authoritystore.OperationExpire,
	"/v1/governance/plans/{planId}:require-reconciliation": authoritystore.OperationRequireReconciliation,
}

type authorityHeaders struct {
	callerID, workspaceID, routingEpoch, expectedBuild string
	epochValue                                         int64
}

func (service *Service) registerAuthorityRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST "+RouteAuthorityAccept, func(w http.ResponseWriter, request *http.Request) {
		service.handleAuthorityMutation(w, request, authoritystore.OperationAccept, "")
	})
	mux.HandleFunc("POST /v1/governance/plans/{planAction}", service.handleAuthorityTransition)
	mux.HandleFunc("GET "+RouteAuthorityRead, service.handleAuthorityRead)
	mux.HandleFunc("GET "+RouteAuthorityReceipt, service.handleAuthorityReceiptRead)
	mux.HandleFunc("POST /v1/governance/plans/{planId}/authority-events/{revisionAction}", service.handleAuthorityAuditRoute)
	mux.HandleFunc("GET /v1/governance/plans/{planId}/authority-events/{revisionAction}", service.handleAuthorityPendingAuditRoute)
}

func (service *Service) handleAuthorityPendingAuditRoute(w http.ResponseWriter, request *http.Request) {
	revisionAction := request.PathValue("revisionAction")
	if !strings.HasSuffix(revisionAction, ":pending") {
		writeAuthorityFailure(w, http.StatusNotFound, "GOVERNANCE_AUTHORITY_NOT_FOUND", "governance authority pending audit route was not found")
		return
	}
	if !requireAuthorityReadEnvelope(w, request) {
		return
	}
	headers, ok := service.readAuthorityBindingHeaders(w, request)
	if !ok {
		return
	}
	revisionText := strings.TrimSuffix(revisionAction, ":pending")
	revision, err := strconv.ParseInt(revisionText, 10, 64)
	if err != nil || strconv.FormatInt(revision, 10) != revisionText {
		writeAuthorityFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_AUTHORITY_UNPROCESSABLE", "pending authority audit revision is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()
	pending, err := service.authorityStore.ReadPendingAudit(ctx, headers.workspaceID, request.PathValue("planId"), revision)
	if err != nil {
		writeAuthorityMappedError(w, service, err)
		return
	}
	if pending.Route.RoutingEpoch != headers.epochValue || pending.ServiceBuildSHA != service.buildSHA {
		writeAuthorityFailure(w, http.StatusConflict, "GOVERNANCE_AUTHORITY_CONFLICT", "pending audit route or build does not match the active authority binding")
		return
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{
		"schema": pending.Schema, "status": pending.Status, "workspaceId": pending.WorkspaceID,
		"planId": pending.PlanID, "revision": float64(pending.Revision), "operation": string(pending.Operation),
		"route": routeValue(pending.Route), "recordHash": pending.RecordHash, "serviceBuildSha": pending.ServiceBuildSHA,
	})
}

func (service *Service) handleAuthorityTransition(w http.ResponseWriter, request *http.Request) {
	planAction := request.PathValue("planAction")
	separator := strings.LastIndexByte(planAction, ':')
	if separator <= 0 {
		writeAuthorityFailure(w, http.StatusNotFound, "GOVERNANCE_AUTHORITY_NOT_FOUND", "governance authority transition route was not found")
		return
	}
	planID, action := planAction[:separator], planAction[separator+1:]
	operation, ok := transitionRoutes["/v1/governance/plans/{planId}:"+action]
	if !ok {
		writeAuthorityFailure(w, http.StatusNotFound, "GOVERNANCE_AUTHORITY_NOT_FOUND", "governance authority transition route was not found")
		return
	}
	service.handleAuthorityMutation(w, request, operation, planID)
}

func (service *Service) handleAuthorityMutation(w http.ResponseWriter, request *http.Request, operation authoritystore.Operation, pathPlanID string) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireAuthorityNoQuery(w, request) {
		return
	}
	headers, key, ok := service.readAuthorityHeaders(w, request, true)
	if !ok {
		return
	}
	body, err := readAuthorityBody(w, request)
	if err != nil {
		if ctx.Err() != nil {
			writeAuthorityFailure(w, http.StatusRequestTimeout, "GOVERNANCE_AUTHORITY_TIMEOUT", "governance authority request deadline exceeded")
		} else {
			writeAuthorityFailure(w, http.StatusRequestEntityTooLarge, "GOVERNANCE_AUTHORITY_TOO_LARGE", "request exceeds the authority service limit")
		}
		return
	}
	prepared, err := authoritystore.PrepareRequest(body, headers.callerID, headers.workspaceID, headers.routingEpoch, headers.expectedBuild)
	if err != nil {
		writeAuthorityMappedError(w, service, err)
		return
	}
	if prepared.Operation != operation || (operation != authoritystore.OperationAccept && prepared.PlanID != pathPlanID) {
		writeAuthorityFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_AUTHORITY_UNPROCESSABLE", "request operation or plan path does not match the canonical body")
		return
	}
	if operation == authoritystore.OperationAccept && (!service.authorityAcceptNewRecords || headers.epochValue != service.authorityRoutingEpoch) {
		writeAuthorityFailure(w, http.StatusConflict, "GOVERNANCE_AUTHORITY_ACCEPT_DISABLED", "new Go authority records are disabled for this epoch")
		return
	}
	fingerprint := authoritystore.RequestFingerprint(request.Method, request.URL.Path, prepared)
	receipt, err := service.authorityStore.Mutate(ctx, authoritystore.MutateInput{
		Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint, ServiceBuildSHA: service.buildSHA,
	})
	if err != nil {
		writeAuthorityMappedError(w, service, err)
		return
	}
	switch receipt.Status {
	case authoritystore.ReceiptAccepted:
		service.authorityAccepted.Add(1)
	case authoritystore.ReceiptDuplicate:
		service.authorityDuplicates.Add(1)
	case authoritystore.ReceiptReconciliationRequired:
		service.authorityReconciliation.Add(1)
	}
	writeAuthorityReceipt(w, receipt)
}

func (service *Service) handleAuthorityRead(w http.ResponseWriter, request *http.Request) {
	if !requireAuthorityReadEnvelope(w, request) {
		return
	}
	headers, ok := service.readAuthorityBindingHeaders(w, request)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()
	result, err := service.authorityStore.Read(ctx, headers.workspaceID, request.PathValue("planId"))
	if err != nil {
		writeAuthorityMappedError(w, service, err)
		return
	}
	if result.Route.RoutingEpoch != headers.epochValue {
		writeAuthorityFailure(w, http.StatusConflict, "GOVERNANCE_AUTHORITY_CONFLICT", "persisted route does not match the active authority epoch")
		return
	}
	record, err := canonicalValue(result.RecordBytes)
	if err != nil {
		writeAuthorityFailure(w, http.StatusInternalServerError, "GOVERNANCE_AUTHORITY_INTERNAL", "stored authority record is invalid")
		return
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{
		"schema": result.Schema, "workspaceId": result.WorkspaceID, "planId": result.PlanID,
		"route": routeValue(result.Route), "recordHash": result.RecordHash, "record": record,
		"serviceBuildSha": service.buildSHA,
	})
}

func (service *Service) handleAuthorityReceiptRead(w http.ResponseWriter, request *http.Request) {
	if !requireAuthorityReadEnvelope(w, request) {
		return
	}
	headers, ok := service.readAuthorityBindingHeaders(w, request)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()
	receipt, err := service.authorityStore.ReadReceipt(ctx, headers.workspaceID, request.PathValue("idempotencyKey"))
	if err != nil {
		writeAuthorityMappedError(w, service, err)
		return
	}
	if receipt.Route.RoutingEpoch != headers.epochValue {
		writeAuthorityFailure(w, http.StatusConflict, "GOVERNANCE_AUTHORITY_CONFLICT", "receipt route does not match the active authority epoch")
		return
	}
	writeAuthorityReceiptWithStatus(w, http.StatusOK, receipt)
}

func (service *Service) handleAuthorityAuditRoute(w http.ResponseWriter, request *http.Request) {
	revisionAction := request.PathValue("revisionAction")
	if !strings.HasSuffix(revisionAction, ":record") {
		writeAuthorityFailure(w, http.StatusNotFound, "GOVERNANCE_AUTHORITY_NOT_FOUND", "governance authority audit route was not found")
		return
	}
	service.handleAuthorityAudit(w, request, strings.TrimSuffix(revisionAction, ":record"))
}

func (service *Service) handleAuthorityAudit(w http.ResponseWriter, request *http.Request, acceptedRevision string) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireAuthorityNoQuery(w, request) {
		return
	}
	headers, key, ok := service.readAuthorityHeaders(w, request, false)
	if !ok {
		return
	}
	body, err := readAuthorityBody(w, request)
	if err != nil {
		if ctx.Err() != nil {
			writeAuthorityFailure(w, http.StatusRequestTimeout, "GOVERNANCE_AUTHORITY_TIMEOUT", "governance authority audit deadline exceeded")
		} else {
			writeAuthorityFailure(w, http.StatusRequestEntityTooLarge, "GOVERNANCE_AUTHORITY_TOO_LARGE", "audit request exceeds the authority service limit")
		}
		return
	}
	prepared, err := authoritystore.PrepareAudit(body, headers.callerID, headers.workspaceID,
		request.PathValue("planId"), acceptedRevision, headers.routingEpoch, headers.expectedBuild)
	if err != nil {
		writeAuthorityMappedError(w, service, err)
		return
	}
	fingerprint := authoritystore.AuditRequestFingerprint(request.Method, request.URL.Path, prepared)
	receipt, err := service.authorityStore.RecordAudit(ctx, authoritystore.AuditInput{
		Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint, ServiceBuildSHA: service.buildSHA,
	})
	if err != nil {
		writeAuthorityMappedError(w, service, err)
		return
	}
	status := http.StatusCreated
	if receipt.Status == "duplicate" {
		status = http.StatusOK
	}
	writeCanonical(w, status, canonicaljson.Object{
		"schema": receipt.Schema, "status": receipt.Status, "workspaceId": receipt.WorkspaceID,
		"planId": receipt.PlanID, "revision": float64(receipt.Revision), "eventId": receipt.EventID,
		"eventHash": receipt.EventHash, "idempotencyKey": receipt.IdempotencyKey,
		"requestFingerprint": receipt.RequestFingerprint, "recordedAt": canonicalTimestamp(receipt.RecordedAt),
	})
}

func (service *Service) readAuthorityHeaders(w http.ResponseWriter, request *http.Request, mutation bool) (authorityHeaders, string, bool) {
	contentType, contentOK := oneHeader(request, "Content-Type")
	key, keyOK := oneHeader(request, "Idempotency-Key")
	headers, bindingsOK := service.readAuthorityBindingHeaders(w, request)
	if !contentOK || contentType != "application/json" {
		writeAuthorityFailure(w, http.StatusUnsupportedMediaType, "GOVERNANCE_AUTHORITY_UNPROCESSABLE", "Content-Type must be one application/json value")
		return authorityHeaders{}, "", false
	}
	var keyErr error
	if mutation {
		keyErr = authoritystore.ValidateIdempotencyKey(key)
	} else {
		keyErr = authoritystore.ValidateAuditIdempotencyKey(key)
	}
	if !keyOK || !bindingsOK || keyErr != nil {
		writeAuthorityFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_AUTHORITY_UNPROCESSABLE", "authority request headers are missing or invalid")
		return authorityHeaders{}, "", false
	}
	return headers, key, true
}

func (service *Service) readAuthorityBindingHeaders(w http.ResponseWriter, request *http.Request) (authorityHeaders, bool) {
	caller, callerOK := oneHeader(request, HeaderGovernanceCallerID)
	workspace, workspaceOK := oneHeader(request, HeaderGovernanceWorkspaceID)
	epoch, epochOK := oneHeader(request, HeaderGovernanceRoutingEpoch)
	build, buildOK := oneHeader(request, HeaderGovernanceExpectedBuild)
	epochValue, epochErr := strconv.ParseInt(epoch, 10, 64)
	_, epochAllowed := service.authorityAllowedEpochs[epochValue]
	if !callerOK || !workspaceOK || !epochOK || !buildOK || caller != service.authorityCallerID ||
		workspace != service.authorityWorkspaceID || epochErr != nil || strconv.FormatInt(epochValue, 10) != epoch || !epochAllowed || build != service.buildSHA {
		writeAuthorityFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_AUTHORITY_UNPROCESSABLE", "authority request headers do not match the exact host binding")
		return authorityHeaders{}, false
	}
	return authorityHeaders{callerID: caller, workspaceID: workspace, routingEpoch: epoch, expectedBuild: build, epochValue: epochValue}, true
}

func oneHeader(request *http.Request, name string) (string, bool) {
	values := request.Header.Values(name)
	returnValue := ""
	if len(values) == 1 {
		returnValue = values[0]
	}
	return returnValue, len(values) == 1 && returnValue != ""
}

func readAuthorityBody(w http.ResponseWriter, request *http.Request) ([]byte, error) {
	request.Body = http.MaxBytesReader(w, request.Body, authoritystore.MaxRequestBytes)
	body, err := io.ReadAll(&contextReader{ctx: request.Context(), reader: request.Body})
	if err != nil || len(body) == 0 || len(body) > authoritystore.MaxRequestBytes {
		if err == nil {
			err = errors.New("authority body size invalid")
		}
		return nil, err
	}
	return body, nil
}

func requireAuthorityNoQuery(w http.ResponseWriter, request *http.Request) bool {
	if request.URL.RawQuery == "" {
		return true
	}
	writeAuthorityFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_AUTHORITY_UNPROCESSABLE", "query parameters are not accepted")
	return false
}

func requireAuthorityReadEnvelope(w http.ResponseWriter, request *http.Request) bool {
	if !requireAuthorityNoQuery(w, request) {
		return false
	}
	if request.ContentLength == 0 && len(request.TransferEncoding) == 0 {
		return true
	}
	writeAuthorityFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_AUTHORITY_UNPROCESSABLE", "request body is not accepted")
	return false
}

func writeAuthorityMappedError(w http.ResponseWriter, service *Service, err error) {
	var failure *authoritystore.Error
	if errors.As(err, &failure) {
		switch failure.Code {
		case authoritystore.ErrorInputInvalid, authoritystore.ErrorContentInvalid:
			writeAuthorityFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_AUTHORITY_UNPROCESSABLE", "governance authority request is invalid")
		case authoritystore.ErrorConflict, authoritystore.ErrorIdempotencyConflict:
			service.conflicts.Add(1)
			service.authorityConflicts.Add(1)
			writeAuthorityFailure(w, http.StatusConflict, "GOVERNANCE_AUTHORITY_CONFLICT", "governance authority precondition conflicted")
		case authoritystore.ErrorNotFound:
			writeAuthorityFailure(w, http.StatusNotFound, "GOVERNANCE_AUTHORITY_NOT_FOUND", "governance authority record was not found")
		case authoritystore.ErrorDatabase:
			service.authorityUnavailable.Add(1)
			service.logger.Warn("governance_authority_store_unavailable", "code", failure.Code)
			writeAuthorityFailure(w, http.StatusServiceUnavailable, "GOVERNANCE_AUTHORITY_UNAVAILABLE", "governance authority store is unavailable")
		case authoritystore.ErrorCommitUnknown:
			service.authorityCommitUnknown.Add(1)
			service.logger.Error("governance_authority_commit_outcome_unknown", "code", failure.Code)
			writeAuthorityFailure(w, http.StatusInternalServerError, "GOVERNANCE_AUTHORITY_COMMIT_UNKNOWN", "authority outcome is unknown; reconcile using the same key")
		default:
			service.authorityInternal.Add(1)
			service.logger.Error("governance_authority_unmapped_store_failure", "code", failure.Code)
			writeAuthorityFailure(w, http.StatusInternalServerError, "GOVERNANCE_AUTHORITY_INTERNAL", "internal governance authority failure")
		}
		return
	}
	service.authorityInternal.Add(1)
	service.logger.Error("governance_authority_unmapped_failure")
	writeAuthorityFailure(w, http.StatusInternalServerError, "GOVERNANCE_AUTHORITY_INTERNAL", "internal governance authority failure")
}

func writeAuthorityReceipt(w http.ResponseWriter, receipt authoritystore.Receipt) {
	status := http.StatusCreated
	if receipt.Status == authoritystore.ReceiptDuplicate {
		status = http.StatusOK
	} else if receipt.Status == authoritystore.ReceiptReconciliationRequired {
		status = http.StatusAccepted
	}
	writeAuthorityReceiptWithStatus(w, status, receipt)
}

func writeAuthorityReceiptWithStatus(w http.ResponseWriter, status int, receipt authoritystore.Receipt) {
	value := canonicaljson.Object{
		"schema": receipt.Schema, "operation": string(receipt.Operation), "status": string(receipt.Status),
		"workspaceId": receipt.WorkspaceID, "planId": receipt.PlanID, "expectedRevision": float64(receipt.ExpectedRevision),
		"route": routeValue(receipt.Route), "idempotencyKey": receipt.IdempotencyKey,
		"requestFingerprint": receipt.RequestFingerprint, "recordHash": receipt.RecordHash,
		"correlationId": receipt.CorrelationID, "callerId": receipt.CallerID, "serviceBuildSha": receipt.ServiceBuildSHA,
	}
	if receipt.AcceptedRevision != nil {
		value["acceptedRevision"] = float64(*receipt.AcceptedRevision)
		value["state"] = string(receipt.State)
		record, err := canonicalValue(receipt.RecordBytes)
		if err != nil || receipt.CommittedAt == nil {
			writeAuthorityFailure(w, http.StatusInternalServerError, "GOVERNANCE_AUTHORITY_INTERNAL", "stored authority receipt is invalid")
			return
		}
		value["record"] = record
		value["committedAt"] = canonicalTimestamp(*receipt.CommittedAt)
	} else {
		value["targetRevision"] = float64(*receipt.TargetRevision)
		value["targetState"] = string(receipt.TargetState)
		value["reconciliationToken"] = receipt.ReconciliationToken
	}
	if receipt.ExecutionID != "" {
		value["executionId"] = receipt.ExecutionID
	}
	writeCanonical(w, status, value)
}

func routeValue(route authoritystore.Route) canonicaljson.Object {
	return canonicaljson.Object{"backend": route.Backend, "authority": route.Authority, "routingEpoch": float64(route.RoutingEpoch)}
}

func canonicalValue(body []byte) (canonicaljson.Value, error) {
	return canonicaljson.Parse(body, canonicaljson.Limits{MaxDepth: governance.MaxDepth + 2, MaxNodes: governance.MaxNodes + 32, MaxStringLength: governance.MaxStringBytes})
}

func canonicalTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func writeAuthorityFailure(w http.ResponseWriter, status int, code, message string) {
	writeCanonical(w, status, canonicaljson.Object{"schema": "openslack.governance_authority_error.v1", "code": code, "message": message})
}

func parseRevision(value string) (int64, error) { return strconv.ParseInt(value, 10, 64) }
