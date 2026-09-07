package runnerstore

import (
	"context"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

const RecoveryEvidenceSchema = "openslack.workflow_runner_recovery_evidence.v1"
const RecoveryEvidenceV2Schema = "openslack.workflow_runner_recovery_evidence.v2"
const RecoveryEvidenceMaxResponseBytes = 2 * 1024 * 1024

// Recovery evidence contains exact companion frames and artifact references,
// never checkpoint artifact contents. It proves history, not a current lease.
type RecoveryBinding struct {
	BindingID         string  `json:"bindingId"`
	State             string  `json:"state"`
	Stage             string  `json:"stage"`
	StageReceipt      string  `json:"stageReceipt"`
	Resolution        *string `json:"resolution"`
	ResolutionReceipt *string `json:"resolutionReceipt"`
}

type RecoveryDiagnostic struct {
	BindingID string `json:"bindingId"`
	Operation string `json:"operation"`
	State     string `json:"state"`
}

type RecoveryEvidence struct {
	Schema         string                       `json:"schema"`
	WorkspaceID    string                       `json:"workspaceId"`
	RunID          string                       `json:"runId"`
	Route          runnerbindingcontract.Record `json:"route"`
	Complete       bool                         `json:"complete"`
	Snapshot       string                       `json:"snapshot"`
	NextCursor     *string                      `json:"nextCursor"`
	Bindings       []RecoveryBinding            `json:"bindings"`
	Unfinished     []RecoveryDiagnostic         `json:"unfinished"`
	ActiveAttempts []string                     `json:"activeAttempts"`
}

type RecoveryEvidenceStore interface {
	ReadRecoveryEvidence(context.Context, string, string, string, string, string) (RecoveryEvidence, error)
}

// Every potentially unbounded collection participates in the same record
// stream, so diagnostics and settlements cannot make a page unpageable.
type RecoveryEvidenceRecord struct {
	Key   string `json:"key"`
	Kind  string `json:"kind"`
	Value any    `json:"value"`
}
type RecoveryEvidenceV2 struct {
	Schema      string                       `json:"schema"`
	WorkspaceID string                       `json:"workspaceId"`
	RunID       string                       `json:"runId"`
	Route       runnerbindingcontract.Record `json:"route"`
	Complete    bool                         `json:"complete"`
	Snapshot    string                       `json:"snapshot"`
	NextCursor  *string                      `json:"nextCursor"`
	Records     []RecoveryEvidenceRecord     `json:"records"`
}
type RecoveryEvidenceV2Store interface {
	ReadRecoveryEvidenceV2(context.Context, string, string, string, string, string) (RecoveryEvidenceV2, error)
}
