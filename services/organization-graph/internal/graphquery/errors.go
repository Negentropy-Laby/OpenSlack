package graphquery

import "fmt"

type ErrorCode string

const (
	ErrorInvalid        ErrorCode = "GRAPH_QUERY_INVALID"
	ErrorCursorInvalid  ErrorCode = "GRAPH_QUERY_CURSOR_INVALID"
	ErrorCursorExpired  ErrorCode = "GRAPH_QUERY_CURSOR_EXPIRED"
	ErrorCursorMismatch ErrorCode = "GRAPH_QUERY_CURSOR_MISMATCH"
	ErrorTargetNotFound ErrorCode = "GRAPH_QUERY_TARGET_NOT_FOUND"
	ErrorPathNotFound   ErrorCode = "GRAPH_QUERY_PATH_NOT_FOUND"
)

type Error struct {
	Code    ErrorCode
	Message string
}

func (value *Error) Error() string { return fmt.Sprintf("%s: %s", value.Code, value.Message) }

func failure(code ErrorCode, message string) error { return &Error{Code: code, Message: message} }
