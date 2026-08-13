// Package effectshadowstore owns the independent GS9-D effect-approval
// observation spine. TypeScript remains the sole decision and effect authority.
package effectshadowstore

import (
	"context"
	"time"
)

const (
	ContractVersion     = "v1"
	ObservationSchema   = "openslack.workflow_effect_control_observation.v1"
	EnvelopeSchema      = "openslack.workflow_effect_control_envelope.v1"
	ReceiptSchema       = "openslack.workflow_effect_shadow_receipt.v1"
	HeadSchema          = "openslack.workflow_effect_shadow_head.v1"
	OutboxPayloadSchema = "openslack.workflow_effect_shadow_outbox_payload.v1"
	OutboxReadSchema    = "openslack.workflow_effect_shadow_outbox_read.v1"
	OutboxPageSchema    = "openslack.workflow_effect_shadow_outbox_page.v1"
	HumanSchema         = "openslack.workflow_effect_control_human_decision_projection.v1"
	Route               = "/v1/shadow/workflow-control/effect-events"
	OutboxRoute         = "/v1/shadow/workflow-control/outbox:pending"
	IdempotencyPrefix   = "openslack.workflow-effect-control-shadow.v1."
	MaxRequestBytes     = 512 * 1024
	MaxReceiptBytes     = 64 * 1024
	MaxObservationBytes = 256 * 1024
	MaxOutboxBytes      = 64 * 1024
	MaxOutboxReadLimit  = 100
	MaxSourceSequence   = int64(3)
)

type Operation string

const (
	OperationApprovalCreated Operation = "approval_created"
	OperationApprovalDecided Operation = "approval_decided"
	OperationAuditRecorded   Operation = "audit_recorded"
)

type OutboxEventType string

const (
	OutboxEffectDecisionObserved OutboxEventType = "effect_decision_observed"
	OutboxEffectAuditRecorded    OutboxEventType = "effect_audit_recorded"
)

type HumanDecision struct {
	Schema            string `json:"schema"`
	Channel           string `json:"channel"`
	PrincipalID       string `json:"principalId"`
	WorkspaceID       string `json:"workspaceId"`
	Capability        string `json:"capability"`
	RunID             string `json:"runId"`
	ApprovalID        string `json:"approvalId"`
	CorrelationID     string `json:"correlationId"`
	Decision          string `json:"decision"`
	ReasonHash        string `json:"reasonHash"`
	ApprovalExpiresAt string `json:"approvalExpiresAt"`
	IssuedAt          string `json:"issuedAt"`
	ExpiresAt         string `json:"expiresAt"`
	BindingHash       string `json:"bindingHash"`
	AttestationHash   string `json:"attestationHash"`
	DecidedAt         string `json:"decidedAt"`
}

type Observation struct {
	Schema                     string         `json:"schema"`
	ContractVersion            string         `json:"contractVersion"`
	Authority                  string         `json:"authority"`
	GoRole                     string         `json:"goRole"`
	AuthorityClaim             string         `json:"authorityClaim"`
	NonAuthorizingObservation  bool           `json:"nonAuthorizingObservation"`
	GoEffectDecisionAuthority  bool           `json:"goEffectDecisionAuthority"`
	GoEffectExecutionAuthority bool           `json:"goEffectExecutionAuthority"`
	Operation                  Operation      `json:"operation"`
	WorkspaceID                string         `json:"workspaceId"`
	RunID                      string         `json:"runId"`
	OccurrenceID               string         `json:"occurrenceId"`
	ApprovalID                 string         `json:"approvalId"`
	ApprovalRevision           int64          `json:"approvalRevision"`
	ApprovalStatus             string         `json:"approvalStatus"`
	ApprovalHash               string         `json:"approvalHash"`
	ApprovalDecisionHash       *string        `json:"approvalDecisionHash"`
	EffectID                   string         `json:"effectId"`
	EffectHash                 string         `json:"effectHash"`
	CorrelationID              string         `json:"correlationId"`
	RequiredCapabilityHash     string         `json:"requiredCapabilityHash"`
	HumanDecision              *HumanDecision `json:"humanDecision"`
	BindingHash                *string        `json:"bindingHash"`
	Decision                   *string        `json:"decision"`
	AuditEventID               *string        `json:"auditEventId"`
	AuditStatus                *string        `json:"auditStatus"`
	ObservedAt                 string         `json:"observedAt"`
}

type Envelope struct {
	Schema                    string      `json:"schema"`
	ContractVersion           string      `json:"contractVersion"`
	Authority                 string      `json:"authority"`
	GoRole                    string      `json:"goRole"`
	AuthorityClaim            string      `json:"authorityClaim"`
	NonAuthorizingObservation bool        `json:"nonAuthorizingObservation"`
	SourceSequence            int64       `json:"sourceSequence"`
	Operation                 Operation   `json:"operation"`
	Observation               Observation `json:"observation"`
	ObservationHash           string      `json:"observationHash"`
}

type PreparedObservation struct {
	Envelope         Envelope
	ExactBody        []byte
	EnvelopeHash     string
	ObservationBytes []byte
}

type ObserveInput struct {
	Prepared           PreparedObservation
	IdempotencyKey     string
	RequestFingerprint string
	ServiceBuildHash   string
}

type ReceiptValue struct {
	Schema              string    `json:"schema"`
	Status              string    `json:"status"`
	IdempotencyKey      string    `json:"idempotencyKey"`
	ReceiptID           string    `json:"receiptId"`
	ObservationID       *string   `json:"observationId"`
	WorkspaceID         string    `json:"workspaceId"`
	RunID               string    `json:"runId"`
	OccurrenceID        string    `json:"occurrenceId"`
	ApprovalID          string    `json:"approvalId"`
	SourceSequence      int64     `json:"sourceSequence"`
	Operation           Operation `json:"operation"`
	Parity              string    `json:"parity"`
	MismatchCode        *string   `json:"mismatchCode"`
	ReconciliationToken *string   `json:"reconciliationToken"`
	EnvelopeHash        string    `json:"envelopeHash"`
	ObservationHash     string    `json:"observationHash"`
	ServiceBuildHash    string    `json:"serviceBuildHash"`
	CommittedAt         *string   `json:"committedAt"`
}

type Receipt struct {
	Value      ReceiptValue
	ExactBytes []byte
	Replay     bool
}

type Head struct {
	Schema                 string       `json:"schema"`
	WorkspaceID            string       `json:"workspaceId"`
	RunID                  string       `json:"runId"`
	OccurrenceID           string       `json:"occurrenceId"`
	ApprovalID             string       `json:"approvalId"`
	SourceSequence         int64        `json:"lastSourceSequence"`
	Operation              Operation    `json:"lastOperation"`
	LastObservationHash    string       `json:"lastObservationHash"`
	MatchedSourceSequence  *int64       `json:"matchedSourceSequence"`
	MatchedOperation       *Operation   `json:"matchedOperation"`
	MatchedObservationHash *string      `json:"matchedObservationHash"`
	MismatchLatched        bool         `json:"mismatchLatched"`
	MismatchCode           *string      `json:"mismatchCode"`
	ServiceBuildHash       string       `json:"serviceBuildHash"`
	UpdatedAt              string       `json:"updatedAt"`
	Observation            *Observation `json:"-"`
}

// OutboxPayload is a sanitized, non-authorizing projection. It deliberately
// excludes the human nonce, raw reason, effect payload/result and credentials.
type OutboxPayload struct {
	Schema                     string          `json:"schema"`
	EventID                    string          `json:"eventId"`
	EventType                  OutboxEventType `json:"eventType"`
	Authority                  string          `json:"authority"`
	GoRole                     string          `json:"goRole"`
	NonAuthorizingObservation  bool            `json:"nonAuthorizingObservation"`
	GoEffectDecisionAuthority  bool            `json:"goEffectDecisionAuthority"`
	GoEffectExecutionAuthority bool            `json:"goEffectExecutionAuthority"`
	WorkspaceID                string          `json:"workspaceId"`
	RunID                      string          `json:"runId"`
	OccurrenceID               string          `json:"occurrenceId"`
	ApprovalID                 string          `json:"approvalId"`
	SourceSequence             int64           `json:"sourceSequence"`
	Operation                  Operation       `json:"operation"`
	ObservationID              string          `json:"observationId"`
	ObservationHash            string          `json:"observationHash"`
	ApprovalStatus             string          `json:"approvalStatus"`
	Decision                   string          `json:"decision"`
	AuditEventID               string          `json:"auditEventId"`
	BindingHash                string          `json:"bindingHash"`
	ObservedAt                 string          `json:"observedAt"`
}

type OutboxRead struct {
	Schema           string          `json:"schema"`
	Status           string          `json:"status"`
	EventID          string          `json:"eventId"`
	EventType        OutboxEventType `json:"eventType"`
	WorkspaceID      string          `json:"workspaceId"`
	RunID            string          `json:"runId"`
	OccurrenceID     string          `json:"occurrenceId"`
	ApprovalID       string          `json:"approvalId"`
	SourceSequence   int64           `json:"sourceSequence"`
	Operation        Operation       `json:"operation"`
	ObservationID    string          `json:"observationId"`
	ObservationHash  string          `json:"observationHash"`
	PayloadHash      string          `json:"payloadHash"`
	Payload          OutboxPayload   `json:"payload"`
	RecordedAt       string          `json:"recordedAt"`
	CursorRecordedAt time.Time       `json:"-"`
}

type OutboxPage struct {
	Schema     string       `json:"schema"`
	Items      []OutboxRead `json:"items"`
	Count      int          `json:"count"`
	NextCursor *string      `json:"nextCursor"`
}

type Statistics struct {
	Heads                 int64
	Observations          int64
	Receipts              int64
	OutboxPending         int64
	ReconciliationPending int64
}

type Store interface {
	Observe(context.Context, ObserveInput) (Receipt, error)
	ReadHead(context.Context, string, string, string, string) (Head, error)
	ReadReceipt(context.Context, string, string) (Receipt, error)
	ReadPendingOutbox(context.Context, string, int, string) (OutboxPage, error)
	Ready(context.Context) error
	Statistics(context.Context) (Statistics, error)
}
