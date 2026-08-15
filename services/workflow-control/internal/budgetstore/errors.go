package budgetstore

import (
	"errors"
	"fmt"
)

type ErrorCode string

const (
	ErrorInputInvalid        ErrorCode = "WORKFLOW_CONTROL_BUDGET_INPUT_INVALID"
	ErrorContentInvalid      ErrorCode = "WORKFLOW_CONTROL_BUDGET_CONTENT_INVALID"
	ErrorConflict            ErrorCode = "WORKFLOW_CONTROL_BUDGET_CONFLICT"
	ErrorIdempotencyConflict ErrorCode = "WORKFLOW_CONTROL_BUDGET_IDEMPOTENCY_CONFLICT"
	ErrorNotFound            ErrorCode = "WORKFLOW_CONTROL_BUDGET_NOT_FOUND"
	ErrorIntegrity           ErrorCode = "WORKFLOW_CONTROL_BUDGET_INTEGRITY_ERROR"
	ErrorDatabase            ErrorCode = "WORKFLOW_CONTROL_BUDGET_DATABASE_ERROR"
	ErrorCommitUnknown       ErrorCode = "WORKFLOW_CONTROL_BUDGET_COMMIT_OUTCOME_UNKNOWN"
	ErrorReconciliation      ErrorCode = "WORKFLOW_CONTROL_BUDGET_RECONCILIATION_REQUIRED"
)

type Error struct {
	Code      ErrorCode
	Operation string
	Err       error
}

func (value *Error) Error() string {
	if value.Err == nil {
		return fmt.Sprintf("%s: %s", value.Code, value.Operation)
	}
	return fmt.Sprintf("%s: %s: %v", value.Code, value.Operation, value.Err)
}

func (value *Error) Unwrap() error { return value.Err }

func Failure(code ErrorCode, operation string, err error) error {
	return &Error{Code: code, Operation: operation, Err: err}
}

func IsCode(err error, code ErrorCode) bool {
	var failure *Error
	return errors.As(err, &failure) && failure.Code == code
}
