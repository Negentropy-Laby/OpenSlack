package budgetapp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

func (service *Service) handleReserve(w http.ResponseWriter, request *http.Request) {
	service.handleMutation(w, request, "reserve")
}

func (service *Service) handleSettle(w http.ResponseWriter, request *http.Request) {
	service.handleMutation(w, request, "settle")
}

func (service *Service) handleMutation(w http.ResponseWriter, request *http.Request, operation string) {
	ctx, cancel := context.WithTimeout(request.Context(), requestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if !requireNoQuery(w, request) {
		return
	}
	contentType, contentOK := oneHeader(request, "Content-Type")
	key, keyOK := oneHeader(request, "Idempotency-Key")
	fingerprint, fingerprintOK := oneHeader(request, HeaderFingerprint)
	if !contentOK || contentType != "application/json" {
		writeFailure(w, http.StatusUnsupportedMediaType, "WORKFLOW_CONTROL_BUDGET_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be one application/json value")
		return
	}
	if !keyOK || !fingerprintOK || budgetstore.ValidateReceiptKey(key) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, string(budgetstore.ErrorInputInvalid), "budget idempotency headers are invalid")
		return
	}
	body, readErr := readBoundedBody(w, request)
	if readErr != nil {
		var maximum *http.MaxBytesError
		switch {
		case errors.As(readErr, &maximum):
			writeFailure(w, http.StatusRequestEntityTooLarge, "WORKFLOW_CONTROL_BUDGET_TOO_LARGE", "budget request exceeds the frozen byte limit")
		case ctx.Err() != nil:
			writeFailure(w, http.StatusRequestTimeout, "WORKFLOW_CONTROL_BUDGET_TIMEOUT", "budget request deadline exceeded")
		default:
			writeFailure(w, http.StatusBadRequest, "WORKFLOW_CONTROL_BUDGET_READ_FAILED", "budget request body could not be read")
		}
		return
	}
	prepared, validatedRequest, err := budgetcontract.PrepareRequestBytes(operation, body, service.callerID)
	if err != nil {
		writeContractError(w, err)
		return
	}
	if prepared.Path != request.URL.Path || prepared.IdempotencyKey != key || prepared.RequestFingerprint != fingerprint {
		writeFailure(w, http.StatusUnprocessableEntity, string(budgetstore.ErrorContentInvalid), "budget request is not exact canonical JSON plus LF or its headers drifted")
		return
	}
	validatedRequest, err = validateQualificationRequest(validatedRequest, service.workspaceID)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	input := budgetstore.MutationInput{Prepared: prepared, ServiceBuildHash: service.buildSHA, Seed: service.seed}
	var result budgetstore.MutationResult
	if operation == "reserve" {
		result, err = service.repository.Reserve(ctx, input)
	} else {
		result, err = service.repository.Settle(ctx, input)
	}
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	expectedReceiptBuild := validatedRequest["route"].(budgetcontract.Record)["authorityBuildHash"].(string)
	response, resultErr := validateMutationResult(result, prepared, service.workspaceID, expectedReceiptBuild)
	if resultErr != nil {
		service.logger.Error("workflow_control_budget_invalid_store_result", "operation", operation, "validation", resultErr.Error())
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_BUDGET_INTERNAL", "budget repository returned an invalid durable result")
		return
	}
	status := http.StatusCreated
	if result.Replay {
		status = http.StatusOK
		service.replays.Add(1)
		w.Header().Set(HeaderReplay, "true")
	} else {
		outcome, outcomeErr := classifyFreshMutation(operation, response)
		if outcomeErr != nil {
			writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_BUDGET_INTERNAL", "budget repository returned an invalid result status")
			return
		}
		switch outcome {
		case freshProviderReconciliation:
			status = http.StatusAccepted
			service.providerReconciliations.Add(1)
		case freshDatabaseReconciliation:
			status = http.StatusAccepted
			service.databaseReconciliations.Add(1)
		case freshReserveReserved:
			service.reservesReserved.Add(1)
		case freshReserveRejected:
			service.reservesRejected.Add(1)
		case freshSettlementSettled:
			service.settlementsSettled.Add(1)
		}
	}
	writeExactJSON(w, status, result.ExactResponseBytes)
}

type freshMutationOutcome string

const (
	freshReserveReserved        freshMutationOutcome = "reserve_reserved"
	freshReserveRejected        freshMutationOutcome = "reserve_rejected"
	freshSettlementSettled      freshMutationOutcome = "settlement_settled"
	freshProviderReconciliation freshMutationOutcome = "provider_reconciliation"
	freshDatabaseReconciliation freshMutationOutcome = "database_reconciliation"
)

func classifyFreshMutation(operation string, response budgetstore.MutationResponse) (freshMutationOutcome, error) {
	receiptStatus, _ := response.Receipt.OperationalProjection["status"].(string)
	recordStatus := ""
	if response.Record != nil {
		recordStatus, _ = response.Record.OperationalProjection["status"].(string)
	}
	switch {
	case receiptStatus == "provider_reconciliation_required" && operation == "settle" && recordStatus == "reconciliation_required":
		return freshProviderReconciliation, nil
	case receiptStatus == "database_reconciliation_required" && response.Record == nil:
		return freshDatabaseReconciliation, nil
	case receiptStatus == "accepted" && operation == "reserve" && recordStatus == "reserved":
		return freshReserveReserved, nil
	case receiptStatus == "accepted" && operation == "reserve" && recordStatus == "rejected":
		return freshReserveRejected, nil
	case receiptStatus == "accepted" && operation == "settle" && recordStatus == "settled":
		return freshSettlementSettled, nil
	default:
		return "", fmt.Errorf("unsupported fresh mutation status combination")
	}
}

func validateQualificationRequest(request budgetcontract.Record, workspaceID string) (budgetcontract.Record, error) {
	if request["workspaceId"] != workspaceID {
		return nil, budgetstore.Failure(budgetstore.ErrorContentInvalid, "budget request workspace binding is invalid", nil)
	}
	return request, nil
}

func validateMutationResult(result budgetstore.MutationResult, prepared budgetcontract.PreparedRequest, workspaceID, buildSHA string) (budgetstore.MutationResponse, error) {
	if result.Operation != prepared.Operation || len(result.ExactResponseBytes) == 0 || len(result.ExactResponseBytes) > maxResponseBodyBytes ||
		len(result.ExactReceiptBytes) == 0 || result.ReceiptID == "" {
		return budgetstore.MutationResponse{}, fmt.Errorf("result framing or operation mismatch")
	}
	response, err := budgetstore.DecodeMutationResponse(result.ExactResponseBytes)
	if err != nil || response.Operation != result.Operation || !durableRecordPointersEqual(response.Record, result.DurableRecord) ||
		!durableRecordsEqual(response.Receipt, result.DurableReceipt) ||
		!durableRecordPointersEqual(response.Reconciliation, result.DurableReconciliation) ||
		!mutationResponsesEqual(response, result.Response) {
		return budgetstore.MutationResponse{}, fmt.Errorf("closed response mismatch: %w", err)
	}
	receipt, err := budgetcontract.ValidateReceiptForRequest(response.Receipt.OperationalProjection, prepared)
	if err != nil || receipt["workspaceId"] != workspaceID || receipt["serviceBuildHash"] != buildSHA {
		return budgetstore.MutationResponse{}, fmt.Errorf("receipt request binding mismatch: %w", err)
	}
	if response.Receipt.AuthorityBuildHash != buildSHA || !exactDurableRecordBytes(result.ExactReceiptBytes, response.Receipt) ||
		!recordsEqual(response.Receipt.OperationalProjection, result.Receipt) {
		return budgetstore.MutationResponse{}, fmt.Errorf("exact receipt bytes mismatch")
	}
	if response.Reconciliation == nil {
		if len(result.ExactReconciliationBytes) != 0 {
			return budgetstore.MutationResponse{}, fmt.Errorf("unexpected exact reconciliation bytes")
		}
	} else if response.Reconciliation.AuthorityBuildHash != buildSHA ||
		!exactDurableRecordBytes(result.ExactReconciliationBytes, *response.Reconciliation) {
		return budgetstore.MutationResponse{}, fmt.Errorf("exact reconciliation bytes mismatch")
	}
	receiptStatus, _ := receipt["status"].(string)
	if receiptStatus == "database_reconciliation_required" {
		if response.Record != nil || response.Reconciliation == nil || result.DurableLedgerEntry != nil || result.LedgerEntry != nil || result.Record != nil ||
			!recordsEqual(response.Reconciliation.OperationalProjection, result.Reconciliation) {
			return budgetstore.MutationResponse{}, fmt.Errorf("database reconciliation shape mismatch")
		}
	} else {
		if response.Record == nil || result.DurableLedgerEntry == nil ||
			!recordsEqual(response.Record.OperationalProjection, result.Record) ||
			!recordsEqual(reconciliationProjection(response), result.Reconciliation) {
			return budgetstore.MutationResponse{}, fmt.Errorf("durable operational projection mismatch")
		}
		if _, err := budgetcontract.ValidateReceiptForResult(receipt, prepared, response.Record.OperationalProjection, result.LedgerEntry, reconciliationProjection(response)); err != nil {
			return budgetstore.MutationResponse{}, fmt.Errorf("durable result binding mismatch: %w", err)
		}
		if !exactDurableRecordBytes(result.ExactRecordBytes, *response.Record) || !exactDurableRecordBytes(result.ExactLedgerBytes, *result.DurableLedgerEntry) ||
			!recordsEqual(result.DurableLedgerEntry.OperationalProjection, result.LedgerEntry) || result.DurableLedgerEntry.AuthorityBuildHash != buildSHA {
			return budgetstore.MutationResponse{}, fmt.Errorf("exact record or ledger bytes mismatch")
		}
	}
	wantStatus := receiptStatus
	if response.Record != nil {
		wantStatus, _ = response.Record.OperationalProjection["status"].(string)
	}
	if result.Status != wantStatus {
		return budgetstore.MutationResponse{}, fmt.Errorf("result status mismatch")
	}
	return response, nil
}

func (service *Service) handleReadAccount(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	runID := request.PathValue("runId")
	if budgetstore.ValidateReadIdentity(service.workspaceID, runID) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, string(budgetstore.ErrorInputInvalid), "budget account identity is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	account, err := service.repository.ReadAccount(ctx, service.workspaceID, runID)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	outer, outerErr := budgetstore.ValidateDurableRecord(account.Durable)
	value, validateErr := budgetcontract.ValidateAccount(account.Value)
	if outerErr != nil || validateErr != nil || outer.RecordKind != budgetstore.RecordKindAccount || outer.AuthorityBuildHash != service.buildSHA ||
		value["workspaceId"] != service.workspaceID || value["runId"] != runID || !recordsEqual(outer.OperationalProjection, value) ||
		!exactDurableRecordBytes(account.ExactBytes, outer) {
		service.logger.Error("workflow_control_budget_invalid_stored_account")
		writeFailure(w, http.StatusInternalServerError, string(budgetstore.ErrorIntegrity), "stored budget account integrity check failed")
		return
	}
	// Durable account records are stored without transport framing. The HTTP
	// point-read contract uses exact canonical JSON followed by one LF, matching
	// the mutation and receipt response surfaces.
	writeExactJSON(w, http.StatusOK, append(append([]byte(nil), account.ExactBytes...), '\n'))
}

func (service *Service) handleReadReservation(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	runID, reservationID := request.PathValue("runId"), request.PathValue("reservationId")
	if budgetstore.ValidateReadIdentity(service.workspaceID, runID, reservationID) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, string(budgetstore.ErrorInputInvalid), "budget reservation identity is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	reservation, err := service.repository.ReadReservation(ctx, service.workspaceID, runID, reservationID)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	outer, outerErr := budgetstore.ValidateDurableRecord(reservation.Durable)
	value, validateErr := budgetcontract.ValidateReservation(reservation.Value)
	if outerErr != nil || validateErr != nil || outer.RecordKind != budgetstore.RecordKindReservation || outer.AuthorityBuildHash != service.buildSHA ||
		value["workspaceId"] != service.workspaceID || value["runId"] != runID || value["reservationId"] != reservationID ||
		!recordsEqual(outer.OperationalProjection, value) || !exactDurableRecordBytes(reservation.ExactBytes, outer) ||
		!validReservationReadMetadata(reservation) {
		service.logger.Error("workflow_control_budget_invalid_stored_reservation")
		writeFailure(w, http.StatusInternalServerError, string(budgetstore.ErrorIntegrity), "stored budget reservation integrity check failed")
		return
	}
	var terminalLedgerEntryID, closedAt any
	if reservation.TerminalLedgerEntryID != nil {
		terminalLedgerEntryID = *reservation.TerminalLedgerEntryID
	}
	if reservation.ClosedAt != nil {
		closedAt = canonicalTimestamp(*reservation.ClosedAt)
	}
	writeCanonical(w, http.StatusOK, canonicaljson.Object{
		"schema":      "openslack.workflow_control_budget_reservation_read.v1",
		"reservation": outer, "status": reservation.Status,
		"terminalLedgerEntryId": terminalLedgerEntryID, "closedAt": closedAt,
	})
}

func (service *Service) handleReadReceipt(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	key := request.PathValue("idempotencyKey")
	if budgetstore.ValidateReceiptKey(key) != nil {
		writeFailure(w, http.StatusUnprocessableEntity, string(budgetstore.ErrorInputInvalid), "budget receipt identity is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	receipt, err := service.repository.ReadReceipt(ctx, service.workspaceID, key)
	if err != nil {
		service.writeStoreError(w, err)
		return
	}
	outer, outerErr := budgetstore.ValidateDurableRecord(receipt.Durable)
	value, validateErr := budgetcontract.ValidateReceipt(receipt.Value)
	response, responseErr := budgetstore.DecodeMutationResponse(receipt.ExactResponseBytes)
	if outerErr != nil || validateErr != nil || responseErr != nil || outer.RecordKind != budgetstore.RecordKindReceipt || outer.AuthorityBuildHash != service.buildSHA ||
		value["workspaceId"] != service.workspaceID || value["idempotencyKey"] != key || !recordsEqual(outer.OperationalProjection, value) ||
		!exactDurableRecordBytes(receipt.ExactReceiptBytes, outer) || !durableRecordsEqual(response.Receipt, outer) ||
		!mutationResponsesEqual(response, receipt.Response) {
		service.logger.Error("workflow_control_budget_invalid_stored_receipt")
		writeFailure(w, http.StatusInternalServerError, string(budgetstore.ErrorIntegrity), "stored budget receipt integrity check failed")
		return
	}
	writeExactJSON(w, http.StatusOK, receipt.ExactResponseBytes)
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
	ctx, cancel := context.WithTimeout(request.Context(), metricsRepositoryTimeout)
	defer cancel()
	if err := service.repository.Ready(ctx); err != nil {
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
		"schema":          "openslack.workflow_control_budget_authority_service_version.v1",
		"contractVersion": "v1", "buildSha": service.buildSHA,
		"mode":                                         map[bool]string{false: "disabled", true: "local-qualification-v1"}[service.qualificationMode],
		"qualificationMode":                            service.qualificationMode,
		"typescriptProductionWorkflowAuthority":        true,
		"goBudgetAuthority":                            "qualification-only",
		"productionBudgetAuthority":                    false,
		"qualificationSeedConfigured":                  service.qualificationMode,
		"productionInitialBudgetPolicySourceDelivered": false,
		"runnerProtocolV2Delivered":                    false,
		"routingActivated":                             false, "canaryActivated": false, "cutoverActivated": false,
	})
}

func (service *Service) handleMetrics(w http.ResponseWriter, request *http.Request) {
	if !requireReadEnvelope(w, request) {
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), metricsRepositoryTimeout)
	defer cancel()
	statistics, err := service.repository.Statistics(ctx)
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("metrics unavailable\n"))
		return
	}
	lines := make([]string, 0, len(budgetMetricDefinitions)*2)
	for _, metric := range budgetMetricDefinitions {
		lines = append(lines, "# TYPE "+metric.name+" "+metric.kind, metric.name+" "+strconv.FormatInt(metric.value(service, statistics), 10))
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(joinLines(lines)))
}

type budgetMetricDefinition struct {
	name  string
	kind  string
	value func(*Service, budgetstore.Statistics) int64
}

var budgetMetricDefinitions = []budgetMetricDefinition{
	{name: "openslack_workflow_control_budget_http_requests_total", kind: "counter", value: func(service *Service, _ budgetstore.Statistics) int64 { return service.requests.Load() }},
	{name: "openslack_workflow_control_budget_http_unauthorized_total", kind: "counter", value: func(service *Service, _ budgetstore.Statistics) int64 { return service.unauthorized.Load() }},
	{name: "openslack_workflow_control_budget_reserves_reserved_total", kind: "counter", value: func(service *Service, _ budgetstore.Statistics) int64 { return service.reservesReserved.Load() }},
	{name: "openslack_workflow_control_budget_reserves_rejected_total", kind: "counter", value: func(service *Service, _ budgetstore.Statistics) int64 { return service.reservesRejected.Load() }},
	{name: "openslack_workflow_control_budget_settlements_settled_total", kind: "counter", value: func(service *Service, _ budgetstore.Statistics) int64 { return service.settlementsSettled.Load() }},
	{name: "openslack_workflow_control_budget_provider_reconciliation_total", kind: "counter", value: func(service *Service, _ budgetstore.Statistics) int64 { return service.providerReconciliations.Load() }},
	{name: "openslack_workflow_control_budget_database_reconciliation_total", kind: "counter", value: func(service *Service, _ budgetstore.Statistics) int64 { return service.databaseReconciliations.Load() }},
	{name: "openslack_workflow_control_budget_replays_total", kind: "counter", value: func(service *Service, _ budgetstore.Statistics) int64 { return service.replays.Load() }},
	{name: "openslack_workflow_control_budget_accounts", kind: "gauge", value: func(_ *Service, statistics budgetstore.Statistics) int64 { return statistics.Accounts }},
	{name: "openslack_workflow_control_budget_reservations", kind: "gauge", value: func(_ *Service, statistics budgetstore.Statistics) int64 { return statistics.Reservations }},
	{name: "openslack_workflow_control_budget_open_reservations", kind: "gauge", value: func(_ *Service, statistics budgetstore.Statistics) int64 { return statistics.OpenReservations }},
	{name: "openslack_workflow_control_budget_ledger_entries", kind: "gauge", value: func(_ *Service, statistics budgetstore.Statistics) int64 { return statistics.LedgerEntries }},
	{name: "openslack_workflow_control_budget_receipts", kind: "gauge", value: func(_ *Service, statistics budgetstore.Statistics) int64 { return statistics.Receipts }},
	{name: "openslack_workflow_control_budget_database_reconciliation_pending", kind: "gauge", value: func(_ *Service, statistics budgetstore.Statistics) int64 {
		return statistics.OpenDatabaseReconciliations
	}},
	{name: "openslack_workflow_control_budget_provider_reconciliations", kind: "gauge", value: func(_ *Service, statistics budgetstore.Statistics) int64 { return statistics.ProviderReconciliations }},
}

// MetricNames returns the closed Prometheus metric vocabulary in wire order.
func MetricNames() []string {
	names := make([]string, len(budgetMetricDefinitions))
	for index, metric := range budgetMetricDefinitions {
		names[index] = metric.name
	}
	return names
}

func requireNoQuery(w http.ResponseWriter, request *http.Request) bool {
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeFailure(w, http.StatusUnprocessableEntity, string(budgetstore.ErrorInputInvalid), "query parameters are forbidden")
		return false
	}
	return true
}

func requireReadEnvelope(w http.ResponseWriter, request *http.Request) bool {
	if !requireNoQuery(w, request) {
		return false
	}
	if request.ContentLength > 0 || len(request.TransferEncoding) != 0 {
		writeFailure(w, http.StatusUnprocessableEntity, string(budgetstore.ErrorInputInvalid), "read requests must not have a body")
		return false
	}
	return true
}

func readBoundedBody(w http.ResponseWriter, request *http.Request) ([]byte, error) {
	reader := http.MaxBytesReader(w, request.Body, budgetcontract.MaxRecordBytes)
	defer reader.Close()
	return io.ReadAll(reader)
}

func exactDurableRecordBytes(contents []byte, value budgetstore.DurableRecord) bool {
	if len(contents) == 0 {
		return false
	}
	canonical, err := budgetstore.EncodeDurableRecord(value)
	return err == nil && bytes.Equal(contents, canonical)
}

func recordsEqual(left, right budgetcontract.Record) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	leftJSON, leftErr := budgetcontract.CanonicalJSON(left)
	rightJSON, rightErr := budgetcontract.CanonicalJSON(right)
	return leftErr == nil && rightErr == nil && leftJSON == rightJSON
}

func durableRecordsEqual(left, right budgetstore.DurableRecord) bool {
	leftJSON, leftErr := budgetstore.EncodeDurableRecord(left)
	rightJSON, rightErr := budgetstore.EncodeDurableRecord(right)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func durableRecordPointersEqual(left, right *budgetstore.DurableRecord) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return durableRecordsEqual(*left, *right)
}

func mutationResponsesEqual(left, right budgetstore.MutationResponse) bool {
	leftJSON, leftErr := budgetstore.EncodeMutationResponse(left.Operation, left.Record, left.Receipt, left.Reconciliation)
	rightJSON, rightErr := budgetstore.EncodeMutationResponse(right.Operation, right.Record, right.Receipt, right.Reconciliation)
	return leftErr == nil && rightErr == nil && bytes.Equal(leftJSON, rightJSON)
}

func reconciliationProjection(value budgetstore.MutationResponse) budgetcontract.Record {
	if value.Reconciliation == nil {
		return nil
	}
	return value.Reconciliation.OperationalProjection
}

func validReservationReadMetadata(value budgetstore.Reservation) bool {
	switch value.Status {
	case "open":
		return value.TerminalLedgerEntryID == nil && value.ClosedAt == nil
	case "settled":
		return value.TerminalLedgerEntryID != nil && value.ClosedAt != nil &&
			budgetstore.ValidateReadIdentity(*value.TerminalLedgerEntryID) == nil &&
			value.ClosedAt.Equal(value.ClosedAt.UTC().Truncate(time.Millisecond))
	default:
		return false
	}
}

func canonicalTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func writeContractError(w http.ResponseWriter, err error) {
	var failure *budgetcontract.ContractError
	if errors.As(err, &failure) {
		writeFailure(w, http.StatusUnprocessableEntity, string(failure.Code), "budget request violates the frozen authority contract")
		return
	}
	writeFailure(w, http.StatusUnprocessableEntity, string(budgetstore.ErrorContentInvalid), "budget request is invalid")
}

func (service *Service) writeStoreError(w http.ResponseWriter, err error) {
	var failure *budgetstore.Error
	if !errors.As(err, &failure) {
		service.logger.Error("workflow_control_budget_unmapped_failure")
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_BUDGET_INTERNAL", "internal budget authority failure")
		return
	}
	switch failure.Code {
	case budgetstore.ErrorInputInvalid, budgetstore.ErrorContentInvalid:
		writeFailure(w, http.StatusUnprocessableEntity, string(failure.Code), "budget request is invalid")
	case budgetstore.ErrorConflict, budgetstore.ErrorIdempotencyConflict, budgetstore.ErrorReconciliation:
		writeFailure(w, http.StatusConflict, string(failure.Code), "budget authority precondition conflicted or requires reconciliation")
	case budgetstore.ErrorNotFound:
		writeFailure(w, http.StatusNotFound, string(failure.Code), "budget authority record was not found")
	case budgetstore.ErrorIntegrity:
		service.logger.Error("workflow_control_budget_integrity_failure")
		writeFailure(w, http.StatusInternalServerError, string(failure.Code), "stored budget authority integrity check failed")
	case budgetstore.ErrorDatabase:
		writeFailure(w, http.StatusServiceUnavailable, string(failure.Code), "budget authority repository is unavailable")
	case budgetstore.ErrorCommitUnknown:
		service.logger.Error("workflow_control_budget_commit_outcome_unknown")
		writeFailure(w, http.StatusInternalServerError, string(failure.Code), "budget authority commit outcome is unknown; reconcile with the same key")
	default:
		writeFailure(w, http.StatusInternalServerError, "WORKFLOW_CONTROL_BUDGET_INTERNAL", "internal budget authority failure")
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
	if len(body) == 0 || len(body) > maxResponseBodyBytes {
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
		"schema": "openslack.workflow_control_budget_authority_error.v1", "code": code, "message": message,
	})
}

func writeFallbackInternal(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte("{\"code\":\"WORKFLOW_CONTROL_BUDGET_INTERNAL\",\"message\":\"internal budget authority failure\",\"schema\":\"openslack.workflow_control_budget_authority_error.v1\"}\n"))
}

func joinLines(lines []string) string {
	var buffer bytes.Buffer
	for _, line := range lines {
		buffer.WriteString(line)
		buffer.WriteByte('\n')
	}
	return buffer.String()
}
