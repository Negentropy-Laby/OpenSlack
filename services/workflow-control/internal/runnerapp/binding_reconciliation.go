package runnerapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

const RouteBindingReconciliation = "/v2/runner/runs/{runId}/binding-reconciliation"
const RouteBindingSettlementReceipt = "/v2/runner/runs/{runId}/binding-reconciliation/receipts/{idempotencyKey}"
const RouteRecoveryPause = "/v2/runner/runs/{runId}/recovery-pause"

func (service *Service) reconciliationAvailable(w http.ResponseWriter, r *http.Request) bool {
	if !safeID.MatchString(r.PathValue("runId")) {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "reconciliation run identity is invalid")
		return false
	}
	if service.reconciliationStore == nil || service.schemaVersion < 10 {
		writeFailure(w, http.StatusServiceUnavailable, "WORKFLOW_RUNNER_AUTHORITY_UNAVAILABLE", "binding reconciliation requires schema 10")
		return false
	}
	return true
}
func (service *Service) handleBindingReconciliationPreview(w http.ResponseWriter, r *http.Request) {
	if !service.reconciliationAvailable(w, r) {
		return
	}
	q := r.URL.Query()
	binding, after := q.Get("bindingId"), q.Get("afterBindingId")
	for k, v := range q {
		if (k != "bindingId" && k != "afterBindingId") || len(v) != 1 || !bindingIDPattern.MatchString(v[0]) {
			writeFailure(w, 422, "WORKFLOW_RUNNER_UNPROCESSABLE", "reconciliation query is invalid")
			return
		}
	}
	if r.ContentLength != 0 || (binding != "" && after != "") {
		writeFailure(w, 422, "WORKFLOW_RUNNER_UNPROCESSABLE", "reconciliation query is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), readDeadline)
	defer cancel()
	view, err := service.reconciliationStore.PreviewBindingReconciliation(ctx, service.workspaceID, r.PathValue("runId"), binding, after)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	if view.Schema != "openslack.workflow_runner_binding_reconciliation_preview.v1" || view.WorkspaceID != service.workspaceID || view.RunID != r.PathValue("runId") || len(view.Encoded) == 0 || len(view.Encoded) > runnerstore.RecoveryEvidenceMaxResponseBytes {
		writeFailure(w, 500, "WORKFLOW_RUNNER_INTERNAL", "invalid reconciliation preview")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	_, _ = w.Write(view.Encoded)
}
func readReconciliationBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if r.URL.RawQuery != "" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		writeFailure(w, 422, "WORKFLOW_RUNNER_UNPROCESSABLE", "reconciliation request envelope is invalid")
		return nil, false
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 65536))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			writeFailure(w, 413, "WORKFLOW_RUNNER_LIMIT_EXCEEDED", "reconciliation request exceeds the byte contract")
		} else {
			writeFailure(w, 400, "WORKFLOW_RUNNER_INVALID_MESSAGE", "reconciliation request body could not be read")
		}
		return nil, false
	}
	return raw, true
}
func (service *Service) handleBindingReconciliationApply(w http.ResponseWriter, r *http.Request) {
	if !service.reconciliationAvailable(w, r) {
		return
	}
	raw, ok := readReconciliationBody(w, r)
	if !ok {
		return
	}
	prepared, err := runnerstore.ParseBindingReconciliation(raw)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	if prepared.Value.WorkspaceID != service.workspaceID || prepared.Value.RunID != r.PathValue("runId") || len(r.Header.Values("Idempotency-Key")) != 1 || r.Header.Get("Idempotency-Key") != prepared.IdempotencyKey {
		writeFailure(w, 422, "WORKFLOW_RUNNER_UNPROCESSABLE", "reconciliation request identity or idempotency key differs")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestDeadline)
	defer cancel()
	receipt, err := service.reconciliationStore.ApplyBindingReconciliation(ctx, prepared)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(receipt)
}
func (service *Service) handleBindingSettlementReceipt(w http.ResponseWriter, r *http.Request) {
	if !service.reconciliationAvailable(w, r) {
		return
	}
	key := r.PathValue("idempotencyKey")
	if r.URL.RawQuery != "" || r.ContentLength != 0 || !strings.HasPrefix(key, runnerstore.BindingReconciliationKeyPrefix) || !hashPattern.MatchString(strings.TrimPrefix(key, runnerstore.BindingReconciliationKeyPrefix)) {
		writeFailure(w, 422, "WORKFLOW_RUNNER_UNPROCESSABLE", "settlement receipt identity is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), readDeadline)
	defer cancel()
	receipt, err := service.reconciliationStore.ReadBindingSettlementReceipt(ctx, service.workspaceID, r.PathValue("runId"), key)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(receipt)
}
func (service *Service) handleRecoveryPause(w http.ResponseWriter, r *http.Request) {
	if !service.reconciliationAvailable(w, r) {
		return
	}
	raw, ok := readReconciliationBody(w, r)
	if !ok {
		return
	}
	var input runnerstore.RecoveryPauseRequest
	if !utf8.Valid(raw) || json.Unmarshal(raw, &input) != nil {
		writeFailure(w, 422, "WORKFLOW_RUNNER_UNPROCESSABLE", "recovery pause request is invalid")
		return
	}
	encoded, err := canonicaljson.Encode(input)
	if err != nil || !bytes.Equal(append(encoded, '\n'), raw) || input.WorkspaceID != service.workspaceID || input.RunID != r.PathValue("runId") || !hashPattern.MatchString(input.ExpectedRecordHash) {
		writeFailure(w, 422, "WORKFLOW_RUNNER_UNPROCESSABLE", "recovery pause identity or exact bytes differ")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), requestDeadline)
	defer cancel()
	receipt, err := service.reconciliationStore.PauseReconciledRun(ctx, input)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(receipt)
}
