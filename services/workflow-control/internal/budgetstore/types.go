// Package budgetstore owns the default-off GS9-E2 PostgreSQL qualification
// authority for the frozen workflow-budget-authority/v1 contract. It advances
// the GS9-B run head, but does not activate runner v2 or production routing.
package budgetstore

import (
	"context"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

const (
	Backend                  = "go"
	Authority                = "workflow-control"
	MutationResponseSchema   = "openslack.workflow_control_budget_mutation_response.v1"
	ReconciliationPrefix     = "wf-budget-db-reconciliation"
	MaxMutationResponseBytes = 1024 * 1024
)

// Quantities is the closed three-dimensional authority quantity. Values are
// canonical, unsigned base-10 int64 strings; no floating-point representation
// participates in storage or arithmetic.
type Quantities struct {
	Tokens  string `json:"tokens"`
	NanoUSD string `json:"nanoUsd"`
	Calls   string `json:"calls"`
}

// QualificationSeed is the process-startup budget authority used only by the
// default-off qualification service. It is deliberately absent from the HTTP
// contract: production initial-budget policy authority is not delivered by
// GS9-E2.
type QualificationSeed struct {
	PolicyHash string     `json:"policyHash"`
	Limit      Quantities `json:"limit"`
}

func (value Quantities) Record() budgetcontract.Record {
	return budgetcontract.Record{"tokens": value.Tokens, "nanoUsd": value.NanoUSD, "calls": value.Calls}
}

type MutationInput struct {
	Prepared         budgetcontract.PreparedRequest
	ServiceBuildHash string
	Seed             QualificationSeed
}

type MutationResult struct {
	Operation                string
	Status                   string
	Record                   budgetcontract.Record
	LedgerEntry              budgetcontract.Record
	Reconciliation           budgetcontract.Record
	Receipt                  budgetcontract.Record
	DurableRecord            *DurableRecord
	DurableLedgerEntry       *DurableRecord
	DurableReconciliation    *DurableRecord
	DurableReceipt           DurableRecord
	Response                 MutationResponse
	ExactRecordBytes         []byte
	ExactLedgerBytes         []byte
	ExactReceiptBytes        []byte
	ExactReconciliationBytes []byte
	ExactResponseBytes       []byte
	Replay                   bool
	ReceiptID                string
	RecordedAt               time.Time
}

// MutationResponse is the closed HTTP response persisted for exact replay.
// Ledger bytes stay private; the receipt binds their domain-separated hash.
type MutationResponse struct {
	Schema         string         `json:"schema"`
	Operation      string         `json:"operation"`
	Record         *DurableRecord `json:"record"`
	Receipt        DurableRecord  `json:"receipt"`
	Reconciliation *DurableRecord `json:"reconciliation"`
}

type Account struct {
	Value      budgetcontract.Record
	Durable    DurableRecord
	ExactBytes []byte
	RecordHash string
	UpdatedAt  time.Time
}

type Reservation struct {
	Value                 budgetcontract.Record
	Durable               DurableRecord
	ExactBytes            []byte
	RecordHash            string
	Status                string
	TerminalLedgerEntryID *string
	OpenedAt              time.Time
	ClosedAt              *time.Time
}

type Receipt struct {
	Value              budgetcontract.Record
	Durable            DurableRecord
	Response           MutationResponse
	ExactReceiptBytes  []byte
	ExactResponseBytes []byte
	ReceiptID          string
	RecordedAt         time.Time
}

type Statistics struct {
	Accounts                    int64
	Reservations                int64
	OpenReservations            int64
	LedgerEntries               int64
	Receipts                    int64
	OpenDatabaseReconciliations int64
	ProviderReconciliations     int64
}

type Repository interface {
	Reserve(context.Context, MutationInput) (MutationResult, error)
	Settle(context.Context, MutationInput) (MutationResult, error)
	ReadAccount(context.Context, string, string) (Account, error)
	ReadReservation(context.Context, string, string, string) (Reservation, error)
	ReadReceipt(context.Context, string, string) (Receipt, error)
	Ready(context.Context) error
	Statistics(context.Context) (Statistics, error)
}
