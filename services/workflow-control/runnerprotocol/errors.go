// Package runnerprotocol provides the pure, importable GS8-A workflow runner
// wire contract. It owns no HTTP, database, worker, scheduler, lease, or
// workflow runtime authority.
package runnerprotocol

import "fmt"

// ErrorCode is the closed protocol-validation failure vocabulary.
type ErrorCode string

const (
	ErrorInvalidMessage         ErrorCode = "WORKFLOW_RUNNER_INVALID_MESSAGE"
	ErrorUnsupportedVersion     ErrorCode = "WORKFLOW_RUNNER_UNSUPPORTED_VERSION"
	ErrorUnknownField           ErrorCode = "WORKFLOW_RUNNER_UNKNOWN_FIELD"
	ErrorLimitExceeded          ErrorCode = "WORKFLOW_RUNNER_LIMIT_EXCEEDED"
	ErrorIdentityMismatch       ErrorCode = "WORKFLOW_RUNNER_IDENTITY_MISMATCH"
	ErrorHashMismatch           ErrorCode = "WORKFLOW_RUNNER_HASH_MISMATCH"
	ErrorIdempotencyConflict    ErrorCode = "WORKFLOW_RUNNER_IDEMPOTENCY_CONFLICT"
	ErrorSequenceConflict       ErrorCode = "WORKFLOW_RUNNER_SEQUENCE_CONFLICT"
	ErrorLeaseExpired           ErrorCode = "WORKFLOW_RUNNER_LEASE_EXPIRED"
	ErrorStaleFence             ErrorCode = "WORKFLOW_RUNNER_STALE_FENCE"
	ErrorControlExpired         ErrorCode = "WORKFLOW_RUNNER_CONTROL_EXPIRED"
	ErrorProcessCrash           ErrorCode = "WORKFLOW_RUNNER_PROCESS_CRASH"
	ErrorTimeout                ErrorCode = "WORKFLOW_RUNNER_TIMEOUT"
	ErrorCommitOutcomeUnknown   ErrorCode = "WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN"
	ErrorReconciliationRequired ErrorCode = "WORKFLOW_RUNNER_RECONCILIATION_REQUIRED"
)

// ContractError is stable across Go callers and golden vectors.
type ContractError struct {
	Code    ErrorCode
	Path    string
	Message string
}

func (err *ContractError) Error() string {
	return fmt.Sprintf("%s at %s: %s", err.Code, err.Path, err.Message)
}

func failure(code ErrorCode, path, message string) error {
	return &ContractError{Code: code, Path: path, Message: message}
}
