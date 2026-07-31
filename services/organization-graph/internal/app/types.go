package app

import (
	"context"
	"fmt"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

const (
	ReceiptSchema = "openslack.graph_ingest_receipt.v1"
	ErrorSchema   = "openslack.graph_error.v1"

	OperationSnapshotIngest = "snapshot_ingest"
	OperationDeltaIngest    = "delta_ingest"

	ReceiptAccepted               = "accepted"
	ReceiptDuplicate              = "duplicate"
	ReceiptReconciliationRequired = "reconciliation_required"
)

// SnapshotCommand is a fully validated, canonicalized snapshot mutation.
type SnapshotCommand struct {
	IdempotencyKey string
	Fingerprint    string
	ExpectedCursor *string
	Snapshot       graph.Snapshot
	CanonicalBytes []byte
}

// DeltaCommand is a fully validated, canonicalized delta mutation.
type DeltaCommand struct {
	IdempotencyKey       string
	Fingerprint          string
	ExpectedCursor       string
	TargetSnapshot       graph.Snapshot
	TargetCanonicalBytes []byte
	Delta                graph.Delta
	DeltaCanonicalBytes  []byte
}

// Receipt is the durable result returned by the storage authority.
type Receipt struct {
	Operation             string
	Status                string
	IdempotencyKey        string
	RequestFingerprint    string
	ScenarioInstanceID    string
	Cursor                string
	Revision              int64
	SnapshotIntegrityHash string
	DeltaIntegrityHash    *string
	CommittedAt           *string
	ReconciliationToken   *string
}

// CurrentSnapshot is the verified current head used for bounded reads.
type CurrentSnapshot struct {
	Snapshot graph.Snapshot
	Revision int64
}

// Scenario is a published graph head.
type Scenario struct {
	ScenarioInstanceID    string
	Cursor                string
	SnapshotIntegrityHash string
	Revision              int64
	GeneratedAt           string
}

// StoreMetrics is a low-cardinality operational projection. It contains no
// scenario IDs, authority objects, request bodies, or idempotency keys.
type StoreMetrics struct {
	PublishedScenarios       int64
	PublishedHeadRevisionMax int64
	ReconciliationPending    int64
	ShadowBacklog            *int64
	ShadowLagSeconds         *float64
	ParityMismatchesTotal    *int64
}

// Store is the deliberately small adapter boundary between HTTP and storage.
// The PostgreSQL implementation may use different internal command types; the
// cmd/server composition root owns that translation.
type Store interface {
	CheckReady(context.Context) error
	IngestSnapshot(context.Context, SnapshotCommand) (Receipt, error)
	IngestDelta(context.Context, DeltaCommand) (Receipt, error)
	CurrentSnapshot(context.Context, string) (CurrentSnapshot, error)
	ListScenarios(context.Context) ([]Scenario, error)
	Metrics(context.Context) (StoreMetrics, error)
}

type StoreErrorCode string

const (
	StoreNotFound            StoreErrorCode = "not_found"
	StoreConflict            StoreErrorCode = "conflict"
	StoreIdempotencyConflict StoreErrorCode = "idempotency_conflict"
	StoreUnprocessable       StoreErrorCode = "unprocessable"
	StoreTooLarge            StoreErrorCode = "too_large"
	StoreUnavailable         StoreErrorCode = "unavailable"
	StoreAmbiguous           StoreErrorCode = "ambiguous_commit"
	StoreInternal            StoreErrorCode = "internal"
)

// StoreError is sanitized at the HTTP boundary. Cause is for structured logs
// only and is never copied into a response.
type StoreError struct {
	Code    StoreErrorCode
	Receipt *Receipt
	Cause   error
}

func (failure *StoreError) Error() string {
	if failure == nil {
		return "<nil>"
	}
	if failure.Cause == nil {
		return fmt.Sprintf("graph store failure: %s", failure.Code)
	}
	return fmt.Sprintf("graph store failure: %s: %v", failure.Code, failure.Cause)
}

func (failure *StoreError) Unwrap() error {
	if failure == nil {
		return nil
	}
	return failure.Cause
}
