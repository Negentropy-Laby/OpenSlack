package authoritycontract

import "fmt"

// ErrorCode is the closed Workflow Control authority-contract failure
// vocabulary. These failures prove validation parity only; they never imply
// that Go accepted, persisted, or executed a workflow mutation.
type ErrorCode string

const (
	ErrorInvalid                ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_INVALID"
	ErrorUnknownField           ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_UNKNOWN_FIELD"
	ErrorLimitExceeded          ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_LIMIT_EXCEEDED"
	ErrorUnsupportedVersion     ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_UNSUPPORTED_VERSION"
	ErrorInvalidTransition      ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_INVALID_TRANSITION"
	ErrorApprovalPlaneMismatch  ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_APPROVAL_PLANE_MISMATCH"
	ErrorInvalidDecimal         ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_INVALID_DECIMAL"
	ErrorDecimalOverflow        ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_DECIMAL_OVERFLOW"
	ErrorIdentityMismatch       ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH"
	ErrorHashMismatch           ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_HASH_MISMATCH"
	ErrorIdempotencyConflict    ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_IDEMPOTENCY_CONFLICT"
	ErrorStaleRevision          ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_STALE_REVISION"
	ErrorStaleResumeGeneration  ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_STALE_RESUME_GENERATION"
	ErrorStaleFence             ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_STALE_FENCE"
	ErrorReconciliationRequired ErrorCode = "WORKFLOW_CONTROL_AUTHORITY_RECONCILIATION_REQUIRED"
)

var errorCodes = []ErrorCode{
	ErrorInvalid, ErrorUnknownField, ErrorLimitExceeded, ErrorUnsupportedVersion,
	ErrorInvalidTransition, ErrorApprovalPlaneMismatch, ErrorInvalidDecimal,
	ErrorDecimalOverflow, ErrorIdentityMismatch, ErrorHashMismatch,
	ErrorIdempotencyConflict, ErrorStaleRevision, ErrorStaleResumeGeneration,
	ErrorStaleFence, ErrorReconciliationRequired,
}

func ErrorCodes() []ErrorCode { return append([]ErrorCode(nil), errorCodes...) }

type ContractError struct {
	Code    ErrorCode
	Path    string
	Message string
}

func (err *ContractError) Error() string {
	return fmt.Sprintf("%s at %s: %s", err.Code, err.Path, err.Message)
}

func failure(code ErrorCode, path, message string) error {
	return &ContractError{Code: code, Path: path, Message: message}
}
