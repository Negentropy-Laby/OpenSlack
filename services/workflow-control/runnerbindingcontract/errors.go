package runnerbindingcontract

import (
	"errors"
	"fmt"
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

// ErrorCode is the closed GS9-F2a validation failure vocabulary.
type ErrorCode string

const (
	ErrorInvalid                  ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID"
	ErrorUnknownField             ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_UNKNOWN_FIELD"
	ErrorLimitExceeded            ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED"
	ErrorUnsupportedVersion       ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_UNSUPPORTED_VERSION"
	ErrorIdentityMismatch         ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH"
	ErrorHashMismatch             ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_HASH_MISMATCH"
	ErrorSequenceConflict         ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_SEQUENCE_CONFLICT"
	ErrorRevisionConflict         ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_REVISION_CONFLICT"
	ErrorResumeGenerationConflict ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_RESUME_GENERATION_CONFLICT"
	ErrorAuthorityPlaneMismatch   ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH"
	ErrorStageRequired            ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_REQUIRED"
	ErrorResolutionRequired       ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_RESOLUTION_REQUIRED"
	ErrorIdempotencyConflict      ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_IDEMPOTENCY_CONFLICT"
	ErrorForbiddenField           ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_FORBIDDEN_FIELD"
	ErrorReconciliationRequired   ErrorCode = "WORKFLOW_RUNNER_AUTHORITY_BINDING_RECONCILIATION_REQUIRED"
)

// ContractError is stable across Go consumers and TypeScript golden vectors.
type ContractError struct {
	Code    ErrorCode `json:"code"`
	Path    string    `json:"path"`
	Message string    `json:"message"`
}

func (err *ContractError) Error() string {
	return fmt.Sprintf("%s at %s: %s", err.Code, err.Path, err.Message)
}

func failure(code ErrorCode, path, message string) error {
	return &ContractError{Code: code, Path: path, Message: message}
}

func nestedContractPath(prefix, path string) string {
	if path == "$" {
		return prefix
	}
	if strings.HasPrefix(path, "$/") {
		return prefix + strings.TrimPrefix(path, "$")
	}
	return prefix
}

func embeddedBudgetFailure(err error, path string) error {
	var contractErr *budgetcontract.ContractError
	if errors.As(err, &contractErr) {
		return failure(
			ErrorInvalid,
			nestedContractPath(path, contractErr.Path),
			"Embedded budget evidence is invalid.",
		)
	}
	return err
}

func ErrorCodes() []ErrorCode {
	return []ErrorCode{
		ErrorInvalid,
		ErrorUnknownField,
		ErrorLimitExceeded,
		ErrorUnsupportedVersion,
		ErrorIdentityMismatch,
		ErrorHashMismatch,
		ErrorSequenceConflict,
		ErrorRevisionConflict,
		ErrorResumeGenerationConflict,
		ErrorAuthorityPlaneMismatch,
		ErrorStageRequired,
		ErrorResolutionRequired,
		ErrorIdempotencyConflict,
		ErrorForbiddenField,
		ErrorReconciliationRequired,
	}
}
