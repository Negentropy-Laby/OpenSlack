package runnerstore

import (
	"context"
	"strconv"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

const RecoveryEvidenceSchema = "openslack.workflow_runner_recovery_evidence.v1"
const RecoveryEvidenceV2Schema = "openslack.workflow_runner_recovery_evidence.v2"
const RecoveryEvidenceV3Schema = "openslack.workflow_runner_recovery_evidence.v3"
const RecoveryEvidenceV3MediaType = "application/vnd.openslack.workflow-run-recovery-evidence.v3+json"
const RecoveryEvidenceMaxResponseBytes = 2 * 1024 * 1024

// ParseRecoveryReadPoint preserves the PostgreSQL BIGINT version and exact
// database timestamp across continuation requests, including versions above 2^53.
func ParseRecoveryReadPoint(version, at string) (int64, time.Time, error) {
	revision, err := strconv.ParseInt(version, 10, 64)
	readAt, timeErr := time.Parse("2006-01-02T15:04:05.000Z", at)
	if err != nil || revision < 1 || strconv.FormatInt(revision, 10) != version || timeErr != nil || CanonicalTimestamp(readAt) != at {
		return 0, time.Time{}, Failure(ErrorInputInvalid, "recovery read point is invalid", nil)
	}
	return revision, readAt, nil
}

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

type RecoveryEvidenceV3 struct {
	Schema          string                       `json:"schema"`
	WorkspaceID     string                       `json:"workspaceId"`
	RunID           string                       `json:"runId"`
	Route           runnerbindingcontract.Record `json:"route"`
	Complete        bool                         `json:"complete"`
	Snapshot        string                       `json:"snapshot"`
	NextCursor      *string                      `json:"nextCursor"`
	Records         []RecoveryEvidenceRecord     `json:"records"`
	RecoveryVersion string                       `json:"recoveryVersion"`
	ReadAt          string                       `json:"readAt"`
}

type RecoveryEvidenceV3Query struct {
	WorkspaceID     string
	RunID           string
	BindingID       string
	After           string
	Snapshot        string
	RecoveryVersion string
	ReadAt          string
}

type RecoveryEvidenceV3Page struct {
	Evidence RecoveryEvidenceV3
	Bytes    []byte
}

type RecoveryEvidenceV3Store interface {
	ReadRecoveryEvidenceV3(context.Context, RecoveryEvidenceV3Query) (RecoveryEvidenceV3Page, error)
}
