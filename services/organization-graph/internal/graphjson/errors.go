package graphjson

import "fmt"

// ErrorCode is the stable strict-JSON failure category.
type ErrorCode string

const (
	ErrorUTF8Invalid  ErrorCode = "GRAPH_JSON_UTF8_INVALID"
	ErrorBOMForbidden ErrorCode = "GRAPH_JSON_BOM_FORBIDDEN"
	ErrorSyntax       ErrorCode = "GRAPH_JSON_SYNTAX_INVALID"
	ErrorDuplicateKey ErrorCode = "GRAPH_JSON_DUPLICATE_KEY"
	ErrorLimit        ErrorCode = "GRAPH_JSON_LIMIT_EXCEEDED"
)

// Error reports a stable category and UTF-16 source code-unit offset.
type Error struct {
	Code    ErrorCode
	Offset  int
	Message string
}

func (failure *Error) Error() string {
	if failure.Message == "" {
		return fmt.Sprintf("%s at UTF-16 offset %d", failure.Code, failure.Offset)
	}
	return fmt.Sprintf("%s at UTF-16 offset %d: %s", failure.Code, failure.Offset, failure.Message)
}

func fail(code ErrorCode, offset int, message string) error {
	return &Error{Code: code, Offset: offset, Message: message}
}

type CanonicalErrorCode string

const (
	CanonicalNonFinite   CanonicalErrorCode = "CANONICAL_JSON_NON_FINITE_NUMBER"
	CanonicalUnsupported CanonicalErrorCode = "CANONICAL_JSON_UNSUPPORTED_TYPE"
	CanonicalForbidden   CanonicalErrorCode = "CANONICAL_JSON_FORBIDDEN_KEY"
	CanonicalUndefined   CanonicalErrorCode = "CANONICAL_JSON_UNDEFINED"
	CanonicalSparseArray CanonicalErrorCode = "CANONICAL_JSON_SPARSE_ARRAY"
)

type CanonicalError struct {
	Code    CanonicalErrorCode
	Path    string
	Message string
}

func (failure *CanonicalError) Error() string {
	return fmt.Sprintf("%s at %s: %s", failure.Code, failure.Path, failure.Message)
}

func canonicalFail(code CanonicalErrorCode, path, message string) error {
	return &CanonicalError{Code: code, Path: path, Message: message}
}
