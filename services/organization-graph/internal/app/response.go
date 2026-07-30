package app

import (
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

const (
	errorNotFound      = "GRAPH_NOT_FOUND"
	errorConflict      = "GRAPH_CONFLICT"
	errorTooLarge      = "GRAPH_REQUEST_TOO_LARGE"
	errorUnprocessable = "GRAPH_UNPROCESSABLE"
	errorUnavailable   = "GRAPH_UNAVAILABLE"
	errorInternal      = "GRAPH_INTERNAL"

	MaxResponseBodyBytes = 8 * 1024 * 1024
)

var (
	integrityPattern   = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	fingerprintPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

func writeCanonical(w http.ResponseWriter, status int, value graph.Value) bool {
	body, err := graph.CanonicalJSON(value)
	if err != nil || len(body) > MaxResponseBodyBytes {
		return false
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
	return true
}

func writeFailure(w http.ResponseWriter, status int, code, message string) {
	if writeCanonical(w, status, graph.Object{
		"schema":  ErrorSchema,
		"code":    code,
		"message": message,
	}) {
		return
	}
	http.Error(w, "internal error", http.StatusInternalServerError)
}

func writeMappedError(w http.ResponseWriter, logger *slog.Logger, err error, operation string, metrics *counters) {
	var tooLarge requestTooLargeError
	if errors.As(err, &tooLarge) {
		writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "request exceeds a frozen service limit")
		return
	}
	var requestFailure requestValidationError
	if errors.As(err, &requestFailure) {
		writeFailure(w, http.StatusUnprocessableEntity, errorUnprocessable, requestFailure.message)
		return
	}
	var jsonFailure *graph.JSONError
	if errors.As(err, &jsonFailure) {
		if jsonFailure.Code == graph.JSONLimitExceeded {
			writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "request exceeds a frozen JSON limit")
		} else {
			writeFailure(w, http.StatusUnprocessableEntity, errorUnprocessable, "request is not strict JSON")
		}
		return
	}
	var contractFailure *graph.ContractError
	if errors.As(err, &contractFailure) {
		if contractFailure.Code == graph.ContractBoundExceeded {
			writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "graph record exceeds a frozen contract limit")
		} else {
			writeFailure(w, http.StatusUnprocessableEntity, errorUnprocessable, "graph contract validation failed")
		}
		return
	}
	var queryFailure *graph.QueryError
	if errors.As(err, &queryFailure) {
		switch queryFailure.Code {
		case graph.QueryTargetNotFound, graph.QueryPathNotFound:
			writeFailure(w, http.StatusNotFound, errorNotFound, "graph query target was not found")
		default:
			writeFailure(w, http.StatusUnprocessableEntity, errorUnprocessable, "graph query validation failed")
		}
		return
	}
	var storeFailure *StoreError
	if errors.As(err, &storeFailure) {
		switch storeFailure.Code {
		case StoreNotFound:
			writeFailure(w, http.StatusNotFound, errorNotFound, "graph scenario or head was not found")
		case StoreConflict:
			if operation != "" {
				metrics.recordConflict(operation)
			}
			writeFailure(w, http.StatusConflict, errorConflict, "graph head or idempotency precondition conflicted")
		case StoreIdempotencyConflict:
			if operation != "" {
				metrics.recordIdempotencyConflict(operation)
			}
			writeFailure(w, http.StatusConflict, errorConflict, "graph head or idempotency precondition conflicted")
		case StoreUnprocessable:
			writeFailure(w, http.StatusUnprocessableEntity, errorUnprocessable, "graph transition validation failed")
		case StoreTooLarge:
			writeFailure(w, http.StatusRequestEntityTooLarge, errorTooLarge, "graph record exceeds a frozen service limit")
		case StoreUnavailable:
			writeFailure(w, http.StatusServiceUnavailable, errorUnavailable, "graph store is unavailable")
		default:
			logger.Error(
				"graph_store_unmapped_failure",
				"store_error_code", storeFailure.Code,
				"operation", operation,
			)
			writeFailure(w, http.StatusInternalServerError, errorInternal, "internal graph service failure")
		}
		return
	}
	logger.Error("graph_http_unmapped_failure", "operation", operation)
	writeFailure(w, http.StatusInternalServerError, errorInternal, "internal graph service failure")
}

func validateReceipt(receipt Receipt, operation string) bool {
	if receipt.Operation != operation ||
		(receipt.Status != ReceiptAccepted &&
			receipt.Status != ReceiptDuplicate &&
			receipt.Status != ReceiptReconciliationRequired) ||
		receipt.IdempotencyKey == "" ||
		!fingerprintPattern.MatchString(receipt.RequestFingerprint) ||
		!boundedIdentifier(receipt.ScenarioInstanceID) ||
		!boundedIdentifier(receipt.Cursor) ||
		receipt.Revision < 1 ||
		receipt.Revision > maxSafeJSONInteger ||
		!integrityPattern.MatchString(receipt.SnapshotIntegrityHash) {
		return false
	}
	if operation == OperationDeltaIngest {
		if receipt.DeltaIntegrityHash == nil || !integrityPattern.MatchString(*receipt.DeltaIntegrityHash) {
			return false
		}
	} else if receipt.DeltaIntegrityHash != nil {
		return false
	}
	if receipt.Status == ReceiptReconciliationRequired {
		return receipt.ReconciliationToken != nil &&
			boundedIdentifier(*receipt.ReconciliationToken) &&
			receipt.CommittedAt == nil
	}
	if receipt.ReconciliationToken != nil || receipt.CommittedAt == nil {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, *receipt.CommittedAt)
	return err == nil
}

func receiptValue(receipt Receipt) graph.Object {
	result := graph.Object{
		"schema":                ReceiptSchema,
		"operation":             receipt.Operation,
		"status":                receipt.Status,
		"idempotencyKey":        receipt.IdempotencyKey,
		"requestFingerprint":    receipt.RequestFingerprint,
		"scenarioInstanceId":    receipt.ScenarioInstanceID,
		"cursor":                receipt.Cursor,
		"revision":              float64(receipt.Revision),
		"snapshotIntegrityHash": receipt.SnapshotIntegrityHash,
	}
	if receipt.DeltaIntegrityHash != nil {
		result["deltaIntegrityHash"] = *receipt.DeltaIntegrityHash
	}
	if receipt.CommittedAt != nil {
		result["committedAt"] = *receipt.CommittedAt
	}
	if receipt.ReconciliationToken != nil {
		result["reconciliationToken"] = *receipt.ReconciliationToken
	}
	return result
}

func receiptHTTPStatus(status string) int {
	switch status {
	case ReceiptAccepted:
		return http.StatusCreated
	case ReceiptDuplicate:
		return http.StatusOK
	case ReceiptReconciliationRequired:
		return http.StatusAccepted
	default:
		return http.StatusInternalServerError
	}
}
