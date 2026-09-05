package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

// A repeatable, read-only snapshot keeps the frontier and unfinished-operation
// diagnostics consistent. The caller must still compare the current run head
// and lease before executing or applying a local repair.
func (repository *Repository) ReadRecoveryEvidence(ctx context.Context, workspaceID, runID, bindingID, afterBindingID, expectedSnapshot string) (runnerstore.RecoveryEvidence, error) {
	result := runnerstore.RecoveryEvidence{Schema: runnerstore.RecoveryEvidenceSchema,
		WorkspaceID: workspaceID, RunID: runID, Complete: bindingID == "",
		Bindings: []runnerstore.RecoveryBinding{}, Unfinished: []runnerstore.RecoveryDiagnostic{}, ActiveAttempts: []string{}}
	if !repository.v2RuntimeDelivery || repository.schemaVersion < 9 {
		return result, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "recovery evidence requires schema 9", nil)
	}
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, databaseFailure("begin recovery evidence snapshot", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	routes, err := tx.Query(ctx, `SELECT DISTINCT authority_backend,workflow_authority,routing_epoch,authority_build_hash
FROM workflow_runner_jobs WHERE workspace_id=$1 AND workflow_run_id=$2`, workspaceID, runID)
	if err != nil {
		return result, databaseFailure("read recovery route", err)
	}
	for routes.Next() {
		var backend, authority string
		var epoch int64
		var build []byte
		if err := routes.Scan(&backend, &authority, &epoch, &build); err != nil {
			routes.Close()
			return result, databaseFailure("scan recovery route", err)
		}
		if result.Route != nil || backend != "go" || authority != "workflow-control" {
			routes.Close()
			return result, runnerstore.Failure(runnerstore.ErrorReconciliation, "run recovery routes disagree", nil)
		}
		result.Route = runnerbindingcontract.Record{"backend": backend, "authority": authority, "routingEpoch": epoch, "authorityBuildHash": hex.EncodeToString(build)}
	}
	if err := routes.Err(); err != nil {
		return result, databaseFailure("iterate recovery route", err)
	}
	routes.Close()
	if result.Route == nil {
		return result, runnerstore.Failure(runnerstore.ErrorNotFound, "run recovery evidence was not found", nil)
	}
	digest := sha256.New()
	pageBytes := 0
	pageFull := false
	rows, err := tx.Query(ctx, `SELECT `+authorityBindingViewColumns+` FROM workflow_runner_authority_bindings
WHERE workspace_id=$1 AND run_id=$2 AND ($3='' OR binding_id=$3)
AND (operation IN ('checkpoint_commit','resume_advance') OR state NOT IN ('completed','aborted'))
ORDER BY binding_id`, workspaceID, runID, bindingID)
	if err != nil {
		return result, databaseFailure("read recovery bindings", err)
	}
	defer rows.Close()
	for rows.Next() {
		view, err := scanAuthorityBindingView(rows)
		if err != nil {
			return result, databaseFailure("scan recovery binding", err)
		}
		if err := validateRecoveredBinding(view); err != nil {
			return result, err
		}
		// Length-delimited exact bytes and lifecycle state bind every page to
		// one immutable history snapshot, including unfinished operations.
		snapshotRow, _ := json.Marshal([]any{view.BindingID, view.State, view.ExactStageBytes, view.ExactStageReceipt, view.ExactResolutionBytes, view.ExactResolutionReceipt})
		_, _ = digest.Write(snapshotRow)
		stage, err := runnerbindingcontract.ParseStageBytes(view.ExactStageBytes)
		if err != nil {
			return result, bindingContractFailure("recovery stage is invalid", err)
		}
		route := bindingRecord(stage, "route")
		if bindingString(stage, "workspaceId") != workspaceID || bindingString(stage, "runId") != runID || bindingString(stage, "bindingId") != view.BindingID ||
			bindingString(route, "authorityBuildHash") != result.Route["authorityBuildHash"] || bindingInt(route, "routingEpoch") != result.Route["routingEpoch"] ||
			!bytes.Equal(view.ExactTargetBytes, []byte(bindingString(bindingRecord(stage, "target"), "body"))) {
			return result, runnerstore.Failure(runnerstore.ErrorReconciliation, "recovery binding identity differs from its index", nil)
		}
		if view.State != "completed" && view.State != "aborted" {
			result.Unfinished = append(result.Unfinished, runnerstore.RecoveryDiagnostic{BindingID: view.BindingID, Operation: string(view.Operation), State: view.State})
		}
		if view.Operation != runnerbindingcontract.OperationCheckpointCommit && view.Operation != runnerbindingcontract.OperationResumeAdvance {
			continue
		}
		if view.BindingID <= afterBindingID {
			continue
		}
		if pageFull {
			continue
		}
		entry := runnerstore.RecoveryBinding{BindingID: view.BindingID, State: view.State, Stage: string(view.ExactStageBytes), StageReceipt: string(view.ExactStageReceipt)}
		if len(view.ExactResolutionBytes) > 0 {
			resolution, receipt := string(view.ExactResolutionBytes), string(view.ExactResolutionReceipt)
			entry.Resolution, entry.ResolutionReceipt = &resolution, &receipt
		}
		encoded, _ := canonicaljson.Encode(entry)
		if pageBytes+len(encoded) >= runnerstore.RecoveryEvidenceMaxResponseBytes && len(result.Bindings) > 0 {
			last := result.Bindings[len(result.Bindings)-1].BindingID
			result.NextCursor, result.Complete, pageFull = &last, false, true
			continue
		}
		pageBytes += len(encoded)
		result.Bindings = append(result.Bindings, entry)
	}
	if err := rows.Err(); err != nil {
		return result, databaseFailure("iterate recovery bindings", err)
	}
	rows.Close()
	if bindingID != "" && len(result.Bindings) == 0 {
		return result, runnerstore.Failure(runnerstore.ErrorNotFound, "recovery binding was not found in this workspace and run", nil)
	}
	active, err := tx.Query(ctx, `SELECT l.attempt_id FROM workflow_runner_leases l JOIN workflow_runner_jobs j ON j.job_id=l.job_id AND j.workspace_id=l.workspace_id
WHERE j.workspace_id=$1 AND j.workflow_run_id=$2 AND l.state IN ('offered','active','cancelling') AND l.lease_expires_at > clock_timestamp() ORDER BY l.attempt_id`, workspaceID, runID)
	if err != nil {
		return result, databaseFailure("read recovery active attempts", err)
	}
	defer active.Close()
	for active.Next() {
		var id string
		if err := active.Scan(&id); err != nil {
			return result, databaseFailure("scan recovery active attempt", err)
		}
		result.ActiveAttempts = append(result.ActiveAttempts, id)
	}
	if err := active.Err(); err != nil {
		return result, databaseFailure("iterate recovery active attempts", err)
	}
	common, _ := json.Marshal([]any{result.WorkspaceID, result.RunID, result.Route, result.Unfinished, result.ActiveAttempts})
	_, _ = digest.Write(common)
	result.Snapshot = hex.EncodeToString(digest.Sum(nil))
	if expectedSnapshot != "" && expectedSnapshot != result.Snapshot {
		return result, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "recovery snapshot changed; restart the query", nil)
	}
	// Count JSON escaping and common diagnostics too, without a guessed buffer.
	for {
		encoded, err := canonicaljson.Encode(result)
		if err != nil {
			return result, databaseFailure("encode recovery page", err)
		}
		if len(encoded)+1 <= runnerstore.RecoveryEvidenceMaxResponseBytes {
			break
		}
		if len(result.Bindings) <= 1 {
			return result, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "one recovery frame or diagnostic set exceeds the response contract", nil)
		}
		result.Bindings = result.Bindings[:len(result.Bindings)-1]
		last := result.Bindings[len(result.Bindings)-1].BindingID
		result.NextCursor, result.Complete = &last, false
	}
	return result, nil
}
