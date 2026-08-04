package authorityapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

func (service *Service) handleAccept(w http.ResponseWriter, request *http.Request) {
	service.handleMutation(w, request, authoritystore.OperationAccept, "")
}

func (service *Service) handleTransition(w http.ResponseWriter, request *http.Request) {
	runAction := request.PathValue("runAction")
	if !strings.HasSuffix(runAction, ":transition") {
		writeFailure(w, http.StatusNotFound, "WORKFLOW_CONTROL_AUTHORITY_NOT_FOUND", "authority transition path was not found")
		return
	}
	runID := strings.TrimSuffix(runAction, ":transition")
	service.handleMutation(w, request, authoritystore.OperationTransition, runID)
}

func (service *Service) handleMutation(w http.ResponseWriter, request *http.Request, operation authoritystore.Operation, runID string) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireNoQuery(w, request) {
		return
	}
	contentType, contentOK := oneHeader(request, "Content-Type")
	key, keyOK := oneHeader(request, "Idempotency-Key")
	providedFingerprint, fingerprintOK := oneHeader(request, HeaderFingerprint)
	if !contentOK || contentType != "application/json" {
		writeFailure(w, http.StatusUnsupportedMediaType, "WORKFLOW_CONTROL_AUTHORITY_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be one application/json value")
		return
	}
	if !keyOK || !fingerprintOK || authoritystore.ValidateIdempotencyKey(key) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_AUTHORITY_INPUT_INVALID", "authority idempotency headers are invalid")
		return
	}
	body, err := readBoundedBody(w, request)
	if err != nil {
		if ctx.Err() != nil {
			writeFailure(w, http.StatusRequestTimeout, "WORKFLOW_CONTROL_AUTHORITY_TIMEOUT", "authority request deadline exceeded")
		} else {
			writeFailure(w, http.StatusRequestEntityTooLarge, "WORKFLOW_CONTROL_AUTHORITY_TOO_LARGE", "authority request exceeds the frozen byte limit")
		}
		return
	}
	prepared, err := authoritystore.PrepareRequest(body, service.callerID, service.workspaceID, strconv.FormatInt(service.routingEpoch, 10), service.buildSHA)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	if prepared.Envelope.Operation != operation || prepared.Envelope.RunID != runID && operation == authoritystore.OperationTransition ||
		authoritystore.RequestPath(operation, prepared.Envelope.RunID) != request.URL.Path {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_AUTHORITY_CONTENT_INVALID", "authority operation, run, and path do not match")
		return
	}
	expectedKey := authoritystore.ExpectedIdempotencyKey(prepared.ExactBody)
	fingerprint := authoritystore.RequestFingerprint(request.Method, request.URL.Path, prepared)
	if key != expectedKey || providedFingerprint != fingerprint {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_AUTHORITY_INPUT_INVALID", "authority idempotency headers do not bind the exact request")
		return
	}
	receipt, err := service.repository.Mutate(ctx, authoritystore.MutateInput{
		Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint, ServiceBuildHash: service.buildSHA,
	})
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	if !validReceipt(receipt, prepared, key, fingerprint, service.buildSHA) {
		service.logger.Error("workflow_control_authority_invalid_store_receipt")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_AUTHORITY_INTERNAL", "authority repository returned an invalid receipt")
		return
	}
	status := http.StatusCreated
	if receipt.Replay {
		status = http.StatusOK
		service.replays.Add(1)
		w.Header().Set(HeaderReplay, "true")
	} else if receipt.Value.Status == authoritycontract.ReceiptReconciliationRequired {
		status = http.StatusAccepted
		service.reconciliation.Add(1)
	} else {
		service.accepted.Add(1)
	}
	writeExactJSON(w, status, receipt.ExactBytes)
}

func (service *Service) handleReadRun(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	runID := request.PathValue("runId")
	if err := authoritystore.ValidateReadIdentity(service.workspaceID, runID); err != nil {
		service.writeStoreError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	head, err := service.repository.Read(ctx, service.workspaceID, runID)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	record, ok := validRunHead(head, service.workspaceID, runID, service.routingEpoch, service.buildSHA)
	if !ok {
		service.logger.Error("workflow_control_authority_invalid_store_head")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_AUTHORITY_INTERNAL", "authority repository returned an invalid run head")
		return
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{
		"schema": head.Schema, "workspaceId": head.WorkspaceID, "runId": head.RunID,
		"workflowId": head.WorkflowID, "workflowVersion": head.WorkflowVersion,
		"workflowSourceHash": head.WorkflowSourceHash, "manifestHash": head.ManifestHash,
		"inputHash": head.InputHash, "route": head.Route, "state": string(head.State),
		"revision": head.Revision, "currentPhaseId": head.CurrentPhaseID,
		"currentPhaseIndex": head.CurrentPhaseIndex, "resumeGeneration": head.ResumeGeneration,
		"recordHash": head.RecordHash, "record": record, "updatedAt": canonicalTimestamp(head.UpdatedAt),
	})
}

func (service *Service) handleReadReceipt(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	key := request.PathValue("idempotencyKey")
	if err := authoritystore.ValidateReceiptIdentity(service.workspaceID, key); err != nil {
		service.writeStoreError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	receipt, err := service.repository.ReadReceipt(ctx, service.workspaceID, key)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	if !validReadReceipt(receipt, service.workspaceID, key, service.routingEpoch, service.buildSHA) {
		service.logger.Error("workflow_control_authority_invalid_stored_receipt")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_AUTHORITY_INTERNAL", "stored authority receipt is invalid")
		return
	}
	writeExactJSON(w, http.StatusOK, receipt.ExactBytes)
}

func (service *Service) handleReadOutbox(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	runID := request.PathValue("runId")
	revisionAction := request.PathValue("revisionAction")
	if !strings.HasSuffix(revisionAction, ":pending") || authoritystore.ValidateReadIdentity(service.workspaceID, runID) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_AUTHORITY_INPUT_INVALID", "outbox identity is invalid")
		return
	}
	revisionRaw := strings.TrimSuffix(revisionAction, ":pending")
	revision, err := strconv.ParseInt(revisionRaw, 10, 64)
	if err != nil || revision < 1 || revision > authoritycontract.MaxSafeInteger || strconv.FormatInt(revision, 10) != revisionRaw {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_AUTHORITY_INPUT_INVALID", "outbox revision is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	outbox, err := service.repository.ReadOutbox(ctx, service.workspaceID, runID, revision)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	payload, ok := validOutbox(outbox, service.workspaceID, runID, revision, service.routingEpoch, service.buildSHA)
	if !ok {
		service.logger.Error("workflow_control_authority_invalid_store_outbox")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_AUTHORITY_INTERNAL", "authority repository returned an invalid pending outbox record")
		return
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{
		"schema": outbox.Schema, "outboxId": outbox.OutboxID, "eventId": outbox.EventID,
		"workspaceId": outbox.WorkspaceID, "runId": outbox.RunID, "runRevision": outbox.RunRevision,
		"eventType": outbox.EventType, "status": outbox.Status, "idempotencyKey": outbox.IdempotencyKey,
		"payloadHash": outbox.PayloadHash, "payload": payload, "attemptCount": outbox.AttemptCount,
		"createdAt": canonicalTimestamp(outbox.CreatedAt),
	})
}

func (service *Service) handleLive(w http.ResponseWriter, request *http.Request) {
	if requireReadEnvelope(w, request) {
		writeCanonical(w, http.StatusOK, canonicaljson.Object{"status": "live"})
	}
}

func (service *Service) handleReady(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	if !service.qualificationMode {
		writeCanonical(w, http.StatusOK, canonicaljson.Object{"status": "ready"})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	if _, err := service.repository.Statistics(ctx); err != nil {
		writeCanonical(w, http.StatusServiceUnavailable, canonicaljson.Object{"status": "not_ready"})
		return
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{"status": "ready"})
}

func (service *Service) handleVersion(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{
		"schema":          "openslack.workflow_control_authority_service_version.v1",
		"contractVersion": "v2", "buildSha": service.buildSHA,
		"mode":              map[bool]string{false: "disabled", true: "local-qualification-v1"}[service.qualificationMode],
		"qualificationMode": service.qualificationMode, "authority": "typescript",
		"routingActivated": false, "acceptNewRecords": false,
	})
}

func (service *Service) handleMetrics(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	statistics := authoritystore.Statistics{}
	if service.qualificationMode {
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		var err error
		statistics, err = service.repository.Statistics(ctx)
		if err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("metrics unavailable\n"))
			return
		}
	}
	lines := []string{
		"# TYPE openslack_workflow_control_authority_http_requests_total counter",
		"openslack_workflow_control_authority_http_requests_total " + strconv.FormatInt(service.requests.Load(), 10),
		"openslack_workflow_control_authority_http_unauthorized_total " + strconv.FormatInt(service.unauthorized.Load(), 10),
		"openslack_workflow_control_authority_accepts_total " + strconv.FormatInt(service.accepted.Load(), 10),
		"openslack_workflow_control_authority_replays_total " + strconv.FormatInt(service.replays.Load(), 10),
		"openslack_workflow_control_authority_reconciliation_total " + strconv.FormatInt(service.reconciliation.Load(), 10),
		"openslack_workflow_control_authority_runs " + strconv.FormatInt(statistics.Runs, 10),
		"openslack_workflow_control_authority_receipts " + strconv.FormatInt(statistics.Receipts, 10),
		"openslack_workflow_control_authority_outbox_pending " + strconv.FormatInt(statistics.OutboxPending, 10),
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(strings.Join(lines, "\n") + "\n"))
}

func validReceipt(receipt authoritystore.Receipt, prepared authoritystore.PreparedRequest, key, fingerprint, buildSHA string) bool {
	value := receipt.Value
	if !validReadReceipt(receipt, prepared.Envelope.WorkspaceID, key, prepared.Envelope.Route.RoutingEpoch, buildSHA) ||
		value.RunID != prepared.Envelope.RunID || value.ExpectedRevision != prepared.Envelope.Expected.Revision ||
		value.ResumeGeneration != prepared.Envelope.Record.ResumeGeneration || value.RequestFingerprint != fingerprint ||
		value.RequestHash != prepared.RequestHash || value.CorrelationID != prepared.Envelope.CorrelationID {
		return false
	}
	if value.RecordHash != nil && *value.RecordHash != prepared.RecordHash {
		return false
	}
	return true
}

func validReadReceipt(receipt authoritystore.Receipt, workspaceID, key string, routingEpoch int64, buildSHA string) bool {
	value := receipt.Value
	canonical, err := authoritycontract.CanonicalJSON(value)
	canonical = append(canonical, '\n')
	decoded, decodeErr := authoritycontract.DecodeReceiptJSON(bytes.TrimSuffix(receipt.ExactBytes, []byte{'\n'}))
	return err == nil && decodeErr == nil && reflect.DeepEqual(decoded, value) && bytes.Equal(canonical, receipt.ExactBytes) && len(receipt.ExactBytes) <= authoritycontract.MaxReceiptBytes &&
		value.Schema == authoritycontract.ReceiptSchema && value.WorkspaceID == workspaceID && value.IdempotencyKey == key &&
		value.Route.Backend == authoritystore.Backend && value.Route.Authority == authoritystore.Authority &&
		value.Route.RoutingEpoch == routingEpoch && value.Route.AuthorityBuildHash == buildSHA && value.ServiceBuildHash == buildSHA
}

func validRunHead(head authoritystore.RunHead, workspaceID, runID string, routingEpoch int64, buildSHA string) (authoritystore.RunRecord, bool) {
	var record authoritystore.RunRecord
	if err := decodeExactCanonical(head.RecordBytes, &record); err != nil {
		return record, false
	}
	digest := sha256.Sum256(head.RecordBytes)
	valid := head.Schema == authoritystore.ReadSchema && head.WorkspaceID == workspaceID && head.RunID == runID && head.RecordHash == hex.EncodeToString(digest[:]) &&
		head.Route.Backend == authoritystore.Backend && head.Route.Authority == authoritystore.Authority &&
		head.Route.RoutingEpoch == routingEpoch && head.Route.AuthorityBuildHash == buildSHA && head.ServiceBuildHash == buildSHA &&
		record.Schema == authoritystore.RunRecordSchema && record.WorkspaceID == head.WorkspaceID && record.RunID == head.RunID && record.WorkflowID == head.WorkflowID &&
		record.WorkflowVersion == head.WorkflowVersion && record.WorkflowSourceHash == head.WorkflowSourceHash &&
		record.ManifestHash == head.ManifestHash && record.InputHash == head.InputHash && record.Route == head.Route &&
		record.State == head.State && record.Revision == head.Revision && record.ResumeGeneration == head.ResumeGeneration &&
		pointerStringEqual(record.CurrentPhaseID, head.CurrentPhaseID) && pointerInt64Equal(record.CurrentPhaseIndex, head.CurrentPhaseIndex) &&
		head.UpdatedAt.IsZero() == false
	return record, valid
}

type outboxPayload struct {
	Schema        string                         `json:"schema"`
	EventID       string                         `json:"eventId"`
	ReceiptID     string                         `json:"receiptId"`
	WorkspaceID   string                         `json:"workspaceId"`
	RunID         string                         `json:"runId"`
	Expected      authoritystore.ExpectedBinding `json:"expected"`
	Record        authoritystore.RunRecord       `json:"record"`
	RecordHash    string                         `json:"recordHash"`
	CorrelationID string                         `json:"correlationId"`
}

func validOutbox(outbox authoritystore.OutboxRecord, workspaceID, runID string, revision, routingEpoch int64, buildSHA string) (any, bool) {
	var payload outboxPayload
	if err := decodeExactCanonical(outbox.PayloadBytes, &payload); err != nil {
		return nil, false
	}
	recordBytes, err := canonicaljson.Encode(payload.Record)
	if err != nil {
		return nil, false
	}
	recordBytes = append(recordBytes, '\n')
	recordDigest := sha256.Sum256(recordBytes)
	digest := sha256.Sum256(outbox.PayloadBytes)
	valid := outbox.Schema == authoritystore.OutboxSchema && outbox.WorkspaceID == workspaceID && outbox.RunID == runID &&
		outbox.RunRevision == revision && outbox.EventType == authoritystore.OutboxEventType && outbox.Status == "pending" &&
		outbox.OutboxID != "" && outbox.EventID != "" && outbox.IdempotencyKey == authoritystore.OutboxKeyPrefix+outbox.PayloadHash &&
		outbox.PayloadHash == hex.EncodeToString(digest[:]) &&
		outbox.AttemptCount >= 0 && !outbox.CreatedAt.IsZero() && payload.Schema == authoritystore.OutboxSchema &&
		payload.EventID == outbox.EventID && payload.WorkspaceID == workspaceID && payload.RunID == runID &&
		payload.ReceiptID != "" && identityPattern.MatchString(payload.CorrelationID) &&
		payload.Record.Schema == authoritystore.RunRecordSchema && payload.Record.WorkspaceID == workspaceID && payload.Record.RunID == runID && payload.Record.Revision == revision &&
		payload.Record.Route.Backend == authoritystore.Backend && payload.Record.Route.Authority == authoritystore.Authority &&
		payload.Record.Route.RoutingEpoch == routingEpoch && payload.Record.Route.AuthorityBuildHash == buildSHA &&
		payload.Expected.Revision+1 == revision && payload.RecordHash == hex.EncodeToString(recordDigest[:])
	return payload, valid
}

func decodeExactCanonical(body []byte, destination any) error {
	if len(body) == 0 || body[len(body)-1] != '\n' {
		return fmt.Errorf("canonical value is not LF terminated")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := requireEOF(decoder); err != nil {
		return err
	}
	canonical, err := canonicaljson.Encode(destination)
	if err != nil {
		return err
	}
	if !bytes.Equal(append(canonical, '\n'), body) {
		return fmt.Errorf("stored value is not exact canonical JSON plus LF")
	}
	return nil
}

func readBoundedBody(w http.ResponseWriter, request *http.Request) ([]byte, error) {
	request.Body = http.MaxBytesReader(w, request.Body, authoritystore.MaxRequestBytes)
	body, err := io.ReadAll(&contextReader{ctx: request.Context(), reader: request.Body})
	if err != nil || len(body) == 0 || len(body) > authoritystore.MaxRequestBytes {
		if err == nil {
			err = fmt.Errorf("authority body size is invalid")
		}
		return nil, err
	}
	return body, nil
}

func requireNoQuery(w http.ResponseWriter, request *http.Request) bool {
	if request.URL.RawQuery == "" {
		return true
	}
	writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_AUTHORITY_INPUT_INVALID", "query parameters are not accepted")
	return false
}

func requireReadEnvelope(w http.ResponseWriter, request *http.Request) bool {
	if !requireNoQuery(w, request) {
		return false
	}
	if request.ContentLength == 0 && len(request.TransferEncoding) == 0 {
		return true
	}
	writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_AUTHORITY_INPUT_INVALID", "request body is not accepted")
	return false
}

func (service *Service) writeStoreError(w http.ResponseWriter, err error) {
	var failure *authoritystore.Error
	if !errors.As(err, &failure) {
		service.logger.Error("workflow_control_authority_unmapped_failure")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_AUTHORITY_INTERNAL", "internal authority failure")
		return
	}
	switch failure.Code {
	case authoritystore.ErrorInputInvalid, authoritystore.ErrorContentInvalid:
		writeFailure(w, http.StatusUnprocessableEntity, string(failure.Code), "authority request is invalid")
	case authoritystore.ErrorConflict, authoritystore.ErrorIdempotencyConflict:
		service.conflicts.Add(1)
		writeFailure(w, http.StatusConflict, string(failure.Code), "authority precondition conflicted")
	case authoritystore.ErrorNotFound:
		writeFailure(w, http.StatusNotFound, string(failure.Code), "authority record was not found")
	case authoritystore.ErrorDatabase:
		writeFailure(w, http.StatusServiceUnavailable, string(failure.Code), "authority repository is unavailable")
	case authoritystore.ErrorCommitUnknown:
		service.logger.Error("workflow_control_authority_commit_outcome_unknown")
		writeFailure(w, http.StatusInternalServerError, string(failure.Code), "authority commit outcome is unknown; reconcile with the same key")
	default:
		service.logger.Error("workflow_control_authority_unmapped_store_failure", "code", failure.Code)
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_AUTHORITY_INTERNAL", "internal authority failure")
	}
}

func writeCanonical(w http.ResponseWriter, status int, value canonicaljson.Value) {
	body, err := canonicaljson.Encode(value)
	if err != nil {
		writeFallbackInternal(w)
		return
	}
	writeExactJSON(w, status, append(body, '\n'))
}

func writeExactJSON(w http.ResponseWriter, status int, body []byte) {
	if len(body) > MaxResponseBodyBytes {
		writeFallbackInternal(w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeFailure(w http.ResponseWriter, status int, code, message string) {
	writeCanonical(w, status, canonicaljson.Object{
		"schema": "openslack.workflow_control_authority_error.v1", "code": code, "message": message,
	})
}

func writeFallbackInternal(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte("{\"code\":\"WORKFLOW_CONTROL_AUTHORITY_INTERNAL\",\"message\":\"internal authority failure\",\"schema\":\"openslack.workflow_control_authority_error.v1\"}\n"))
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
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}

func canonicalTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func pointerStringEqual(left, right *string) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func pointerInt64Equal(left, right *int64) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}
