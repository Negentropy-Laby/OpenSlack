package runnerstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"regexp"
	"time"
	"unicode/utf8"
)

const BindingSettlementSchema = "openslack.workflow_runner_binding_settlement_receipt.v1"
const BindingReconciliationSchema = "openslack.workflow_runner_binding_reconciliation.v1"
const BindingReconciliationKeyPrefix = "openslack.workflow-runner-reconciliation.v1."

type BindingReconciliationRequest struct {
	Schema       string `json:"schema"`
	WorkspaceID  string `json:"workspaceId"`
	RunID        string `json:"runId"`
	BindingID    string `json:"bindingId"`
	StageHash    string `json:"stageHash"`
	Outcome      string `json:"outcome"`
	RulesVersion int    `json:"rulesVersion"`
}

// ParseBindingSettlement preserves exact receipt bytes; accepted history is
// never reserialized into a replacement receipt. Contextual stage validation is
// additionally required before the proof can close a binding.
func ParseBindingSettlement(raw []byte) (BindingSettlementReceipt, error) {
	var v BindingSettlementReceipt
	invalid := func() (BindingSettlementReceipt, error) {
		return v, Failure(ErrorReconciliation, "binding settlement receipt is invalid", nil)
	}
	if len(raw) > RecoveryEvidenceMaxResponseBytes || !utf8.Valid(raw) || json.Unmarshal(raw, &v) != nil {
		return invalid()
	}
	exact, err := canonicaljson.Encode(v)
	at, timeErr := time.Parse("2006-01-02T15:04:05.000Z", v.CommittedAt)
	if err != nil || !bytes.Equal(append(exact, '\n'), raw) || v.Schema != BindingSettlementSchema ||
		!regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`).MatchString(v.CallerID) ||
		timeErr != nil || at.Format("2006-01-02T15:04:05.000Z") != v.CommittedAt ||
		(v.ProofKind != "resolution" && v.ProofKind != "source_receipt" && v.ProofKind != "source_fence" && v.ProofKind != "budget_source_result") ||
		(v.Outcome == "not_committed") != (v.ProofKind == "source_fence") || v.Proof == "" {
		return invalid()
	}
	request, err := canonicaljson.Encode(BindingReconciliationRequest{Schema: BindingReconciliationSchema, WorkspaceID: v.WorkspaceID, RunID: v.RunID, BindingID: v.BindingID, StageHash: v.StageHash, Outcome: v.Outcome, RulesVersion: v.RulesVersion})
	if err != nil {
		return invalid()
	}
	prepared, err := ParseBindingReconciliation(append(request, '\n'))
	if err != nil || v.IdempotencyKey != prepared.IdempotencyKey || v.RequestHash != hex.EncodeToString(prepared.Hash) {
		return invalid()
	}
	return v, nil
}

type PreparedBindingReconciliation struct {
	Value          BindingReconciliationRequest
	ExactBytes     []byte
	Hash           []byte
	IdempotencyKey string
}
type BindingReconciliationItem struct {
	BindingID string  `json:"bindingId"`
	StageHash string  `json:"stageHash"`
	Outcome   string  `json:"outcome"`
	Code      string  `json:"code"`
	ProofKind string  `json:"proofKind"`
	Receipt   *string `json:"receipt"`
}
type BindingReconciliationPreview struct {
	Schema      string                      `json:"schema"`
	WorkspaceID string                      `json:"workspaceId"`
	RunID       string                      `json:"runId"`
	Items       []BindingReconciliationItem `json:"items"`
	NextCursor  *string                     `json:"nextCursor"`
}
type BindingSettlementReceipt struct {
	Schema         string `json:"schema"`
	WorkspaceID    string `json:"workspaceId"`
	RunID          string `json:"runId"`
	BindingID      string `json:"bindingId"`
	StageHash      string `json:"stageHash"`
	Outcome        string `json:"outcome"`
	ProofKind      string `json:"proofKind"`
	Proof          string `json:"proof"`
	IdempotencyKey string `json:"idempotencyKey"`
	RequestHash    string `json:"requestHash"`
	CallerID       string `json:"callerId"`
	RulesVersion   int    `json:"rulesVersion"`
	CommittedAt    string `json:"committedAt"`
}
type RecoveryPauseRequest struct {
	Schema             string `json:"schema"`
	WorkspaceID        string `json:"workspaceId"`
	RunID              string `json:"runId"`
	ExpectedRevision   int64  `json:"expectedRevision"`
	ExpectedRecordHash string `json:"expectedRecordHash"`
}
type BindingReconciliationStore interface {
	PreviewBindingReconciliation(context.Context, string, string, string, string) (BindingReconciliationPreview, error)
	ApplyBindingReconciliation(context.Context, PreparedBindingReconciliation) ([]byte, error)
	ReadBindingSettlementReceipt(context.Context, string, string, string) ([]byte, error)
	PauseReconciledRun(context.Context, RecoveryPauseRequest) ([]byte, error)
}

func ParseBindingReconciliation(raw []byte) (PreparedBindingReconciliation, error) {
	var v BindingReconciliationRequest
	if !utf8.Valid(raw) || json.Unmarshal(raw, &v) != nil {
		return PreparedBindingReconciliation{}, Failure(ErrorInputInvalid, "reconciliation request is invalid", nil)
	}
	exact, err := canonicaljson.Encode(v)
	safe := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	hash := regexp.MustCompile(`^[0-9a-f]{64}$`)
	if err != nil || !bytes.Equal(append(exact, '\n'), raw) || v.Schema != BindingReconciliationSchema ||
		!safe.MatchString(v.WorkspaceID) || !safe.MatchString(v.RunID) ||
		!regexp.MustCompile(`^WFRUNNER-BINDING-[0-9a-f]{64}$`).MatchString(v.BindingID) || !hash.MatchString(v.StageHash) ||
		(v.Outcome != "committed" && v.Outcome != "not_committed") || v.RulesVersion != 1 {
		return PreparedBindingReconciliation{}, Failure(ErrorInputInvalid, "reconciliation request fields or bytes are invalid", nil)
	}
	h := sha256.Sum256(raw)
	return PreparedBindingReconciliation{Value: v, ExactBytes: append([]byte(nil), raw...), Hash: h[:], IdempotencyKey: BindingReconciliationKeyPrefix + hex.EncodeToString(h[:])}, nil
}
