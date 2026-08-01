// Package contracttodelivery provides the pure Go shadow of the
// TypeScript-owned Contract-to-Delivery composite projector. It accepts only
// caller-supplied strict JSON and performs no I/O, clock reads, or mutations.
package contracttodelivery

import graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"

const (
	// SourceSchema identifies the frozen TypeScript-owned composite source schema.
	SourceSchema = "openslack.contract_to_delivery_source_snapshot.v1"
	// ProjectorID identifies the Contract-to-Delivery projector contract.
	ProjectorID = "openslack.contract_to_delivery.v1"
	// ScenarioID identifies the only scenario definition accepted by this shadow.
	ScenarioID = "contract-to-delivery-lite"

	MaxObservationsPerKind = 500
	MaxTotalObservations   = 3_000
	MaxTotalRelations      = 12_000
	MaxSourceBytes         = 4 * 1024 * 1024
	MaxSourceJSONNodes     = 100_000
	MaxSourceProperties    = 128
	MaxSourceArrayItems    = 12_000
	MaxProjectedBytes      = 16 * 1024 * 1024
	MaxCompletenessEntries = 50
	MaxTextBytes           = 2_048
)

// Result contains the projector identity and exact composite graph snapshot.
type Result struct {
	ProjectorID string
	Snapshot    graph.Snapshot
}

type businessEvidence struct {
	ID             string
	Title          string
	Status         string
	AuthorityRef   graph.AuthorityRef
	SourceEventIDs []string
	EvidenceRefs   []string
}

type bridgeRef struct {
	TargetType   string
	AuthorityRef graph.AuthorityRef
}

type customerObservation struct{ businessEvidence }

type contractObservation struct {
	businessEvidence
	CustomerID  string
	Deliverable bridgeRef
}

type projectObservation struct {
	businessEvidence
	ContractID string
	WorkItem   bridgeRef
}

type milestoneObservation struct {
	businessEvidence
	ProjectID string
	WorkItem  bridgeRef
}

type acceptanceObservation struct {
	businessEvidence
	Deliverable        bridgeRef
	HumanDecision      bridgeRef
	AcceptedTransition bridgeRef
}

type outcomeObservation struct {
	businessEvidence
	AcceptanceID    string
	WorkItem        bridgeRef
	SoftwareOutcome bridgeRef
}

type sourceBatch[T any] struct {
	Status       string
	BatchVersion string
	ObservedAt   string
	Items        []T
	WarningCodes []string
	ReasonCode   string
}

type businessSources struct {
	Customers   sourceBatch[customerObservation]
	Contracts   sourceBatch[contractObservation]
	Projects    sourceBatch[projectObservation]
	Milestones  sourceBatch[milestoneObservation]
	Acceptances sourceBatch[acceptanceObservation]
	Outcomes    sourceBatch[outcomeObservation]
}

type sourceSnapshot struct {
	Schema               string
	ScenarioDefinitionID string
	ScenarioInstanceID   string
	Cursor               string
	GeneratedAt          string
	ProjectorVersion     string
	SoftwareDeliveryJSON []byte
	Business             businessSources
}
