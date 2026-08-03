package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/shadowstore"
)

const requestDeadline = 30 * time.Second

var receiptCodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,255}$`)

func (service *Service) handleObservation(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireNoQuery(w, request) {
		return
	}
	contentTypes := request.Header.Values("Content-Type")
	if len(contentTypes) != 1 || contentTypes[0] != "application/json" {
		writeFailure(w, http.StatusUnsupportedMediaType, "WORKFLOW_CONTROL_SHADOW_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json")
		return
	}
	keys := request.Header.Values("Idempotency-Key")
	if len(keys) != 1 || shadowstore.ValidateIdempotencyKey(keys[0]) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_SHADOW_UNPROCESSABLE", "Idempotency-Key must be one bounded canonical value")
		return
	}
	body, err := readBoundedBody(w, request)
	if err != nil {
		if ctx.Err() != nil {
			writeFailure(w, http.StatusRequestTimeout, "WORKFLOW_CONTROL_SHADOW_TIMEOUT", "workflow-control shadow request deadline exceeded")
			return
		}
		writeFailure(w, http.StatusRequestEntityTooLarge, "WORKFLOW_CONTROL_SHADOW_TOO_LARGE", "request exceeds the frozen service limit")
		return
	}
	prepared, err := shadowstore.PrepareObservation(body)
	if err != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_SHADOW_UNPROCESSABLE", "workflow-control shadow observation is invalid")
		return
	}
	if err := shadowstore.ValidateObservationIdempotencyKey(prepared, keys[0]); err != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_SHADOW_UNPROCESSABLE", "Idempotency-Key does not bind the exact body")
		return
	}
	fingerprint := shadowstore.RequestFingerprint(prepared)
	receipt, err := service.store.Observe(ctx, shadowstore.ObserveInput{
		IdempotencyKey: keys[0], RequestFingerprint: fingerprint, ExactBody: body,
	})
	if err != nil {
		writeMappedError(w, service, err)
		return
	}
	if !validReceiptBinding(receipt, prepared, keys[0], fingerprint) {
		service.logger.Error("workflow_control_shadow_invalid_store_receipt")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_SHADOW_INTERNAL", "internal workflow-control shadow failure")
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
		writeFailure(w, http.StatusRequestTimeout, "WORKFLOW_CONTROL_SHADOW_TIMEOUT", "workflow-control shadow request deadline exceeded")
		return
	}
	writeReceipt(w, receipt)
}

func (service *Service) handleProjection(w http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(w, request) {
		return
	}
	workspaces := request.Header.Values(HeaderWorkspaceID)
	if len(workspaces) != 1 || shadowstore.ValidateProjectionIdentity(workspaces[0], request.PathValue("runId")) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_SHADOW_UNPROCESSABLE", "workspace binding header is required")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 5*time.Second)
	defer cancel()
	projection, err := service.store.Projection(ctx, workspaces[0], request.PathValue("runId"))
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
	writeCanonical(w, http.StatusOK, canonicaljson.Object{"status": "ready"})
}

func (service *Service) handleVersion(w http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(w, request) {
		return
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{
		"authority": "typescript", "buildSha": service.buildSHA,
		"contractVersion": "v1", "mode": "shadow-only",
		"schema": "openslack.workflow_control_shadow_service_version.v1",
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
		"# TYPE openslack_workflow_control_shadow_http_requests_total counter",
		"openslack_workflow_control_shadow_http_requests_total " + strconv.FormatInt(service.requests.Load(), 10),
		"# TYPE openslack_workflow_control_shadow_runs gauge",
		"openslack_workflow_control_shadow_runs " + strconv.FormatInt(statistics.Runs, 10),
		"# TYPE openslack_workflow_control_shadow_observations_total gauge",
		`openslack_workflow_control_shadow_observations_total{parity="matched"} ` + strconv.FormatInt(statistics.MatchedObservations, 10),
		`openslack_workflow_control_shadow_observations_total{parity="mismatched"} ` + strconv.FormatInt(statistics.MismatchedObservations, 10),
		"# TYPE openslack_workflow_control_shadow_reconciliation_pending gauge",
		"openslack_workflow_control_shadow_reconciliation_pending " + strconv.FormatInt(statistics.ReconciliationPending, 10),
		"# TYPE openslack_workflow_control_shadow_source_sequence_max gauge",
		"openslack_workflow_control_shadow_source_sequence_max " + strconv.FormatInt(statistics.SourceSequenceMax, 10),
	}, "\n") + "\n"
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
	writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_SHADOW_UNPROCESSABLE", "query parameters are not accepted")
	return false
}

func writeMappedError(w http.ResponseWriter, service *Service, err error) {
	var failure *shadowstore.Error
	if errors.As(err, &failure) {
		switch failure.Code {
		case shadowstore.ErrorInputInvalid:
			writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_SHADOW_UNPROCESSABLE", "workflow-control shadow request is invalid")
		case shadowstore.ErrorSequenceConflict, shadowstore.ErrorIdempotencyConflict:
			service.conflicts.Add(1)
			writeFailure(w, http.StatusConflict, "WORKFLOW_CONTROL_SHADOW_CONFLICT", "workflow-control shadow precondition conflicted")
		case shadowstore.ErrorNotFound:
			writeFailure(w, http.StatusNotFound, "WORKFLOW_CONTROL_SHADOW_NOT_FOUND", "workflow-control shadow projection was not found")
		case shadowstore.ErrorDatabase, shadowstore.ErrorCommitUnknown:
			writeFailure(w, http.StatusServiceUnavailable, "WORKFLOW_CONTROL_SHADOW_UNAVAILABLE", "workflow-control shadow store is unavailable")
		case shadowstore.ErrorContentInvalid:
			service.logger.Error("workflow_control_shadow_stored_content_invalid", "code", failure.Code)
			writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_SHADOW_INTERNAL", "internal workflow-control shadow failure")
		default:
			service.logger.Error("workflow_control_shadow_unmapped_store_failure", "code", failure.Code)
			writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_SHADOW_INTERNAL", "internal workflow-control shadow failure")
		}
		return
	}
	service.logger.Error("workflow_control_shadow_unmapped_failure")
	writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_SHADOW_INTERNAL", "internal workflow-control shadow failure")
}

func validReceiptBinding(receipt shadowstore.Receipt, prepared shadowstore.PreparedObservation, key, fingerprint string) bool {
	source := prepared.Envelope.Source
	if receipt.Schema != shadowstore.ReceiptSchema || receipt.Operation != "observation_ingest" ||
		receipt.IdempotencyKey != key || receipt.RequestFingerprint != fingerprint ||
		receipt.WorkspaceID != source.WorkspaceID || receipt.RunID != source.RunID ||
		receipt.SourceSequence != source.SourceSequence || receipt.ObservationDigest != shadowstore.DigestString(prepared.BodyDigest) {
		return false
	}
	switch receipt.Status {
	case shadowstore.ReceiptAccepted, shadowstore.ReceiptDuplicate:
		if receipt.CommittedAt == nil || receipt.ReconciliationToken != nil ||
			receipt.ObservationHash != prepared.Envelope.Projection.ObservationHash {
			return false
		}
		switch receipt.Parity {
		case shadowstore.ParityMatched:
			return receipt.MismatchCode == ""
		case shadowstore.ParityMismatched:
			return receiptCodePattern.MatchString(receipt.MismatchCode)
		default:
			return false
		}
	case shadowstore.ReceiptReconciliationRequired:
		return receipt.Parity == shadowstore.ParityUnknown && receipt.CommittedAt == nil &&
			receipt.ObservationHash == "" && receipt.MismatchCode == "" &&
			receipt.ReconciliationToken != nil && len(*receipt.ReconciliationToken) > 0 &&
			len(*receipt.ReconciliationToken) <= 512
	default:
		return false
	}
}

func writeReceipt(w http.ResponseWriter, receipt shadowstore.Receipt) {
	value := canonicaljson.Object{
		"idempotencyKey": receipt.IdempotencyKey, "observationDigest": receipt.ObservationDigest,
		"operation": receipt.Operation, "parity": string(receipt.Parity),
		"requestFingerprint": receipt.RequestFingerprint, "runId": receipt.RunID,
		"schema": receipt.Schema, "sourceSequence": receipt.SourceSequence,
		"status": string(receipt.Status), "workspaceId": receipt.WorkspaceID,
	}
	if receipt.ObservationHash != "" {
		value["observationHash"] = receipt.ObservationHash
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
		"authority": value.Authority, "authorityEligible": value.AuthorityEligible,
		"goRole": value.GoRole, "matchedObservationHash": value.MatchedObservationHash,
		"matchedSourceSequence": value.MatchedSourceSequence,
		"observation":           readModelValue(value.ReadModel),
		"observations":          canonicaljson.Object{"matched": value.MatchedObservations, "mismatched": value.MismatchedObservations},
		"parity":                string(value.Parity), "runId": value.RunID, "schema": value.Schema,
		"shadow": value.Shadow, "sourceSequence": value.SourceSequence, "workspaceId": value.WorkspaceID,
	}
}

func readModelValue(value workflowcontrol.ReadModel) canonicaljson.Object {
	gaps := make(canonicaljson.Array, len(value.QualificationGaps))
	for index, gap := range value.QualificationGaps {
		gaps[index] = gap
	}
	result := canonicaljson.Object{
		"approvals": approvalsValue(value.Approvals), "authority": value.Authority,
		"authorityEligible": value.AuthorityEligible, "budget": budgetValue(value.Budget),
		"currentPhase": optionalString(value.CurrentPhase), "goRole": value.GoRole,
		"manifestHash": value.ManifestHash, "mode": string(value.Mode),
		"observationHash": value.ObservationHash,
		"phaseCounts": canonicaljson.Object{
			"cacheKeyHashBound": value.PhaseCounts.CacheKeyHashBound, "completed": value.PhaseCounts.Completed,
			"failed": value.PhaseCounts.Failed, "resultHashBound": value.PhaseCounts.ResultHashBound,
			"skipped": value.PhaseCounts.Skipped, "total": value.PhaseCounts.Total,
		},
		"qualificationGaps": gaps, "runId": value.RunID, "schema": value.Schema,
		"startedAt": value.StartedAt, "status": string(value.Status), "terminal": value.Terminal,
		"updatedAt": value.UpdatedAt, "workflowName": value.WorkflowName,
	}
	return result
}

func approvalsValue(value workflowcontrol.ApprovalObservation) canonicaljson.Object {
	counts := func(value workflowcontrol.ApprovalCounts) canonicaljson.Object {
		return canonicaljson.Object{"approved": value.Approved, "pending": value.Pending, "rejected": value.Rejected}
	}
	return canonicaljson.Object{
		"effectV2":      canonicaljson.Object{"counts": counts(value.EffectV2.Counts), "plane": value.EffectV2.Plane, "schema": value.EffectV2.Schema, "semantics": value.EffectV2.Semantics},
		"legacyRunGate": canonicaljson.Object{"counts": counts(value.LegacyRunGate.Counts), "plane": value.LegacyRunGate.Plane, "semantics": value.LegacyRunGate.Semantics},
	}
}

func budgetValue(value workflowcontrol.BudgetReadModel) canonicaljson.Object {
	return canonicaljson.Object{
		"agentCalls": value.AgentCalls, "configured": value.Configured,
		"costUsd": optionalFloat(value.CostUSD), "policyHash": optionalString(value.PolicyHash),
		"tokenBudget": optionalInt(value.TokenBudget), "tokensUsed": value.TokensUsed,
		"warningCounts": canonicaljson.Object{"exceeded": value.WarningCounts.Exceeded, "threshold": value.WarningCounts.Threshold},
	}
}

func optionalString(value *string) canonicaljson.Value {
	if value == nil {
		return nil
	}
	return *value
}

func optionalInt(value *int64) canonicaljson.Value {
	if value == nil {
		return nil
	}
	return *value
}

func optionalFloat(value *float64) canonicaljson.Value {
	if value == nil {
		return nil
	}
	return *value
}

func writeFailure(w http.ResponseWriter, status int, code, message string) {
	writeCanonical(w, status, canonicaljson.Object{
		"code": code, "message": message, "schema": "openslack.workflow_control_shadow_error.v1",
	})
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
