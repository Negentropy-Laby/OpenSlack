package authoritycontract

const (
	ContractVersion   = "v2"
	StateSchema       = "openslack.workflow_control_authority_state.v2"
	MessageSchema     = "openslack.workflow_control_authority_message.v2"
	PreparedSchema    = "openslack.workflow_control_authority_prepared_message.v2"
	ReceiptSchema     = "openslack.workflow_control_authority_receipt.v2"
	FingerprintSchema = "openslack.workflow_control_authority_request_fingerprint.v2"
	ProtocolVersion   = "openslack.workflow_runner.v2"
	V1ProtocolVersion = "openslack.workflow_runner.v1"
	IdempotencyPrefix = "openslack.workflow-control-authority.v2."

	// Authority identifies the current and only Workflow Control writer in
	// GS9-A. It is deliberately not configurable from this package.
	Authority = "typescript"
	// GoRole is limited to validation and deterministic calculation parity.
	GoRole = "validator-only"
	// AuthorityClaim is the explicit qualification ceiling for this package.
	AuthorityClaim = "NO_AUTHORITY"

	MaxMessageBytes    = 256 * 1024
	MaxReceiptBytes    = 256 * 1024
	MaxStateBytes      = 512 * 1024
	MaxJSONDepth       = 16
	MaxJSONNodes       = 4_096
	MaxStringBytes     = 4_096
	MaxIdentifierBytes = 256
	MaxSafeInteger     = int64(1<<53 - 1)
)

type RunState string

const (
	RunCreated                RunState = "created"
	RunPreviewed              RunState = "previewed"
	RunConfirmed              RunState = "confirmed"
	RunRunning                RunState = "running"
	RunPaused                 RunState = "paused"
	RunPausedWaitingApproval  RunState = "paused_waiting_approval"
	RunResuming               RunState = "resuming"
	RunCompleted              RunState = "completed"
	RunFailed                 RunState = "failed"
	RunCancelled              RunState = "cancelled"
	RunReconciliationRequired RunState = "reconciliation_required"
)

type Direction string

const (
	DirectionRunnerToControl Direction = "runner-to-control"
	DirectionControlToRunner Direction = "control-to-runner"
)

type ApprovalStatus string

const (
	ApprovalPending  ApprovalStatus = "pending"
	ApprovalApproved ApprovalStatus = "approved"
	ApprovalRejected ApprovalStatus = "rejected"
	ApprovalExpired  ApprovalStatus = "expired"
)

type ReceiptStatus string

const (
	ReceiptAccepted               ReceiptStatus = "accepted"
	ReceiptDuplicate              ReceiptStatus = "duplicate"
	ReceiptReconciliationRequired ReceiptStatus = "reconciliation_required"
)

// Kind is the frozen v2 message vocabulary. It lives in this independent
// contract package so the merged workflow-runner v1 package and bytes remain
// unchanged throughout GS9-A.
type Kind string

const (
	KindHello                Kind = "hello"
	KindHelloAck             Kind = "hello_ack"
	KindLeaseOffer           Kind = "lease_offer"
	KindLeaseAccept          Kind = "lease_accept"
	KindLeaseReject          Kind = "lease_reject"
	KindHeartbeat            Kind = "heartbeat"
	KindEffectIntent         Kind = "effect_intent"
	KindEffectOutcome        Kind = "effect_outcome"
	KindCancelRequest        Kind = "cancel_request"
	KindCancelAck            Kind = "cancel_ack"
	KindTerminal             Kind = "terminal"
	KindEventReceipt         Kind = "event_receipt"
	KindCheckpointCommit     Kind = "checkpoint_commit"
	KindBudgetReserveRequest Kind = "budget_reserve_request"
	KindBudgetUsageReport    Kind = "budget_usage_report"
	KindBudgetAuthorization  Kind = "budget_authorization"
	KindEffectAuthorization  Kind = "effect_authorization"
	KindResumeOffer          Kind = "resume_offer"
)

// ReceiptOperation names the future durable authority receipt operations.
// GS9-A validates the vocabulary but does not persist or issue receipts.
type ReceiptOperation string

const (
	ReceiptRunTransition    ReceiptOperation = "run_transition"
	ReceiptCheckpointCommit ReceiptOperation = "checkpoint_commit"
	ReceiptBudgetReserve    ReceiptOperation = "budget_reserve"
	ReceiptBudgetSettle     ReceiptOperation = "budget_settle"
	ReceiptEffectAuthorize  ReceiptOperation = "effect_authorize"
	ReceiptResumeAdvance    ReceiptOperation = "resume_advance"
)

var (
	runStates = []RunState{
		RunCreated, RunPreviewed, RunConfirmed, RunRunning, RunPaused,
		RunPausedWaitingApproval, RunResuming, RunCompleted, RunFailed,
		RunCancelled, RunReconciliationRequired,
	}
	messageKinds = []Kind{
		KindHello, KindHelloAck, KindLeaseOffer, KindLeaseAccept, KindLeaseReject,
		KindHeartbeat, KindEffectIntent, KindEffectOutcome, KindCancelRequest,
		KindCancelAck, KindTerminal, KindEventReceipt, KindCheckpointCommit,
		KindBudgetReserveRequest, KindBudgetUsageReport, KindBudgetAuthorization,
		KindEffectAuthorization, KindResumeOffer,
	}
	receiptOperations = []ReceiptOperation{
		ReceiptRunTransition, ReceiptCheckpointCommit, ReceiptBudgetReserve,
		ReceiptBudgetSettle, ReceiptEffectAuthorize, ReceiptResumeAdvance,
	}
	transitions = map[RunState][]RunState{
		RunCreated:                {RunPreviewed, RunConfirmed, RunRunning, RunCancelled},
		RunPreviewed:              {RunConfirmed, RunRunning, RunCancelled},
		RunConfirmed:              {RunRunning, RunCancelled},
		RunRunning:                {RunPaused, RunPausedWaitingApproval, RunResuming, RunCompleted, RunFailed, RunCancelled, RunReconciliationRequired},
		RunPaused:                 {RunRunning, RunResuming, RunCancelled, RunReconciliationRequired},
		RunPausedWaitingApproval:  {RunResuming, RunCancelled, RunReconciliationRequired},
		RunResuming:               {RunRunning, RunFailed, RunCancelled, RunReconciliationRequired},
		RunCompleted:              {},
		RunFailed:                 {},
		RunCancelled:              {},
		RunReconciliationRequired: {},
	}
)

func RunStates() []RunState { return append([]RunState(nil), runStates...) }

func MessageKinds() []Kind { return append([]Kind(nil), messageKinds...) }

func ReceiptOperations() []ReceiptOperation {
	return append([]ReceiptOperation(nil), receiptOperations...)
}

func ValidateTransition(from, to RunState) error {
	allowed, exists := transitions[from]
	if !exists {
		return failure(ErrorInvalid, "$/from", "Unknown source run state.")
	}
	if _, exists := transitions[to]; !exists {
		return failure(ErrorInvalid, "$/to", "Unknown target run state.")
	}
	for _, candidate := range allowed {
		if candidate == to {
			return nil
		}
	}
	return failure(ErrorInvalidTransition, "$/to", "Transition "+string(from)+" -> "+string(to)+" is not allowed.")
}

func DirectionForKind(kind Kind) (Direction, error) {
	switch kind {
	case KindHello, KindLeaseAccept, KindLeaseReject, KindHeartbeat,
		KindEffectIntent, KindEffectOutcome, KindCancelAck, KindTerminal,
		KindCheckpointCommit, KindBudgetReserveRequest, KindBudgetUsageReport:
		return DirectionRunnerToControl, nil
	case KindHelloAck, KindLeaseOffer, KindCancelRequest, KindEventReceipt,
		KindBudgetAuthorization, KindEffectAuthorization, KindResumeOffer:
		return DirectionControlToRunner, nil
	default:
		return "", failure(ErrorInvalid, "$/kind", "unknown message kind")
	}
}

// HasDurableAuthority is intentionally constant false. Keeping the negative
// authority assertion executable prevents a successful contract validation
// from being mistaken for a database, routing, or runtime cutover.
func HasDurableAuthority() bool { return false }
