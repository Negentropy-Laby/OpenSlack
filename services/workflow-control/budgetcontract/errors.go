package budgetcontract

import "fmt"

type ErrorCode string

const (
	ErrorInvalid                   ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_INVALID"
	ErrorUnknownField              ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_UNKNOWN_FIELD"
	ErrorLimitExceeded             ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_LIMIT_EXCEEDED"
	ErrorInvalidDecimal            ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_INVALID_DECIMAL"
	ErrorDecimalOverflow           ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_DECIMAL_OVERFLOW"
	ErrorHashMismatch              ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH"
	ErrorIdentityMismatch          ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH"
	ErrorPolicyDrift               ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_POLICY_DRIFT"
	ErrorRouteDrift                ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_ROUTE_DRIFT"
	ErrorStaleRevision             ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_STALE_REVISION"
	ErrorReconciliationRequired    ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED"
	ErrorLegacyApprovalNoAuthority ErrorCode = "WORKFLOW_BUDGET_AUTHORITY_LEGACY_APPROVAL_NO_AUTHORITY"
)

type ContractError struct {
	Code    ErrorCode `json:"code"`
	Path    string    `json:"path"`
	Message string    `json:"message"`
}

func (err *ContractError) Error() string {
	return fmt.Sprintf("%s at %s: %s", err.Code, err.Path, err.Message)
}

func failure(code ErrorCode, path, message string) error {
	return &ContractError{Code: code, Path: path, Message: message}
}
