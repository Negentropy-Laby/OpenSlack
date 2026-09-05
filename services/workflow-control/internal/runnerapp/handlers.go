package runnerapp

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

const cancellationSchema = "openslack.workflow_runner_cancel_request.v1"

type cancellationRequest struct {
	Schema            string `json:"schema"`
	CorrelationID     string `json:"correlationId"`
	ExpectedAttemptID string `json:"expectedAttemptId"`
	ExpectedLeaseID   string `json:"expectedLeaseId"`
	ExpectedFence     int64  `json:"expectedFence"`
	Reason            string `json:"reason"`
	RequestedAt       string `json:"requestedAt"`
	ExpiresAt         string `json:"expiresAt"`
}

func (service *Service) handleRetiredV1Submit(w http.ResponseWriter, _ *http.Request) {
	writeFailure(
		w,
		http.StatusGone,
		"WORKFLOW_RUNNER_TS_MUTATION_RETIRED",
		"TypeScript workflow runner admission is retired; inspect evidence or use operator recovery",
	)
}

// handleSubmit is retained for closed legacy contract/recovery tests. It is no
// longer composed into the authenticated HTTP surface.
func (service *Service) handleSubmit(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireMutationHeaders(w, request) {
		return
	}
	body, err := readBoundedBody(w, request, runnerstore.MaxJobSpecBytes)
	if err != nil {
		writeReadError(w, ctx, err)
		return
	}
	prepared, err := runnerstore.ParseJobSpec(body)
	if err != nil || prepared.Spec.WorkspaceID != service.workspaceID || !bytes.Equal(body, prepared.ExactBody) {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "runner job specification is invalid")
		return
	}
	key, fingerprint := runnerstore.SubmissionBindings(prepared)
	if request.Header.Get("Idempotency-Key") != key || request.Header.Get(HeaderRequestFingerprint) != fingerprint {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "job request headers do not bind the exact body")
		return
	}
	receipt, err := service.store.Submit(ctx, runnerstore.SubmitInput{
		Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint,
	})
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	exact, err := jobReceiptBytes(receipt)
	if err != nil || !bytes.Equal(exact, receipt.ExactBytes) || !validJobReceipt(receipt, prepared, key, fingerprint) {
		service.logger.Error("workflow_runner_invalid_store_job_receipt")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "internal runner control failure")
		return
	}
	status := http.StatusCreated
	switch receipt.Status {
	case runnerstore.ReceiptDuplicate:
		service.duplicates.Add(1)
		status = http.StatusOK
	case runnerstore.ReceiptReconciliationRequired:
		status = http.StatusAccepted
	default:
		service.accepted.Add(1)
	}
	writeExactJSON(w, status, exact)
}

func (service *Service) handleV2Submit(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireMutationHeaders(w, request) {
		return
	}
	body, err := readBoundedBody(w, request, runnerstore.MaxJobSpecBytes)
	if err != nil {
		writeReadError(w, ctx, err)
		return
	}
	var prepared runnerstore.PreparedV2JobSpec
	if service.v2RuntimeDelivery {
		prepared, err = runnerstore.ParseV2RuntimeJobSpec(body)
	} else {
		prepared, err = runnerstore.ParseV2JobSpec(body)
	}
	if err != nil || prepared.Spec.WorkspaceID != service.workspaceID || !bytes.Equal(body, prepared.ExactBody) {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_V2_UNPROCESSABLE", "runner v2 job specification is invalid")
		return
	}
	if prepared.Spec.AuthorityRoute.Backend != "go" || prepared.Spec.AuthorityRoute.Authority != "workflow-control" {
		writeFailure(
			w,
			http.StatusGone,
			"WORKFLOW_RUNNER_TS_MUTATION_RETIRED",
			"TypeScript workflow runner admission is retired; inspect evidence or use operator recovery",
		)
		return
	}
	key, fingerprint := runnerstore.V2SubmissionBindings(prepared)
	if request.Header.Get("Idempotency-Key") != key || request.Header.Get(HeaderRequestFingerprint) != fingerprint {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_V2_UNPROCESSABLE", "v2 job request headers do not bind the exact body")
		return
	}
	receipt, err := service.v2Store.SubmitV2(ctx, runnerstore.V2SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint})
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	input := runnerstore.V2SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint}
	exact, err := v2JobReceiptBytes(receipt)
	if err != nil || !bytes.Equal(exact, receipt.ExactBytes) || runnerstore.ValidateV2JobReceiptForSubmit(receipt, input) != nil {
		service.logger.Error("workflow_runner_invalid_v2_store_job_receipt")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "internal runner v2 control failure")
		return
	}
	status := http.StatusCreated
	if receipt.Replay {
		w.Header().Set(HeaderIdempotencyReplayed, "true")
		service.duplicates.Add(1)
		status = http.StatusOK
	} else if receipt.Status == runnerstore.ReceiptReconciliationRequired {
		status = http.StatusAccepted
	} else {
		service.accepted.Add(1)
	}
	writeExactJSON(w, status, exact)
}

func (service *Service) handleAuthorityBindingStage(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireMutationHeaders(w, request) {
		return
	}
	body, err := readBoundedBody(w, request, runnerbindingcontract.MaxFrameBytes)
	if err != nil {
		writeReadError(w, ctx, err)
		return
	}
	value, err := runnerbindingcontract.ParseStageBytes(body)
	if err != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID", "authority-binding stage is invalid")
		return
	}
	prepared, err := runnerbindingcontract.PrepareStage(value)
	if err != nil || prepared.Body != string(body) || !bindingHeadersMatch(request, prepared) {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID", "authority-binding stage headers do not bind the exact LF body")
		return
	}
	receipt, err := service.bindingStore.StageAuthorityBinding(ctx, runnerstore.V2AuthorityBindingInput{
		WorkspaceID: service.workspaceID, Prepared: prepared,
		IdempotencyKey: request.Header.Get("Idempotency-Key"), RequestFingerprint: request.Header.Get(HeaderRequestFingerprint),
	})
	service.writeAuthorityBindingReceipt(w, receipt, err)
}

func (service *Service) handleV2RuntimeAdmission(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireMutationHeaders(w, request) {
		return
	}
	body, err := readBoundedBody(w, request, runnerstore.MaxJobSpecBytes)
	if err != nil {
		writeReadError(w, ctx, err)
		return
	}
	prepared, err := runnerstore.ParseV2RuntimeAdmission(body)
	if err != nil || prepared.Value.WorkspaceID != service.workspaceID ||
		request.Header.Get("Idempotency-Key") != prepared.IdempotencyKey ||
		request.Header.Get(HeaderRequestFingerprint) != prepared.RequestFingerprint {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_INVALID", "v2 runtime admission headers do not bind the exact LF body")
		return
	}
	receipt, err := service.admissionStore.SealV2RuntimeAdmission(ctx, runnerstore.V2RuntimeAdmissionInput{
		WorkspaceID: service.workspaceID, Prepared: prepared,
		IdempotencyKey: prepared.IdempotencyKey, RequestFingerprint: prepared.RequestFingerprint,
	})
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	exact, prepareErr := runnerstore.PrepareV2RuntimeAdmissionReceipt(receipt)
	if prepareErr != nil || !bytes.Equal(exact, receipt.ExactBytes) {
		service.logger.Error("workflow_runner_invalid_v2_runtime_admission_receipt")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "internal runner v2 control failure")
		return
	}
	status := http.StatusCreated
	if receipt.Replay {
		status = http.StatusOK
		w.Header().Set(HeaderIdempotencyReplayed, "true")
	}
	writeExactJSON(w, status, exact)
}

func (service *Service) handleAuthorityBindingAction(w http.ResponseWriter, request *http.Request) {
	action := request.PathValue("bindingAction")
	bindingID, operation, ok := strings.Cut(action, ":")
	if !ok || !bindingIDPattern.MatchString(bindingID) || (operation != "resolve" && operation != "ack-control") {
		writeFailure(w, http.StatusNotFound, "WORKFLOW_RUNNER_NOT_FOUND", "authority-binding action was not found")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireMutationHeaders(w, request) {
		return
	}
	body, err := readBoundedBody(w, request, runnerbindingcontract.MaxFrameBytes)
	if err != nil {
		writeReadError(w, ctx, err)
		return
	}
	if operation == "resolve" {
		value, parseErr := runnerbindingcontract.ParseResolutionBytes(body)
		if parseErr != nil {
			writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID", "authority-binding resolution is invalid")
			return
		}
		prepared, prepareErr := runnerbindingcontract.PrepareResolution(value)
		if prepareErr != nil || prepared.Body != string(body) || !bindingHeadersMatch(request, prepared) {
			writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID", "authority-binding resolution headers do not bind the exact LF body")
			return
		}
		receipt, storeErr := service.bindingStore.ResolveAuthorityBinding(ctx, bindingID, runnerstore.V2AuthorityBindingInput{
			WorkspaceID: service.workspaceID, Prepared: prepared,
			IdempotencyKey: request.Header.Get("Idempotency-Key"), RequestFingerprint: request.Header.Get(HeaderRequestFingerprint),
		})
		service.writeAuthorityBindingReceipt(w, receipt, storeErr)
		return
	}
	value, parseErr := runnerbindingcontract.ParseReceiptBytes(body)
	if parseErr != nil || value["phase"] != "control_delivery" {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID", "authority-binding control ACK is invalid")
		return
	}
	prepared, prepareErr := runnerbindingcontract.PrepareReceipt(value)
	if prepareErr != nil || prepared.Body != string(body) || !bindingHeadersMatch(request, prepared) {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID", "authority-binding control ACK headers do not bind the exact LF body")
		return
	}
	receipt, storeErr := service.bindingStore.AcknowledgeV2Control(ctx, runnerstore.V2ControlAcknowledgementInput{
		BindingID: bindingID, WorkspaceID: service.workspaceID, Prepared: prepared,
		IdempotencyKey: request.Header.Get("Idempotency-Key"), RequestFingerprint: request.Header.Get(HeaderRequestFingerprint),
	})
	service.writeAuthorityBindingReceipt(w, receipt, storeErr)
}

func (service *Service) handleAuthorityBindingReceipt(w http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(w, request) {
		return
	}
	key := request.PathValue("idempotencyKey")
	if !bindingKeyPattern.MatchString(key) {
		writeFailure(w, http.StatusNotFound, "WORKFLOW_RUNNER_NOT_FOUND", "authority-binding receipt was not found")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	receipt, err := service.bindingStore.ReadAuthorityBindingReceipt(ctx, service.workspaceID, key)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	if _, ok := service.validateAuthorityBindingReceipt(w, receipt); !ok {
		return
	}
	writeExactJSON(w, http.StatusOK, receipt.ExactBytes)
}

func bindingHeadersMatch(request *http.Request, prepared runnerbindingcontract.Prepared) bool {
	return request.Header.Get("Idempotency-Key") == prepared.IdempotencyKey &&
		request.Header.Get(HeaderRequestFingerprint) == prepared.RequestFingerprint
}

func (service *Service) writeAuthorityBindingReceipt(w http.ResponseWriter, receipt runnerstore.V2AuthorityBindingReceipt, err error) {
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	value, ok := service.validateAuthorityBindingReceipt(w, receipt)
	if !ok {
		return
	}
	status := http.StatusCreated
	if receipt.Replay {
		w.Header().Set(HeaderIdempotencyReplayed, "true")
		status = http.StatusOK
	} else if value["status"] == "reconciliation_required" {
		status = http.StatusAccepted
	}
	writeExactJSON(w, status, receipt.ExactBytes)
}

func (service *Service) validateAuthorityBindingReceipt(w http.ResponseWriter, receipt runnerstore.V2AuthorityBindingReceipt) (runnerbindingcontract.Record, bool) {
	value, parseErr := runnerbindingcontract.ParseReceiptBytes(receipt.ExactBytes)
	if parseErr != nil {
		service.logger.Error("workflow_runner_invalid_authority_binding_receipt")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "internal runner authority-binding failure")
		return nil, false
	}
	prepared, prepareErr := runnerbindingcontract.PrepareReceipt(value)
	if prepareErr != nil || prepared.Body != string(receipt.ExactBytes) || value["bindingId"] != receipt.Value["bindingId"] || value["phase"] != receipt.Value["phase"] {
		service.logger.Error("workflow_runner_invalid_authority_binding_receipt")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "internal runner authority-binding failure")
		return nil, false
	}
	return value, true
}

func v2JobReceiptBytes(receipt runnerstore.V2JobReceipt) ([]byte, error) {
	body, err := canonicaljson.Encode(receipt)
	if err != nil {
		return nil, err
	}
	return append(body, '\n'), nil
}

func (service *Service) handleReadJob(w http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(w, request) {
		return
	}
	jobID := request.PathValue("jobId")
	if !safeID.MatchString(jobID) {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "runner job identity is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	view, err := service.store.ReadJob(ctx, service.workspaceID, jobID)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	if view.Schema != runnerstore.JobViewSchema || view.WorkspaceID != service.workspaceID || view.JobID != jobID {
		service.logger.Error("workflow_runner_invalid_store_job_view")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "internal runner control failure")
		return
	}
	writeCanonical(w, http.StatusOK, view)
}

func (service *Service) handleCancellation(w http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireMutationHeaders(w, request) {
		return
	}
	jobID := request.PathValue("jobId")
	if !safeID.MatchString(jobID) {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "runner job identity is invalid")
		return
	}
	body, err := readBoundedBody(w, request, runnerstore.MaxJobSpecBytes)
	if err != nil {
		writeReadError(w, ctx, err)
		return
	}
	var value cancellationRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil || requireEOF(decoder) != nil || value.Schema != cancellationSchema {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "runner cancellation is invalid")
		return
	}
	canonicalBody, canonicalErr := canonicaljson.Encode(value)
	if canonicalErr != nil || !bytes.Equal(body, canonicalBody) {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "runner cancellation must be exact canonical JSON")
		return
	}
	requestedAt, err := runnerstore.ParseTimestamp(value.RequestedAt)
	if err != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "runner cancellation requestedAt is invalid")
		return
	}
	expiresAt, err := runnerstore.ParseTimestamp(value.ExpiresAt)
	if err != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "runner cancellation expiresAt is invalid")
		return
	}
	input := runnerstore.CancelInput{
		WorkspaceID: service.workspaceID, JobID: jobID,
		CorrelationID: value.CorrelationID, ExpectedAttemptID: value.ExpectedAttemptID,
		ExpectedLeaseID: value.ExpectedLeaseID, ExpectedFence: value.ExpectedFence,
		Reason: value.Reason, Now: requestedAt, ExpiresAt: expiresAt,
	}
	key, fingerprint, err := runnerstore.CancelBindings(input)
	if err != nil || request.Header.Get("Idempotency-Key") != key || request.Header.Get(HeaderRequestFingerprint) != fingerprint {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "cancellation headers do not bind the exact control")
		return
	}
	input.IdempotencyKey, input.RequestFingerprint = key, fingerprint
	control, err := service.store.RequestCancel(ctx, input)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	if control.WorkspaceID != service.workspaceID || control.JobID != jobID || control.AttemptID != value.ExpectedAttemptID || control.LeaseID != value.ExpectedLeaseID || control.FencingToken != value.ExpectedFence || control.Reason != value.Reason {
		service.logger.Error("workflow_runner_invalid_store_cancel_receipt")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "internal runner control failure")
		return
	}
	service.cancellations.Add(1)
	if control.Duplicate {
		service.duplicates.Add(1)
	}
	// A replay returns the original admission response byte-for-byte. Duplicate
	// is an internal metric only and is never allowed to mutate durable HTTP
	// semantics from accepted/202 into a new response.
	writeCanonical(w, http.StatusAccepted, canonicaljson.Object{
		"schema": "openslack.workflow_runner_cancel_receipt.v1", "status": "accepted",
		"workspaceId": control.WorkspaceID, "jobId": control.JobID,
		"workflowRunId": control.WorkflowRunID, "attemptId": control.AttemptID,
		"leaseId": control.LeaseID, "fencingToken": control.FencingToken,
		"cancelId": control.CancelID, "reason": control.Reason,
		"requestedAt":     runnerstore.CanonicalTimestamp(control.RequestedAt),
		"expiresAt":       runnerstore.CanonicalTimestamp(control.ExpiresAt),
		"controlSequence": control.ControlSequence,
		"idempotencyKey":  key, "requestFingerprint": fingerprint,
	})
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
	version := canonicaljson.Object{
		"schema":   "openslack.workflow_runner_control_service_version.v1",
		"buildSha": service.buildSHA, "schemaVersion": service.schemaVersion,
		"mode": "runner-control-explicit", "workflowAuthority": "typescript",
	}
	if service.v2NewRecordCanary {
		version["workflowAuthority"] = "immutable-route-receipt"
	}
	if service.v2Enabled {
		version["v2QualificationAdmission"] = true
		version["routingActivated"] = service.v2NewRecordCanary
	}
	if service.v2RuntimeDelivery {
		version["v2RuntimeDeliveryQualification"] = true
		version["productionRoutingActivated"] = service.v2NewRecordCanary
	}
	if service.v2NewRecordCanary {
		version["newRecordCanary"] = true
	}
	writeCanonical(w, http.StatusOK, version)
}

func (service *Service) handleBinding(w http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(w, request) {
		return
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{
		"schema":      "openslack.workflow_runner_control_binding.v1",
		"workspaceId": service.workspaceID, "buildSha": service.buildSHA,
		"runnerTokenSha256": hex.EncodeToString(service.tokenHash[:]),
		"v2Enabled":         service.v2Enabled, "runtimeDeliveryEnabled": service.v2RuntimeDelivery,
		"newRecordCanary":      service.v2NewRecordCanary,
		"authorityOrigin":      service.runAuthorityOrigin,
		"authorityCallerId":    service.runAuthorityCallerID,
		"authorityBuildSha":    service.runAuthorityBuildSHA,
		"authorityTokenSha256": service.runAuthorityTokenSHA256,
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
	lines := []string{
		"# TYPE openslack_workflow_runner_http_requests_total counter",
		"openslack_workflow_runner_http_requests_total " + strconv.FormatInt(service.requests.Load(), 10),
		"# TYPE openslack_workflow_runner_http_unauthorized_total counter",
		"openslack_workflow_runner_http_unauthorized_total " + strconv.FormatInt(service.unauthorized.Load(), 10),
		"# TYPE openslack_workflow_runner_jobs gauge",
		`openslack_workflow_runner_jobs{state="queued"} ` + strconv.FormatInt(statistics.QueuedJobs, 10),
		`openslack_workflow_runner_jobs{state="reconciliation_required"} ` + strconv.FormatInt(statistics.ReconciliationPending, 10),
		"# TYPE openslack_workflow_runner_leases gauge",
		`openslack_workflow_runner_leases{state="active"} ` + strconv.FormatInt(statistics.ActiveLeases, 10),
		`openslack_workflow_runner_leases{state="expired"} ` + strconv.FormatInt(statistics.ExpiredLeases, 10),
		"# TYPE openslack_workflow_runner_takeovers_total counter",
		"openslack_workflow_runner_takeovers_total " + strconv.FormatInt(statistics.Takeovers, 10),
		"# TYPE openslack_workflow_runner_stale_fence_rejections_total counter",
		"openslack_workflow_runner_stale_fence_rejections_total " + strconv.FormatInt(statistics.StaleFenceRejects, 10),
		"# TYPE openslack_workflow_runner_process_crashes_total counter",
		"openslack_workflow_runner_process_crashes_total " + strconv.FormatInt(statistics.ProcessCrashes, 10),
		"# TYPE openslack_workflow_runner_forced_terminations_total counter",
		"openslack_workflow_runner_forced_terminations_total " + strconv.FormatInt(statistics.ForcedTerminations, 10),
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(strings.Join(lines, "\n") + "\n"))
}

func requireMutationHeaders(w http.ResponseWriter, request *http.Request) bool {
	if !requireNoQuery(w, request) {
		return false
	}
	if values := request.Header.Values("Content-Type"); len(values) != 1 || values[0] != "application/json" {
		writeFailure(w, http.StatusUnsupportedMediaType, "WORKFLOW_RUNNER_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json")
		return false
	}
	if len(request.Header.Values("Idempotency-Key")) != 1 || len(request.Header.Values(HeaderRequestFingerprint)) != 1 {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "one idempotency key and request fingerprint are required")
		return false
	}
	return true
}

func requireNoQuery(w http.ResponseWriter, request *http.Request) bool {
	if request.URL.RawQuery == "" {
		return true
	}
	writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "query parameters are not accepted")
	return false
}

func readBoundedBody(w http.ResponseWriter, request *http.Request, maximum int64) ([]byte, error) {
	request.Body = http.MaxBytesReader(w, request.Body, maximum)
	body, err := io.ReadAll(&contextReader{ctx: request.Context(), reader: request.Body})
	if err != nil {
		return nil, err
	}
	if len(body) == 0 || int64(len(body)) > maximum {
		return nil, fmt.Errorf("request body size is invalid")
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

func requireEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return fmt.Errorf("multiple JSON values")
	}
	return err
}

func writeReadError(w http.ResponseWriter, ctx context.Context, _ error) {
	if ctx.Err() != nil {
		writeFailure(w, http.StatusRequestTimeout, "WORKFLOW_RUNNER_TIMEOUT", "runner request deadline exceeded")
		return
	}
	writeFailure(w, http.StatusRequestEntityTooLarge, "WORKFLOW_RUNNER_TOO_LARGE", "runner request exceeds the frozen service limit")
}

func (service *Service) writeStoreError(w http.ResponseWriter, err error) {
	var failure *runnerstore.Error
	if !errors.As(err, &failure) {
		service.logger.Error("workflow_runner_unmapped_store_failure")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "internal runner control failure")
		return
	}
	switch failure.Code {
	case runnerstore.ErrorInputInvalid, runnerstore.ErrorUnknownField, runnerstore.ErrorLimitExceeded,
		runnerstore.ErrorHashMismatch, runnerstore.ErrorControlExpired:
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "runner control request is invalid")
	case runnerstore.ErrorNotFound:
		writeFailure(w, http.StatusNotFound, "WORKFLOW_RUNNER_NOT_FOUND", "runner job was not found")
	case runnerstore.ErrorIdempotencyConflict, runnerstore.ErrorSequenceConflict,
		runnerstore.ErrorStaleFence, runnerstore.ErrorIdentityMismatch, runnerstore.ErrorConflict,
		runnerstore.ErrorLeaseExpired, runnerstore.ErrorAuthorityBinding:
		service.conflicts.Add(1)
		writeFailure(w, http.StatusConflict, "WORKFLOW_RUNNER_CONFLICT", "runner control precondition conflicted")
	case runnerstore.ErrorDatabase, runnerstore.ErrorCommitUnknown, runnerstore.ErrorAuthorityUnavailable:
		writeFailure(w, http.StatusServiceUnavailable, "WORKFLOW_RUNNER_UNAVAILABLE", "runner control store is unavailable")
	case runnerstore.ErrorReconciliation:
		writeFailure(w, http.StatusAccepted, "WORKFLOW_RUNNER_RECONCILIATION_REQUIRED", "runner lifecycle requires reconciliation")
	default:
		service.logger.Error("workflow_runner_unmapped_store_failure", "code", failure.Code)
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "internal runner control failure")
	}
}

func validJobReceipt(receipt runnerstore.JobReceipt, prepared runnerstore.PreparedJobSpec, key, fingerprint string) bool {
	if receipt.Schema != runnerstore.JobReceiptSchema || receipt.WorkspaceID != prepared.Spec.WorkspaceID ||
		receipt.JobID != prepared.Spec.JobID || receipt.WorkflowRunID != prepared.Spec.WorkflowRunID ||
		receipt.JobSpecHash != prepared.JobSpecHash || receipt.IdempotencyKey != key ||
		receipt.RequestFingerprint != fingerprint || receipt.Revision < 1 || receipt.CommittedAt == "" {
		return false
	}
	switch receipt.Status {
	case runnerstore.ReceiptAccepted, runnerstore.ReceiptDuplicate:
		return receipt.State == runnerstore.JobQueued && receipt.ReconciliationID == nil
	case runnerstore.ReceiptReconciliationRequired:
		return receipt.State == runnerstore.JobReconciliationRequired && receipt.ReconciliationID != nil && *receipt.ReconciliationID != ""
	default:
		return false
	}
}

func jobReceiptBytes(receipt runnerstore.JobReceipt) ([]byte, error) {
	body, err := canonicaljson.Encode(canonicaljson.Object{
		"schema": receipt.Schema, "status": string(receipt.Status),
		"workspaceId": receipt.WorkspaceID, "jobId": receipt.JobID,
		"workflowRunId": receipt.WorkflowRunID, "state": string(receipt.State),
		"revision": receipt.Revision, "jobSpecHash": receipt.JobSpecHash,
		"idempotencyKey":     receipt.IdempotencyKey,
		"requestFingerprint": receipt.RequestFingerprint,
		"committedAt":        receipt.CommittedAt, "reconciliationId": receipt.ReconciliationID,
	})
	if err != nil {
		return nil, err
	}
	return append(body, '\n'), nil
}

func writeFailure(w http.ResponseWriter, status int, code, message string) {
	writeCanonical(w, status, canonicaljson.Object{
		"schema": "openslack.workflow_runner_control_error.v1", "code": code, "message": message,
	})
}

func writeCanonical(w http.ResponseWriter, status int, value canonicaljson.Value) {
	body, err := canonicaljson.Encode(value)
	if err != nil || len(body) > MaxResponseBodyBytes {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeExactJSON(w, status, append(body, '\n'))
}

func writeExactJSON(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
