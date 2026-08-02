package canonicaljson

import "fmt"

type ErrorCode string

const (
	ErrorUTF8Invalid ErrorCode = "JSON_UTF8_INVALID"
	ErrorBOM         ErrorCode = "JSON_BOM_FORBIDDEN"
	ErrorSyntax      ErrorCode = "JSON_SYNTAX_INVALID"
	ErrorDuplicate   ErrorCode = "JSON_DUPLICATE_KEY"
	ErrorLimit       ErrorCode = "JSON_LIMIT_EXCEEDED"
	ErrorUnsupported ErrorCode = "JSON_VALUE_UNSUPPORTED"
	ErrorForbidden   ErrorCode = "JSON_KEY_FORBIDDEN"
)

type Error struct {
	Code    ErrorCode
	Offset  int
	Path    string
	Message string
}

func (value *Error) Error() string {
	if value.Path != "" {
		return fmt.Sprintf("%s at %s: %s", value.Code, value.Path, value.Message)
	}
	return fmt.Sprintf("%s at offset %d: %s", value.Code, value.Offset, value.Message)
}

func parseFail(code ErrorCode, offset int, message string) error {
	return &Error{Code: code, Offset: offset, Message: message}
}

func encodeFail(code ErrorCode, path, message string) error {
	return &Error{Code: code, Path: path, Message: message}
}
