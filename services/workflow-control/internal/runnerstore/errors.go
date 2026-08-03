package runnerstore

import (
	"errors"
	"fmt"
)

type ErrorCode string

const (
	ErrorInputInvalid        ErrorCode = "WORKFLOW_RUNNER_INVALID_MESSAGE"
	ErrorUnknownField        ErrorCode = "WORKFLOW_RUNNER_UNKNOWN_FIELD"
	ErrorLimitExceeded       ErrorCode = "WORKFLOW_RUNNER_LIMIT_EXCEEDED"
	ErrorIdentityMismatch    ErrorCode = "WORKFLOW_RUNNER_IDENTITY_MISMATCH"
	ErrorHashMismatch        ErrorCode = "WORKFLOW_RUNNER_HASH_MISMATCH"
	ErrorIdempotencyConflict ErrorCode = "WORKFLOW_RUNNER_IDEMPOTENCY_CONFLICT"
	ErrorSequenceConflict    ErrorCode = "WORKFLOW_RUNNER_SEQUENCE_CONFLICT"
	ErrorLeaseExpired        ErrorCode = "WORKFLOW_RUNNER_LEASE_EXPIRED"
	ErrorStaleFence          ErrorCode = "WORKFLOW_RUNNER_STALE_FENCE"
	ErrorControlExpired      ErrorCode = "WORKFLOW_RUNNER_CONTROL_EXPIRED"
	ErrorProcessCrash        ErrorCode = "WORKFLOW_RUNNER_PROCESS_CRASH"
	ErrorTimeout             ErrorCode = "WORKFLOW_RUNNER_TIMEOUT"
	ErrorCommitUnknown       ErrorCode = "WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN"
	ErrorReconciliation      ErrorCode = "WORKFLOW_RUNNER_RECONCILIATION_REQUIRED"
	ErrorNotFound            ErrorCode = "WORKFLOW_RUNNER_NOT_FOUND"
	ErrorNoWork              ErrorCode = "WORKFLOW_RUNNER_NO_WORK"
	ErrorConflict            ErrorCode = "WORKFLOW_RUNNER_CONFLICT"
	ErrorDatabase            ErrorCode = "WORKFLOW_RUNNER_DATABASE_UNAVAILABLE"
)

type Error struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (value *Error) Error() string {
	if value.Cause == nil {
		return fmt.Sprintf("%s: %s", value.Code, value.Message)
	}
	return fmt.Sprintf("%s: %s: %v", value.Code, value.Message, value.Cause)
}

func (value *Error) Unwrap() error { return value.Cause }

func Failure(code ErrorCode, message string, cause error) error {
	return &Error{Code: code, Message: message, Cause: cause}
}

func IsCode(err error, code ErrorCode) bool {
	var value *Error
	return errors.As(err, &value) && value.Code == code
}
