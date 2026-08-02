package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
)

const requestDeadline = 30 * time.Second

func (service *Service) handleObservation(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireNoQuery(w, request) {
		return
	}
	contentTypes := request.Header.Values("Content-Type")
	if len(contentTypes) != 1 || contentTypes[0] != "application/json" {
		writeFailure(w, http.StatusUnsupportedMediaType, "GOVERNANCE_SHADOW_UNPROCESSABLE", "Content-Type must be application/json")
		return
	}
	keys := request.Header.Values("Idempotency-Key")
	if len(keys) != 1 || shadowstore.ValidateIdempotencyKey(keys[0]) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_SHADOW_UNPROCESSABLE", "Idempotency-Key must be one bounded canonical value")
		return
	}
	body, err := readBoundedBody(w, request)
	if err != nil {
		if ctx.Err() != nil {
			writeFailure(w, http.StatusRequestTimeout, "GOVERNANCE_SHADOW_TIMEOUT", "governance shadow request deadline exceeded")
			return
		}
		writeFailure(w, http.StatusRequestEntityTooLarge, "GOVERNANCE_SHADOW_TOO_LARGE", "request exceeds the frozen service limit")
		return
	}
	prepared, err := shadowstore.PrepareObservation(body)
	if err != nil {
		writeMappedError(w, service, err)
		return
	}
	if err := shadowstore.ValidateObservationIdempotencyKey(prepared, keys[0]); err != nil {
		writeMappedError(w, service, err)
		return
	}
	fingerprint := shadowstore.RequestFingerprint(prepared)
	receipt, err := service.store.Observe(ctx, shadowstore.ObserveInput{IdempotencyKey: keys[0], RequestFingerprint: fingerprint, ExactBody: body})
	if err != nil {
		writeMappedError(w, service, err)
		return
	}
	if receipt.IdempotencyKey != keys[0] || receipt.RequestFingerprint != fingerprint || receipt.WorkspaceID != prepared.Source.WorkspaceID ||
		receipt.PlanID != prepared.Source.PlanID || receipt.SourceSequence != prepared.Source.SourceSequence || receipt.ObservationKind != prepared.Kind {
		service.logger.Error("governance_shadow_invalid_store_receipt")
		writeFailure(w, http.StatusInternalServerError, "GOVERNANCE_SHADOW_INTERNAL", "internal governance shadow failure")
		return
	}
	switch receipt.Status {
	case shadowstore.ReceiptAccepted:
		service.accepted.Add(1)
	case shadowstore.ReceiptDuplicate:
		service.duplicates.Add(1)
	}
	if receipt.Parity == shadowstore.ParityMismatched {
		service.mismatches.Add(1)
	}
	if ctx.Err() != nil {
		writeFailure(w, http.StatusRequestTimeout, "GOVERNANCE_SHADOW_TIMEOUT", "governance shadow request deadline exceeded")
		return
	}
	writeReceipt(w, receipt)
}

func (service *Service) handleProjection(w http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(w, request) {
		return
	}
	workspaceValues := request.Header.Values(HeaderWorkspaceID)
	if len(workspaceValues) != 1 || shadowstore.ValidateProjectionIdentity(workspaceValues[0], request.PathValue("planId")) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_SHADOW_UNPROCESSABLE", "workspace binding header is required")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()
	projection, err := service.store.Projection(ctx, workspaceValues[0], request.PathValue("planId"))
	if err != nil {
		writeMappedError(w, service, err)
		return
	}
	writeCanonical(w, http.StatusOK, projectionValue(projection))
}

func (service *Service) handleLive(w http.ResponseWriter, request *http.Request) {
	if requireNoQuery(w, request) {
		writeCanonical(w, http.StatusOK, canonicaljson.Object{"status": "live"})
	}
}

func (service *Service) handleReady(w http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(w, request) {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	if _, err := service.store.Statistics(ctx); err != nil {
		writeCanonical(w, http.StatusServiceUnavailable, canonicaljson.Object{"status": "not_ready"})
		return
	}
	if service.authorityEnabled {
		if _, err := service.authorityStore.Statistics(ctx); err != nil {
			writeCanonical(w, http.StatusServiceUnavailable, canonicaljson.Object{"status": "not_ready"})
			return
		}
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{"status": "ready"})
}

func (service *Service) handleVersion(w http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(w, request) {
		return
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{
		"schema": "openslack.governance_shadow_service_version.v1", "buildSha": service.buildSHA, "contractVersion": "v2", "authorityEnabled": service.authorityEnabled,
	})
}

func (service *Service) handleMetrics(w http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(w, request) {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	statistics, err := service.store.Statistics(ctx)
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("metrics unavailable\n"))
		return
	}
	body := strings.Join([]string{
		"# TYPE openslack_governance_shadow_http_requests_total counter",
		"openslack_governance_shadow_http_requests_total " + strconv.FormatInt(service.requests.Load(), 10),
		"# TYPE openslack_governance_shadow_observations_total gauge",
		`openslack_governance_shadow_observations_total{parity="matched"} ` + strconv.FormatInt(statistics.MatchedObservations, 10),
		`openslack_governance_shadow_observations_total{parity="mismatched"} ` + strconv.FormatInt(statistics.MismatchedObservations, 10),
		"# TYPE openslack_governance_shadow_reconciliation_pending gauge",
		"openslack_governance_shadow_reconciliation_pending " + strconv.FormatInt(statistics.ReconciliationPending, 10),
		"# TYPE openslack_governance_shadow_source_sequence_max gauge",
		"openslack_governance_shadow_source_sequence_max " + strconv.FormatInt(statistics.SourceSequenceMax, 10),
	}, "\n") + "\n"
	if service.authorityEnabled {
		authorityStatistics, authorityErr := service.authorityStore.Statistics(ctx)
		if authorityErr != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("metrics unavailable\n"))
			return
		}
		body += strings.Join([]string{
			"# TYPE openslack_governance_authority_plans gauge",
			"openslack_governance_authority_plans " + strconv.FormatInt(authorityStatistics.Plans, 10),
			"# TYPE openslack_governance_authority_outcomes_total counter",
			`openslack_governance_authority_outcomes_total{outcome="accepted"} ` + strconv.FormatInt(service.authorityAccepted.Load(), 10),
			`openslack_governance_authority_outcomes_total{outcome="duplicate"} ` + strconv.FormatInt(service.authorityDuplicates.Load(), 10),
			`openslack_governance_authority_outcomes_total{outcome="reconciliation_required"} ` + strconv.FormatInt(service.authorityReconciliation.Load(), 10),
			"# TYPE openslack_governance_authority_errors_total counter",
			`openslack_governance_authority_errors_total{code="conflict"} ` + strconv.FormatInt(service.authorityConflicts.Load(), 10),
			`openslack_governance_authority_errors_total{code="unavailable"} ` + strconv.FormatInt(service.authorityUnavailable.Load(), 10),
			`openslack_governance_authority_errors_total{code="commit_unknown"} ` + strconv.FormatInt(service.authorityCommitUnknown.Load(), 10),
			`openslack_governance_authority_errors_total{code="internal"} ` + strconv.FormatInt(service.authorityInternal.Load(), 10),
			"# TYPE openslack_governance_authority_reconciliation_pending gauge",
			"openslack_governance_authority_reconciliation_pending " + strconv.FormatInt(authorityStatistics.ReconciliationPending, 10),
			"# TYPE openslack_governance_authority_audit_pending gauge",
			"openslack_governance_authority_audit_pending " + strconv.FormatInt(authorityStatistics.AuditPending, 10),
		}, "\n") + "\n"
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
}

func readBoundedBody(w http.ResponseWriter, request *http.Request) ([]byte, error) {
	request.Body = http.MaxBytesReader(w, request.Body, shadowstore.MaxObservationBytes)
	body, err := io.ReadAll(&contextReader{ctx: request.Context(), reader: request.Body})
	if err != nil {
		return nil, err
	}
	if len(body) == 0 || len(body) > shadowstore.MaxObservationBytes {
		return nil, fmt.Errorf("body size invalid")
	}
	return body, nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextReader) Read(destination []byte) (int, error) {
	select {
	case <-reader.ctx.Done():
		return 0, reader.ctx.Err()
	default:
		return reader.reader.Read(destination)
	}
}

func requireNoQuery(w http.ResponseWriter, request *http.Request) bool {
	if request.URL.RawQuery == "" {
		return true
	}
	writeFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_SHADOW_UNPROCESSABLE", "query parameters are not accepted")
	return false
}

func writeMappedError(w http.ResponseWriter, service *Service, err error) {
	var failure *shadowstore.Error
	if errors.As(err, &failure) {
		switch failure.Code {
		case shadowstore.ErrorInputInvalid, shadowstore.ErrorContentInvalid:
			writeFailure(w, http.StatusUnprocessableEntity, "GOVERNANCE_SHADOW_UNPROCESSABLE", "governance shadow observation is invalid")
		case shadowstore.ErrorSequenceConflict, shadowstore.ErrorIdempotencyConflict:
			service.conflicts.Add(1)
			writeFailure(w, http.StatusConflict, "GOVERNANCE_SHADOW_CONFLICT", "governance shadow precondition conflicted")
		case shadowstore.ErrorNotFound:
			writeFailure(w, http.StatusNotFound, "GOVERNANCE_SHADOW_NOT_FOUND", "governance shadow projection was not found")
		case shadowstore.ErrorDatabase:
			writeFailure(w, http.StatusServiceUnavailable, "GOVERNANCE_SHADOW_UNAVAILABLE", "governance shadow store is unavailable")
		default:
			service.logger.Error("governance_shadow_unmapped_store_failure", "code", failure.Code)
			writeFailure(w, http.StatusInternalServerError, "GOVERNANCE_SHADOW_INTERNAL", "internal governance shadow failure")
		}
		return
	}
	service.logger.Error("governance_shadow_unmapped_failure")
	writeFailure(w, http.StatusInternalServerError, "GOVERNANCE_SHADOW_INTERNAL", "internal governance shadow failure")
}

func writeReceipt(w http.ResponseWriter, receipt shadowstore.Receipt) {
	value := canonicaljson.Object{
		"schema": receipt.Schema, "operation": receipt.Operation, "status": string(receipt.Status), "parity": string(receipt.Parity),
		"idempotencyKey": receipt.IdempotencyKey, "requestFingerprint": receipt.RequestFingerprint,
		"workspaceId": receipt.WorkspaceID, "planId": receipt.PlanID, "sourceSequence": float64(receipt.SourceSequence),
		"observationKind": string(receipt.ObservationKind), "observationDigest": receipt.ObservationDigest,
	}
	if receipt.MismatchCode != "" {
		value["mismatchCode"] = receipt.MismatchCode
	}
	if receipt.CommittedAt != nil {
		value["committedAt"] = receipt.CommittedAt.UTC().Format(time.RFC3339Nano)
	}
	if receipt.ReconciliationToken != nil {
		value["reconciliationToken"] = *receipt.ReconciliationToken
	}
	status := http.StatusCreated
	if receipt.Status == shadowstore.ReceiptDuplicate {
		status = http.StatusOK
	}
	if receipt.Status == shadowstore.ReceiptReconciliationRequired {
		status = http.StatusAccepted
	}
	writeCanonical(w, status, value)
}

func projectionValue(value shadowstore.Projection) canonicaljson.Object {
	return canonicaljson.Object{
		"schema": value.Schema, "authority": value.Authority, "shadow": value.Shadow, "parity": string(value.Parity),
		"workspaceId": value.WorkspaceID, "planId": value.PlanID, "sourceSequence": float64(value.SourceSequence),
		"matchedRecordRevision": float64(value.MatchedRecordRevision), "record": readModelValue(value.ReadModel),
		"observations": canonicaljson.Object{"matched": float64(value.MatchedObservations), "mismatched": float64(value.MismatchedObservations)},
		"confirmation": canonicaljson.Object{"matched": float64(value.ConfirmationMatched), "mismatched": float64(value.ConfirmationMismatched)},
		"audit":        canonicaljson.Object{"matched": float64(value.AuditMatched), "mismatched": float64(value.AuditMismatched)},
	}
}

func readModelValue(value governance.ReadModel) canonicaljson.Object {
	result := canonicaljson.Object{
		"schema": value.Schema, "planId": value.PlanID, "revision": float64(value.Revision), "state": string(value.State), "kind": value.Kind,
		"goal": value.Goal, "actorId": value.ActorID, "workspaceId": value.WorkspaceID, "correlationId": value.CorrelationID,
		"createdAt": value.CreatedAt, "updatedAt": value.UpdatedAt, "expiresAt": value.ExpiresAt,
		"actionCount": float64(value.ActionCount), "effectCount": float64(value.EffectCount), "inputHash": value.InputHash, "planHash": value.PlanHash,
		"confirmationBound": value.ConfirmationBound, "executionTerminal": value.ExecutionTerminal, "final": value.Final,
		"reconciliationRequired": value.ReconciliationRequired,
	}
	if value.Execution != nil {
		execution := canonicaljson.Object{"executionId": value.Execution.ExecutionID, "startedAt": value.Execution.StartedAt,
			"outcomeCount": float64(value.Execution.OutcomeCount), "evidenceRefCount": float64(value.Execution.EvidenceRefCount)}
		if value.Execution.CompletedAt != "" {
			execution["completedAt"] = value.Execution.CompletedAt
		}
		if value.Execution.Blocker != "" {
			execution["blocker"] = value.Execution.Blocker
		}
		if value.Execution.Failure != "" {
			execution["failure"] = value.Execution.Failure
		}
		result["execution"] = execution
	}
	return result
}

func writeFailure(w http.ResponseWriter, status int, code, message string) {
	writeCanonical(w, status, canonicaljson.Object{"schema": "openslack.governance_shadow_error.v1", "code": code, "message": message})
}

func writeCanonical(w http.ResponseWriter, status int, value canonicaljson.Object) {
	body, err := canonicaljson.Encode(value)
	if err != nil || len(body) > MaxResponseBodyBytes {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}

func bodyDigest(body []byte) string { sum := sha256.Sum256(body); return hex.EncodeToString(sum[:]) }
