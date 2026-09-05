package runnerapp

import (
	"context"
	"net/http"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

func (service *Service) handleRecoveryEvidence(w http.ResponseWriter, request *http.Request) {
	runID := request.PathValue("runId")
	query := request.URL.Query()
	bindingID := query.Get("bindingId")
	afterBindingID, snapshot := query.Get("afterBindingId"), query.Get("snapshot")
	validQuery := true
	for name, values := range query {
		if len(values) != 1 || values[0] == "" || (name != "bindingId" && name != "afterBindingId" && name != "snapshot") {
			validQuery = false
		}
	}
	if !safeID.MatchString(runID) || !validQuery || (bindingID != "" && (!bindingIDPattern.MatchString(bindingID) || len(query) != 1)) || (afterBindingID != "" && (!bindingIDPattern.MatchString(afterBindingID) || !hashPattern.MatchString(snapshot))) || (snapshot != "" && (afterBindingID == "" || !hashPattern.MatchString(snapshot))) {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "recovery evidence identity or query is invalid")
		return
	}
	if service.recoveryStore == nil {
		writeFailure(w, http.StatusServiceUnavailable, "WORKFLOW_RUNNER_AUTHORITY_UNAVAILABLE", "recovery evidence is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	view, err := service.recoveryStore.ReadRecoveryEvidence(ctx, service.workspaceID, runID, bindingID, afterBindingID, snapshot)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	if view.Schema != runnerstore.RecoveryEvidenceSchema || view.WorkspaceID != service.workspaceID || view.RunID != runID || view.Complete != (bindingID == "" && view.NextCursor == nil) || !hashPattern.MatchString(view.Snapshot) {
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "invalid recovery evidence response")
		return
	}
	writeCanonical(w, http.StatusOK, view)
}
