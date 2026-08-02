// Package shadowstore owns the isolated GS5 governance observation model.
// TypeScript remains the sole governed-plan writer and execution authority.
package shadowstore

import (
	"context"
	"time"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
)

const (
	ObservationSchema      = "openslack.governance_shadow_observation.v1"
	ReceiptSchema          = "openslack.governance_shadow_receipt.v1"
	ProjectionSchema       = "openslack.governance_shadow_projection.v1"
	Authority              = "typescript"
	ObservationPath        = "/v1/shadow/governance/observations"
	MaxObservationBytes    = 2 * 1024 * 1024
	MaxIdempotencyKeyBytes = 128
)

type Kind string

const (
	KindRecord       Kind = "record"
	KindConfirmation Kind = "confirmation"
	KindAudit        Kind = "audit"
)

type Parity string

const (
	ParityMatched    Parity = "matched"
	ParityMismatched Parity = "mismatched"
	ParityUnknown    Parity = "unknown"
)

type ReceiptStatus string

const (
	ReceiptAccepted               ReceiptStatus = "accepted"
	ReceiptDuplicate              ReceiptStatus = "duplicate"
	ReceiptReconciliationRequired ReceiptStatus = "reconciliation_required"
)

type Source struct {
	WorkspaceID    string
	PlanID         string
	SourceSequence int64
}

type CurrentBindings struct {
	SourceVersionHash      string
	PermissionSnapshotHash string
	ActionCatalogHash      string
	ExecutorBindingHash    string
	BuildNonceHash         string
	ProcessNonceHash       string
}

type Confirmation struct {
	AttemptID          string
	RecordRevision     int64
	AttemptedAt        string
	ActorID            string
	WorkspaceID        string
	PresentedTokenHash string
	CurrentBindings    *CurrentBindings
	AuthorityOutcome   string
}

type PreparedObservation struct {
	Source           Source
	Kind             Kind
	ExactBody        []byte
	BodyDigest       [32]byte
	ExpectedRevision int64
	RecordRevision   int64
	RecordHash       string
	RecordBytes      []byte
	Record           governance.Record
	Confirmation     *Confirmation
	Audit            *governance.AuditEvent
	AuditBytes       []byte
}

type ObserveInput struct {
	IdempotencyKey     string
	RequestFingerprint string
	ExactBody          []byte
}

type Receipt struct {
	Schema              string
	Operation           string
	Status              ReceiptStatus
	Parity              Parity
	IdempotencyKey      string
	RequestFingerprint  string
	WorkspaceID         string
	PlanID              string
	SourceSequence      int64
	ObservationKind     Kind
	ObservationDigest   string
	MismatchCode        string
	CommittedAt         *time.Time
	ReconciliationToken *string

	ReceiptID  string
	RecordedAt time.Time
}

type Projection struct {
	Schema                 string
	Authority              string
	Shadow                 string
	Parity                 Parity
	WorkspaceID            string
	PlanID                 string
	SourceSequence         int64
	MatchedRecordRevision  int64
	ReadModel              governance.ReadModel
	MatchedObservations    int64
	MismatchedObservations int64
	ConfirmationMatched    int64
	ConfirmationMismatched int64
	AuditMatched           int64
	AuditMismatched        int64
}

type Statistics struct {
	Plans                  int64
	SourceSequenceMax      int64
	MatchedObservations    int64
	MismatchedObservations int64
	ReconciliationPending  int64
}

type Store interface {
	Observe(context.Context, ObserveInput) (Receipt, error)
	Projection(context.Context, string, string) (Projection, error)
	Statistics(context.Context) (Statistics, error)
}
