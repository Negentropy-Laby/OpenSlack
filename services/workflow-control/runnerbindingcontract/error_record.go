package runnerbindingcontract

import (
	"regexp"
	"strings"
)

var errorMessagePattern = regexp.MustCompile(`^.{1,512}$`)

func ValidateErrorRecord(value any) (Record, error) {
	return validateErrorRecordWithSession(value, newBindingValidationSession(nil))
}

func validateErrorRecordWithSession(value any, session *bindingValidationSession) (Record, error) {
	record, err := closedRecord(value, []string{"schema", "code", "message", "bindingId", "operation", "reconciliationToken"}, "$")
	if err != nil {
		return nil, err
	}
	schema, err := literalString(record["schema"], ErrorSchema, "$/schema")
	if err != nil {
		return nil, err
	}
	code, err := errorCodeValue(record["code"], "$/code")
	if err != nil {
		return nil, err
	}
	message, err := textValue(record["message"], "$/message", errorMessagePattern, 512)
	if err != nil {
		return nil, err
	}
	if strings.ContainsAny(message, "\n\r\u2028\u2029") {
		return nil, failure(ErrorInvalid, "$/message", "$/message is invalid.")
	}
	bindingID, err := nullableText(record["bindingId"], "$/bindingId", identifier)
	if err != nil {
		return nil, err
	}
	var operation any
	if record["operation"] != nil {
		validated, operationErr := operationValue(record["operation"], "$/operation")
		if operationErr != nil {
			return nil, operationErr
		}
		operation = string(validated)
	}
	reconciliationToken, err := nullableText(record["reconciliationToken"], "$/reconciliationToken", reference)
	if err != nil {
		return nil, err
	}
	result := Record{
		"schema": schema, "code": string(code), "message": message,
		"bindingId": nullableStringValue(bindingID), "operation": operation,
		"reconciliationToken": nullableStringValue(reconciliationToken),
	}
	if err := session.byteBound(result, MaxErrorBytes, "$", true); err != nil {
		return nil, err
	}
	return result, nil
}

func errorCodeValue(value any, path string) (ErrorCode, error) {
	text, ok := value.(string)
	if ok {
		for _, code := range ErrorCodes() {
			if text == string(code) {
				return code, nil
			}
		}
	}
	return "", failure(ErrorInvalid, path, path+" is invalid.")
}
