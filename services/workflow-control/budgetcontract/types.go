package budgetcontract

const (
	ContractVersion             = "v1"
	Authority                   = "typescript"
	Writer                      = "@openslack/workflows"
	GoRole                      = "validator_only"
	GoAuthorityClaim            = "NO_AUTHORITY"
	MaxInt64Decimal             = "9223372036854775807"
	IdempotencyPrefix           = "openslack.workflow-budget-authority.v1."
	ReserveRoute                = "/v1/authority/workflow-budgets:reserve"
	SettleRoute                 = "/v1/authority/workflow-budgets:settle"
	MaxAccountBytes             = 64 * 1024
	MaxRecordBytes              = 256 * 1024
	MaxJSONDepth                = 16
	MaxJSONNodes                = 4_096
	MaxIdentifierBytes          = 256
	MaxDecimalBytes             = 19
	MaxRateDecimalBytes         = 64
	MaxRateFractionDigits       = 18
	MaxSafeInteger        int64 = 1<<53 - 1
)

const (
	SchemaAccount           = "openslack.workflow_budget_account.v1"
	SchemaReserveRequest    = "openslack.workflow_budget_reserve_request.v1"
	SchemaReserveDecision   = "openslack.workflow_budget_reserve_decision.v1"
	SchemaReservation       = "openslack.workflow_budget_reservation.v1"
	SchemaProviderUsage     = "openslack.provider_usage_receipt.v1"
	SchemaSettlementRequest = "openslack.workflow_budget_settlement_request.v1"
	SchemaSettlement        = "openslack.workflow_budget_settlement.v1"
	SchemaLedgerEntry       = "openslack.workflow_budget_ledger_entry.v1"
	SchemaReceipt           = "openslack.workflow_budget_receipt.v1"
	SchemaPreparedRequest   = "openslack.workflow_budget_prepared_request.v1"
	SchemaReconciliation    = "openslack.workflow_budget_reconciliation.v1"
	SchemaLegacyApproval    = "openslack.workflow_budget_legacy_approval_observation.v1"
)

type Record map[string]any

type PreparedRequest struct {
	Schema             string `json:"schema"`
	Operation          string `json:"operation"`
	Method             string `json:"method"`
	Path               string `json:"path"`
	CallerID           string `json:"callerId"`
	Body               string `json:"body"`
	RequestHash        string `json:"requestHash"`
	IdempotencyKey     string `json:"idempotencyKey"`
	RequestFingerprint string `json:"requestFingerprint"`
}

type ReserveEvaluation struct {
	Decision    Record
	Reservation Record
	LedgerEntry Record
}

type SettlementEvaluation struct {
	Settlement     Record
	LedgerEntry    Record
	Reconciliation Record
}

func Dimensions() []string { return []string{"tokens", "nano_usd", "calls"} }

func LedgerKinds() []string {
	return []string{"reserve_reserved", "reserve_rejected", "settlement_settled", "settlement_reconciliation_required"}
}

func ProviderReconciliationReasons() []string {
	return []string{"provider_outcome_unknown", "usage_receipt_missing", "usage_receipt_untrusted", "usage_overrun"}
}

func ErrorCodes() []ErrorCode {
	return []ErrorCode{
		ErrorInvalid, ErrorUnknownField, ErrorLimitExceeded, ErrorInvalidDecimal,
		ErrorDecimalOverflow, ErrorHashMismatch, ErrorIdentityMismatch, ErrorPolicyDrift,
		ErrorRouteDrift, ErrorStaleRevision, ErrorReconciliationRequired,
		ErrorLegacyApprovalNoAuthority,
	}
}
