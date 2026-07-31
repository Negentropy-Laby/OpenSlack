package graphstore

import (
	"errors"
	"fmt"
)

type ErrorCode string

const (
	ErrorInvalidInput        ErrorCode = "GRAPH_STORE_INPUT_INVALID"
	ErrorContentInvalid      ErrorCode = "GRAPH_STORE_CONTENT_INVALID"
	ErrorCursorConflict      ErrorCode = "GRAPH_STORE_CURSOR_CONFLICT"
	ErrorIdempotencyConflict ErrorCode = "GRAPH_STORE_IDEMPOTENCY_CONFLICT"
	ErrorNotFound            ErrorCode = "GRAPH_STORE_NOT_FOUND"
	ErrorDatabase            ErrorCode = "GRAPH_STORE_DATABASE_ERROR"
	ErrorCommitUnknown       ErrorCode = "GRAPH_STORE_COMMIT_OUTCOME_UNKNOWN"
)

type Error struct {
	Code      ErrorCode
	Operation string
	Err       error
}

func (value *Error) Error() string {
	if value.Operation == "" {
		return string(value.Code)
	}
	if value.Err == nil {
		return fmt.Sprintf("%s: %s", value.Code, value.Operation)
	}
	return fmt.Sprintf("%s: %s: %v", value.Code, value.Operation, value.Err)
}

func (value *Error) Unwrap() error { return value.Err }

func IsCode(err error, code ErrorCode) bool {
	var storeError *Error
	return errors.As(err, &storeError) && storeError.Code == code
}

func Failure(code ErrorCode, operation string, err error) error {
	return &Error{Code: code, Operation: operation, Err: err}
}
