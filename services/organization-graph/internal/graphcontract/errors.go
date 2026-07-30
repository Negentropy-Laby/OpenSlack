package graphcontract

import "fmt"

type ErrorCode string

const (
	ErrorSchemaInvalid    ErrorCode = "GRAPH_SCHEMA_INVALID"
	ErrorBoundExceeded    ErrorCode = "GRAPH_BOUND_EXCEEDED"
	ErrorScopeInvalid     ErrorCode = "GRAPH_SCOPE_INVALID"
	ErrorReferenceInvalid ErrorCode = "GRAPH_REFERENCE_INVALID"
	ErrorPropertyUnsafe   ErrorCode = "GRAPH_PROPERTY_UNSAFE"
	ErrorIntegrityInvalid ErrorCode = "GRAPH_INTEGRITY_INVALID"
)

type Error struct {
	Code    ErrorCode
	Path    string
	Message string
}

func (value *Error) Error() string {
	return fmt.Sprintf("%s at %s: %s", value.Code, value.Path, value.Message)
}

func failure(code ErrorCode, path, message string) error {
	return &Error{Code: code, Path: path, Message: message}
}
