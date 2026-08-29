package runnerstore

import (
	"context"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
)

type V2NegotiationInput struct {
	Lease                   AttemptLease
	Hello                   authoritycontract.Message
	ExactBytes              []byte
	ControlBuildHash        string
	ExpectedRunnerBuildHash string
	HeartbeatInterval       time.Duration
	LeaseOfferTimeout       time.Duration
	Now                     time.Time
}

type V2Negotiation struct {
	ProcessSessionID string
	HelloAck         authoritycontract.Message
	HelloAckBytes    []byte
}

type V2RecordEventInput struct {
	Message          authoritycontract.Message
	ExactBytes       []byte
	ControlBuildHash string
	Now              time.Time
}

type V2RecordedEvent struct {
	Receipt            authoritycontract.Message
	ReceiptBytes       []byte
	Decision           *authoritycontract.Message
	DecisionBytes      []byte
	Status             ReceiptStatus
	JobState           JobState
	AttemptState       AttemptState
	Duplicate          bool
	AuthorityBindingID *string
}

type V2CancelControl struct {
	CancelID   string
	Message    authoritycontract.Message
	ExactBytes []byte
}

type V2ControlDeliveryDisposition string

const (
	V2ControlDeliveryAccepted               V2ControlDeliveryDisposition = "accepted"
	V2ControlDeliveryReconciliationRequired V2ControlDeliveryDisposition = "reconciliation_required"
)

type V2SessionStore interface {
	Store
	RecordAttemptFailure(context.Context, AttemptFailureInput) (JobView, error)
	RecordV2Negotiation(context.Context, V2NegotiationInput) (V2Negotiation, error)
	RecordV2Event(context.Context, V2RecordEventInput) (V2RecordedEvent, error)
	PrepareV2Cancel(context.Context, AttemptLease, CancelControl) (V2CancelControl, error)
	MarkV2ControlDeliveryStarted(context.Context, string, string, string, time.Time) error
	MarkV2ControlDelivered(context.Context, string, string, string, time.Time) error
	MarkV2ControlDeliveryReconciliation(context.Context, string, string, string, time.Time) error
	WaitV2ControlAcknowledged(context.Context, string, string) (V2ControlDeliveryDisposition, error)
}

type V2AuthorityRequest struct {
	Message    authoritycontract.Message
	ExactBytes []byte
	Lease      AttemptLease
}

// Each operation-specific adapter validates its own frozen TypeScript-owned
// receipt contract. The runner only consumes the exact durable bytes and the
// explicitly proven revision/generation advance; it never interprets a shadow
// receipt as a workflow-control authority receipt.
type V2AuthorityOutcome struct {
	Operation                authoritycontract.ReceiptOperation
	ExactReceiptBytes        []byte
	AcceptedRunRevision      int64
	AcceptedResumeGeneration int64
	Decision                 *authoritycontract.Message
	DecisionBytes            []byte
	RuntimeBinding           *V2AuthorityBindingView
}

type V2CheckpointAuthority interface {
	CommitCheckpoint(context.Context, V2AuthorityRequest) (V2AuthorityOutcome, error)
	ReadCheckpointReceipt(context.Context, string, string) (V2AuthorityOutcome, error)
}

type V2EffectAuthority interface {
	AuthorizeEffect(context.Context, V2AuthorityRequest) (V2AuthorityOutcome, error)
	ReadEffectReceipt(context.Context, string, string) (V2AuthorityOutcome, error)
}

type V2BudgetAuthority interface {
	ReserveBudget(context.Context, V2AuthorityRequest) (V2AuthorityOutcome, error)
	SettleBudget(context.Context, V2AuthorityRequest) (V2AuthorityOutcome, error)
	ReadBudgetReceipt(context.Context, authoritycontract.Kind, string, string) (V2AuthorityOutcome, error)
}

type V2ResumeAuthority interface {
	AdvanceResume(context.Context, V2AuthorityRequest) (V2AuthorityOutcome, error)
	ReadResumeReceipt(context.Context, string, string) (V2AuthorityOutcome, error)
}

// V2AuthorityPorts is a qualification-only composition root. Nil operation
// ports fail closed; test doubles do not make the production route authority.
type V2AuthorityPorts struct {
	Checkpoint V2CheckpointAuthority
	Effect     V2EffectAuthority
	Budget     V2BudgetAuthority
	Resume     V2ResumeAuthority
}
