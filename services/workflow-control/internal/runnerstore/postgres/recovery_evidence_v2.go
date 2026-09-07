package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sort"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
	"github.com/jackc/pgx/v5"
)

func (repository *Repository) ReadRecoveryEvidenceV2(ctx context.Context, workspace, run, binding, after, snapshot string) (runnerstore.RecoveryEvidenceV2, error) {
	result := runnerstore.RecoveryEvidenceV2{Schema: runnerstore.RecoveryEvidenceV2Schema, WorkspaceID: workspace, RunID: run, Complete: binding == "", Records: []runnerstore.RecoveryEvidenceRecord{}}
	if repository.schemaVersion < 10 {
		return result, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "recovery evidence v2 requires schema 10", nil)
	}
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, databaseFailure("begin recovery v2 snapshot", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var epoch int64
	var build []byte
	err = tx.QueryRow(ctx, `SELECT routing_epoch,authority_build_hash FROM workflow_runner_jobs WHERE workspace_id=$1 AND workflow_run_id=$2 ORDER BY job_id LIMIT 1`, workspace, run).Scan(&epoch, &build)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, runnerstore.Failure(runnerstore.ErrorNotFound, "run recovery evidence was not found", nil)
	}
	if err != nil {
		return result, databaseFailure("read recovery v2 route", err)
	}
	result.Route = runnerbindingcontract.Record{"backend": "go", "authority": "workflow-control", "routingEpoch": epoch, "authorityBuildHash": hex.EncodeToString(build)}
	var mismatch bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_runner_jobs WHERE workspace_id=$1 AND workflow_run_id=$2 AND (authority_backend<>'go' OR workflow_authority<>'workflow-control' OR routing_epoch<>$3 OR authority_build_hash<>$4))`, workspace, run, epoch, build).Scan(&mismatch); err != nil {
		return result, databaseFailure("verify recovery route", err)
	}
	if mismatch {
		return result, runnerstore.Failure(runnerstore.ErrorReconciliation, "run recovery routes disagree", nil)
	}
	rows, err := tx.Query(ctx, `SELECT `+authorityBindingViewColumns+` FROM workflow_runner_authority_bindings WHERE workspace_id=$1 AND run_id=$2 AND ($3='' OR binding_id=$3) ORDER BY binding_id`, workspace, run, binding)
	if err != nil {
		return result, databaseFailure("read recovery v2 bindings", err)
	}
	views := []runnerstore.V2AuthorityBindingView{}
	for rows.Next() {
		v, e := scanAuthorityBindingView(rows)
		if e != nil {
			rows.Close()
			return result, databaseFailure("scan recovery v2 binding", e)
		}
		views = append(views, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, databaseFailure("iterate recovery v2 bindings", err)
	}
	if binding != "" && len(views) == 0 {
		return result, runnerstore.Failure(runnerstore.ErrorNotFound, "recovery binding was not found", nil)
	}
	records := []runnerstore.RecoveryEvidenceRecord{}
	for _, v := range views {
		if err = validateRecoveredBinding(v); err != nil {
			return result, err
		}
		stage, e := runnerbindingcontract.ParseStageBytes(v.ExactStageBytes)
		if e != nil {
			return result, e
		}
		if bindingString(stage, "workspaceId") != workspace || bindingString(stage, "runId") != run || bindingInt(bindingRecord(stage, "route"), "routingEpoch") != epoch || bindingString(bindingRecord(stage, "route"), "authorityBuildHash") != hex.EncodeToString(build) {
			return result, runnerstore.Failure(runnerstore.ErrorReconciliation, "recovery binding identity differs", nil)
		}
		entry := runnerstore.RecoveryBinding{BindingID: v.BindingID, State: v.State, Stage: string(v.ExactStageBytes), StageReceipt: string(v.ExactStageReceipt)}
		if len(v.ExactResolutionBytes) > 0 {
			s := string(v.ExactResolutionBytes)
			entry.Resolution = &s
		}
		if len(v.ExactResolutionReceipt) > 0 {
			s := string(v.ExactResolutionReceipt)
			entry.ResolutionReceipt = &s
		}
		records = append(records, runnerstore.RecoveryEvidenceRecord{Key: "binding." + v.BindingID, Kind: "binding", Value: entry})
		var receipt []byte
		e = tx.QueryRow(ctx, `SELECT exact_receipt_bytes FROM workflow_runner_binding_settlements WHERE binding_id=$1`, v.BindingID).Scan(&receipt)
		if e == nil {
			if _, e := validateBindingSettlement(receipt, v); e != nil {
				return result, e
			}
			records = append(records, runnerstore.RecoveryEvidenceRecord{Key: "settlement." + v.BindingID, Kind: "settlement", Value: string(receipt)})
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return result, databaseFailure("read recovery settlement", e)
		} else if v.State != "completed" {
			records = append(records, runnerstore.RecoveryEvidenceRecord{Key: "diagnostic." + v.BindingID, Kind: "diagnostic", Value: runnerstore.RecoveryDiagnostic{BindingID: v.BindingID, Operation: string(v.Operation), State: v.State}})
		}
	}
	active, err := tx.Query(ctx, `SELECT l.attempt_id FROM workflow_runner_leases l JOIN workflow_runner_jobs j ON j.workspace_id=l.workspace_id AND j.job_id=l.job_id
 WHERE j.workspace_id=$1 AND j.workflow_run_id=$2 AND l.state IN ('offered','active','cancelling') AND l.lease_expires_at>clock_timestamp() ORDER BY l.attempt_id`, workspace, run)
	if err != nil {
		return result, databaseFailure("read recovery active attempts", err)
	}
	for active.Next() {
		var id string
		if err = active.Scan(&id); err != nil {
			active.Close()
			return result, databaseFailure("scan recovery active attempts", err)
		}
		records = append(records, runnerstore.RecoveryEvidenceRecord{Key: "attempt." + id, Kind: "active_attempt", Value: id})
	}
	err = active.Err()
	active.Close()
	if err != nil {
		return result, databaseFailure("iterate recovery attempts", err)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Key < records[j].Key })
	digest := sha256.New()
	identity, _ := canonicaljson.Encode([]any{workspace, run, result.Route})
	_, _ = digest.Write(identity)
	for _, r := range records {
		raw, e := canonicaljson.Encode(r)
		if e != nil {
			return result, e
		}
		_, _ = digest.Write(raw)
	}
	result.Snapshot = hex.EncodeToString(digest.Sum(nil))
	if snapshot != "" && snapshot != result.Snapshot {
		return result, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "recovery snapshot changed; restart the query", nil)
	}
	for _, record := range records {
		if record.Key <= after {
			continue
		}
		candidate := result
		candidate.Records = append(append([]runnerstore.RecoveryEvidenceRecord(nil), result.Records...), record)
		// Reserve the real cursor field before measuring the actual encoded bytes.
		cursor := record.Key
		candidate.NextCursor = &cursor
		candidate.Complete = false
		encoded, e := canonicaljson.Encode(candidate)
		if e != nil {
			return result, e
		}
		if len(encoded)+1 > runnerstore.RecoveryEvidenceMaxResponseBytes {
			if len(result.Records) == 0 {
				return result, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "one recovery record exceeds the response contract", nil)
			}
			cursor = result.Records[len(result.Records)-1].Key
			result.NextCursor = &cursor
			result.Complete = false
			break
		}
		result.Records = candidate.Records
	}
	return result, nil
}
