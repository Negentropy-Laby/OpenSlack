package checkpointshadowstore

import (
	"errors"
	"fmt"
)

type ErrorCode string

const (
	ErrorInputInvalid        ErrorCode = "WORKFLOW_CHECKPOINT_SHADOW_INPUT_INVALID"
	ErrorContentInvalid      ErrorCode = "WORKFLOW_CHECKPOINT_SHADOW_CONTENT_INVALID"
	ErrorConflict            ErrorCode = "WORKFLOW_CHECKPOINT_SHADOW_CONFLICT"
	ErrorIdempotencyConflict ErrorCode = "WORKFLOW_CHECKPOINT_SHADOW_IDEMPOTENCY_CONFLICT"
	ErrorNotFound            ErrorCode = "WORKFLOW_CHECKPOINT_SHADOW_NOT_FOUND"
	ErrorIntegrity           ErrorCode = "WORKFLOW_CHECKPOINT_SHADOW_INTEGRITY_ERROR"
	ErrorDatabase            ErrorCode = "WORKFLOW_CHECKPOINT_SHADOW_DATABASE_ERROR"
	ErrorCommitUnknown       ErrorCode = "WORKFLOW_CHECKPOINT_SHADOW_COMMIT_OUTCOME_UNKNOWN"
)

type Error struct {
	Code      ErrorCode
	Operation string
	Err       error
}

func (e *Error) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("%s: %s", e.Code, e.Operation)
	}
	return fmt.Sprintf("%s: %s: %v", e.Code, e.Operation, e.Err)
}
func (e *Error) Unwrap() error { return e.Err }
func Failure(code ErrorCode, operation string, err error) error {
	return &Error{Code: code, Operation: operation, Err: err}
}
func IsCode(err error, code ErrorCode) bool {
	var target *Error
	return errors.As(err, &target) && target.Code == code
}
