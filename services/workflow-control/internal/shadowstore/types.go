// Package shadowstore owns the isolated GS7-B Workflow Control observation
// store. TypeScript remains the sole workflow writer and execution authority.
package shadowstore

import (
	"context"
	"time"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
)

const (
	ReceiptSchema          = workflowcontrol.ShadowReceiptSchema
	ProjectionSchema       = workflowcontrol.ShadowProjectionSchema
	Authority              = workflowcontrol.Authority
	ObservationPath        = workflowcontrol.ShadowObservationPath
	MaxObservationBytes    = workflowcontrol.MaxShadowEnvelopeBytes
	MaxIdempotencyKeyBytes = 160
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

type PreparedObservation struct {
	Envelope   workflowcontrol.ShadowEnvelope
	ExactBody  []byte
	BodyDigest [32]byte
}

type Evaluation struct {
	Parity          Parity
	MismatchCode    string
	ProjectionBytes []byte
	ObservationHash string
	Status          workflowcontrol.RunState
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
	RunID               string
	SourceSequence      int64
	ObservationDigest   string
	ObservationHash     string
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
	GoRole                 string
	AuthorityEligible      bool
	Parity                 Parity
	WorkspaceID            string
	RunID                  string
	SourceSequence         int64
	MatchedSourceSequence  int64
	MatchedObservationHash string
	ReadModel              workflowcontrol.ReadModel
	MatchedObservations    int64
	MismatchedObservations int64
}

type Statistics struct {
	Runs                   int64
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
