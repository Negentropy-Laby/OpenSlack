// Package authoritystore owns the GS6 PostgreSQL authority contract for
// governed plans routed to the Go governance-control service.
package authoritystore

import (
	"context"
	"time"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
)

const (
	AcceptSchema           = "openslack.governance_authority_accept.v1"
	TransitionSchema       = "openslack.governance_authority_transition.v1"
	ReceiptSchema          = "openslack.governance_authority_receipt.v1"
	ReadSchema             = "openslack.governance_authority_read.v1"
	PendingAuditSchema     = "openslack.governance_authority_pending_audit.v1"
	AuditReceiptSchema     = "openslack.governance_authority_audit_receipt.v1"
	Backend                = "go"
	Authority              = "governance-control"
	IdempotencyPrefix      = "openslack.governance-authority.v1."
	AuditIdempotencyPrefix = "openslack.governance-authority-audit.v1."
	MaxRequestBytes        = 2 * 1024 * 1024
)

type Operation string

const (
	OperationAccept                Operation = "accept"
	OperationClaimExecution        Operation = "claim_execution"
	OperationCompleteExecution     Operation = "complete_execution"
	OperationCancel                Operation = "cancel"
	OperationExpire                Operation = "expire"
	OperationRequireReconciliation Operation = "require_reconciliation"
)

type ReceiptStatus string

const (
	ReceiptAccepted               ReceiptStatus = "accepted"
	ReceiptDuplicate              ReceiptStatus = "duplicate"
	ReceiptReconciliationRequired ReceiptStatus = "reconciliation_required"
)

type Route struct {
	Backend      string `json:"backend"`
	Authority    string `json:"authority"`
	RoutingEpoch int64  `json:"routingEpoch"`
}

type PreparedRequest struct {
	Schema               string
	Operation            Operation
	CallerID             string
	WorkspaceID          string
	PlanID               string
	ExpectedRevision     int64
	ExpectedServiceBuild string
	Route                Route
	Record               governance.Record
	RecordBytes          []byte
	RecordHash           string
	TargetRevision       int64
	TargetState          governance.State
	CorrelationID        string
	ExecutionID          string
	ExactBody            []byte
}

type MutateInput struct {
	Prepared           PreparedRequest
	IdempotencyKey     string
	RequestFingerprint string
	ServiceBuildSHA    string
}

type Receipt struct {
	Schema              string
	Operation           Operation
	Status              ReceiptStatus
	WorkspaceID         string
	PlanID              string
	ExpectedRevision    int64
	AcceptedRevision    *int64
	State               governance.State
	TargetRevision      *int64
	TargetState         governance.State
	Route               Route
	IdempotencyKey      string
	RequestFingerprint  string
	RecordHash          string
	CorrelationID       string
	CallerID            string
	ExecutionID         string
	ServiceBuildSHA     string
	RecordBytes         []byte
	CommittedAt         *time.Time
	ReconciliationToken string
	ReceiptID           string
	RecordedAt          time.Time
}

type ReadResult struct {
	Schema          string
	WorkspaceID     string
	PlanID          string
	Route           Route
	RecordHash      string
	RecordBytes     []byte
	ServiceBuildSHA string
}

type PendingAudit struct {
	Schema          string
	Status          string
	Operation       Operation
	WorkspaceID     string
	PlanID          string
	Revision        int64
	Route           Route
	RecordHash      string
	ServiceBuildSHA string
}

type Statistics struct {
	Plans                 int64
	Receipts              int64
	ReconciliationPending int64
	AuditPending          int64
}

type PreparedAudit struct {
	CallerID             string
	WorkspaceID          string
	PlanID               string
	Revision             int64
	RoutingEpoch         int64
	ExpectedServiceBuild string
	Event                governance.AuditEvent
	ExactBody            []byte
	EventHash            string
}

type AuditInput struct {
	Prepared           PreparedAudit
	IdempotencyKey     string
	RequestFingerprint string
	ServiceBuildSHA    string
}

type AuditReceipt struct {
	Schema             string
	Status             string
	WorkspaceID        string
	PlanID             string
	Revision           int64
	EventID            string
	EventHash          string
	IdempotencyKey     string
	RequestFingerprint string
	RecordedAt         time.Time
}

type Store interface {
	Mutate(context.Context, MutateInput) (Receipt, error)
	Read(context.Context, string, string) (ReadResult, error)
	ReadReceipt(context.Context, string, string) (Receipt, error)
	ReadPendingAudit(context.Context, string, string, int64) (PendingAudit, error)
	RecordAudit(context.Context, AuditInput) (AuditReceipt, error)
	Statistics(context.Context) (Statistics, error)
}
