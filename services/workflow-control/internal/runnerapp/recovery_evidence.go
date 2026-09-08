package runnerapp

import (
	"context"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

func (service *Service) handleRecoveryEvidence(w http.ResponseWriter, request *http.Request) {
	// Old servers ignore Accept and old clients retain their original response.
	if service.schemaVersion >= 11 && acceptsRecoveryV3(request.Header.Get("Accept")) {
		service.handleRecoveryEvidenceV3(w, request)
		return
	}
	runID := request.PathValue("runId")
	query := request.URL.Query()
	bindingID := query.Get("bindingId")
	afterBindingID, snapshot := query.Get("afterBindingId"), query.Get("snapshot")
	if request.ContentLength != 0 {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "recovery evidence does not accept a request body")
		return
	}
	if service.schemaVersion >= 10 {
		if !safeID.MatchString(runID) || (bindingID != "" && !bindingIDPattern.MatchString(bindingID)) ||
			(afterBindingID != "" && !regexp.MustCompile(`^(attempt|binding|diagnostic|settlement)\.[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`).MatchString(afterBindingID)) ||
			(afterBindingID != "" && !hashPattern.MatchString(snapshot)) || (snapshot != "" && afterBindingID == "") {
			writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "recovery record cursor or identity is invalid")
			return
		}
		for name, values := range query {
			if len(values) != 1 || values[0] == "" || (name != "bindingId" && name != "afterBindingId" && name != "snapshot") {
				writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "recovery query is invalid")
				return
			}
		}
		if service.recoveryV2Store == nil {
			writeFailure(w, http.StatusServiceUnavailable, "WORKFLOW_RUNNER_AUTHORITY_UNAVAILABLE", "recovery v2 capability is unavailable")
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
		defer cancel()
		view, err := service.recoveryV2Store.ReadRecoveryEvidenceV2(ctx, service.workspaceID, runID, bindingID, afterBindingID, snapshot)
		if err != nil {
			service.writeStoreError(w, err)
			return
		}
		if view.Schema != runnerstore.RecoveryEvidenceV2Schema || view.WorkspaceID != service.workspaceID || view.RunID != runID ||
			view.Complete != (bindingID == "" && view.NextCursor == nil) || !hashPattern.MatchString(view.Snapshot) {
			writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "invalid recovery v2 response")
			return
		}
		writeCanonical(w, http.StatusOK, view)
		return
	}
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

var recoveryQuality = regexp.MustCompile(`^(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$`)

func acceptsRecoveryV3(accept string) bool {
	v3, legacy := -1.0, -1.0
	for _, value := range strings.Split(accept, ",") {
		media, params, err := mime.ParseMediaType(strings.TrimSpace(value))
		if err != nil {
			continue
		}
		quality := 1.0
		if raw, exists := params["q"]; exists {
			if !recoveryQuality.MatchString(raw) {
				continue
			}
			quality, _ = strconv.ParseFloat(raw, 64)
		}
		if media == runnerstore.RecoveryEvidenceV3MediaType {
			v3 = quality
		}
		if media == "application/json" {
			legacy = quality
		}
	}
	return v3 > 0 && v3 >= legacy
}

func (service *Service) handleRecoveryEvidenceV3(w http.ResponseWriter, request *http.Request) {
	values := request.URL.Query()
	q := runnerstore.RecoveryEvidenceV3Query{WorkspaceID: service.workspaceID, RunID: request.PathValue("runId"),
		BindingID: values.Get("bindingId"), After: values.Get("afterBindingId"), Snapshot: values.Get("snapshot"),
		RecoveryVersion: values.Get("recoveryVersion"), ReadAt: values.Get("readAt")}
	valid := request.ContentLength == 0 && safeID.MatchString(q.RunID) && (q.BindingID == "" || bindingIDPattern.MatchString(q.BindingID))
	for name, v := range values {
		if len(v) != 1 || v[0] == "" || (name != "bindingId" && name != "afterBindingId" && name != "snapshot" && name != "recoveryVersion" && name != "readAt") {
			valid = false
		}
	}
	if q.After == "" {
		valid = valid && q.Snapshot == "" && q.RecoveryVersion == "" && q.ReadAt == ""
	} else {
		_, _, pointErr := runnerstore.ParseRecoveryReadPoint(q.RecoveryVersion, q.ReadAt)
		valid = valid && pointErr == nil && regexp.MustCompile(`^(attempt|binding|diagnostic|settlement)\.[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`).MatchString(q.After) &&
			hashPattern.MatchString(q.Snapshot) && regexp.MustCompile(`^[1-9][0-9]{0,18}$`).MatchString(q.RecoveryVersion) &&
			regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`).MatchString(q.ReadAt)
	}
	if !valid {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_RUNNER_UNPROCESSABLE", "recovery v3 query is invalid")
		return
	}
	if service.recoveryV3Store == nil {
		writeFailure(w, http.StatusServiceUnavailable, "WORKFLOW_RUNNER_AUTHORITY_UNAVAILABLE", "recovery v3 capability is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	page, err := service.recoveryV3Store.ReadRecoveryEvidenceV3(ctx, q)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	view := page.Evidence
	_, _, pointErr := runnerstore.ParseRecoveryReadPoint(view.RecoveryVersion, view.ReadAt)
	if pointErr != nil || view.Schema != runnerstore.RecoveryEvidenceV3Schema || view.WorkspaceID != service.workspaceID || view.RunID != q.RunID ||
		view.Complete != (q.BindingID == "" && view.NextCursor == nil) || !hashPattern.MatchString(view.Snapshot) ||
		len(page.Bytes) == 0 || len(page.Bytes) > runnerstore.RecoveryEvidenceMaxResponseBytes {
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_RUNNER_INTERNAL", "invalid recovery v3 response")
		return
	}
	w.Header().Set("Content-Type", runnerstore.RecoveryEvidenceV3MediaType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Accept")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(page.Bytes)
}
