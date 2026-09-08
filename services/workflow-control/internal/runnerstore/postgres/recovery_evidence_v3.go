package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
	"github.com/jackc/pgx/v5"
)

// Prefix fields share the same row and transaction as the full binding view.
// Bounded database prefetch, independent of the 2 MiB wire limit.
const recoveryRecordFetchBatch = 16

type recoveryPageRow struct {
	row     pgx.Row
	key     *string
	receipt *[]byte
}

func (r recoveryPageRow) Scan(dest ...any) error {
	return r.row.Scan(append([]any{r.key, r.receipt}, dest...)...)
}

func (repository *Repository) ReadRecoveryEvidenceV3(ctx context.Context, q runnerstore.RecoveryEvidenceV3Query) (runnerstore.RecoveryEvidenceV3Page, error) {
	return repository.readRecoveryEvidencePage(ctx, q, runnerstore.RecoveryEvidenceMaxResponseBytes, recoveryRecordFetchBatch)
}

func (repository *Repository) readRecoveryEvidencePage(ctx context.Context, q runnerstore.RecoveryEvidenceV3Query, limit, batchSize int) (runnerstore.RecoveryEvidenceV3Page, error) {
	result := runnerstore.RecoveryEvidenceV3Page{}
	if repository.schemaVersion < 11 {
		return result, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "recovery v3 requires schema 11", nil)
	}
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return result, databaseFailure("begin recovery page", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var version, epoch int64
	var build []byte
	var conflict bool
	var now time.Time
	err = tx.QueryRow(ctx, `SELECT revision,COALESCE(routing_epoch,0),authority_build_hash,route_conflict,clock_timestamp()
 FROM workflow_runner_recovery_versions WHERE workspace_id=$1 AND run_id=$2`, q.WorkspaceID, q.RunID).Scan(&version, &epoch, &build, &conflict, &now)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, runnerstore.Failure(runnerstore.ErrorNotFound, "run recovery evidence was not found", nil)
	}
	if err != nil {
		return result, databaseFailure("read recovery version", err)
	}
	if conflict || epoch < 1 || len(build) != 32 {
		return result, runnerstore.Failure(runnerstore.ErrorReconciliation, "run recovery routes disagree", nil)
	}
	readAt := now.UTC().Truncate(time.Millisecond)
	if q.After != "" {
		_, readAt, err = runnerstore.ParseRecoveryReadPoint(q.RecoveryVersion, q.ReadAt)
		if err != nil || readAt.After(now) || q.RecoveryVersion == "" || q.Snapshot == "" {
			return result, runnerstore.Failure(runnerstore.ErrorInputInvalid, "recovery continuation is invalid", err)
		}
		if q.RecoveryVersion != strconv.FormatInt(version, 10) {
			return result, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "recovery version changed; restart query", nil)
		}
	} else if q.RecoveryVersion != "" || q.ReadAt != "" || q.Snapshot != "" {
		return result, runnerstore.Failure(runnerstore.ErrorInputInvalid, "initial recovery request contains continuation fields", nil)
	}
	if q.BindingID != "" {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workflow_runner_authority_bindings WHERE workspace_id=$1 AND run_id=$2 AND binding_id=$3)`, q.WorkspaceID, q.RunID, q.BindingID).Scan(&exists); err != nil {
			return result, databaseFailure("find recovery binding", err)
		}
		if !exists {
			return result, runnerstore.Failure(runnerstore.ErrorNotFound, "recovery binding was not found", nil)
		}
	}
	view := runnerstore.RecoveryEvidenceV3{
		Schema: runnerstore.RecoveryEvidenceV3Schema, WorkspaceID: q.WorkspaceID, RunID: q.RunID, Complete: q.BindingID == "",
		Route: runnerbindingcontract.Record{"backend": "go", "authority": "workflow-control", "routingEpoch": epoch, "authorityBuildHash": hex.EncodeToString(build)}, Records: []runnerstore.RecoveryEvidenceRecord{},
		RecoveryVersion: strconv.FormatInt(version, 10), ReadAt: runnerstore.CanonicalTimestamp(readAt)}
	identity, err := canonicaljson.Encode([]any{view.Schema, q.WorkspaceID, q.RunID, q.BindingID, view.Route, view.RecoveryVersion, view.ReadAt})
	if err != nil {
		return result, err
	}
	sum := sha256.Sum256(identity)
	view.Snapshot = hex.EncodeToString(sum[:])
	if q.After != "" && q.Snapshot != view.Snapshot {
		return result, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "recovery continuation belongs to another query", nil)
	}
	page, err := runnerstore.NewCanonicalArrayPage(canonicaljson.Object{
		"schema": view.Schema, "workspaceId": view.WorkspaceID, "runId": view.RunID, "route": view.Route,
		"complete": view.Complete, "snapshot": view.Snapshot, "recoveryVersion": view.RecoveryVersion, "readAt": view.ReadAt,
	}, "records", limit)
	if err != nil {
		return result, err
	}
	more := false
	// Each prefix is an indexed, ordered stream. Nothing before the keyset cursor
	// is decoded; a byte-full page stops the current stream before opening later ones.
	for _, kind := range []string{"attempt", "binding", "diagnostic", "settlement"} {
		if q.After >= kind+"/" {
			// Exclude earlier streams before querying. A small-table sequential
			// plan must not rescan expired attempts on every later binding page.
			continue
		}
		after := q.After
		for {
			count := 0
			var rows pgx.Rows
			if kind == "attempt" {
				rows, err = tx.Query(ctx, `SELECT record_key,attempt_id FROM workflow_runner_recovery_records
       WHERE workspace_id=$1 AND run_id=$2 AND record_key>$3 COLLATE "C"
       AND record_key>='attempt.' AND record_key<'attempt/' AND lease_expires_at>$4 ORDER BY record_key LIMIT $5`, q.WorkspaceID, q.RunID, after, readAt, batchSize)
			} else {
				rows, err = tx.Query(ctx, `SELECT r.record_key,s.exact_receipt_bytes,`+qualifiedAuthorityBindingViewColumns("b")+`
       FROM workflow_runner_recovery_records r JOIN workflow_runner_authority_bindings b ON b.binding_id=r.binding_id
       LEFT JOIN workflow_runner_binding_settlements s ON s.binding_id=b.binding_id
       WHERE r.workspace_id=$1 AND r.run_id=$2 AND r.record_key>$3 COLLATE "C"
       AND r.record_key>=($4||'.') COLLATE "C" AND r.record_key<($4||'/') COLLATE "C"
       AND ($5='' OR r.binding_id=$5) ORDER BY r.record_key LIMIT $6`, q.WorkspaceID, q.RunID, after, kind, q.BindingID, batchSize)
			}
			if err != nil {
				return result, databaseFailure("read recovery record page", err)
			}
			for rows.Next() {
				count++
				var record runnerstore.RecoveryEvidenceRecord
				if kind == "attempt" {
					var attempt string
					err = rows.Scan(&record.Key, &attempt)
					record.Kind, record.Value = "active_attempt", attempt
				} else {
					var receipt []byte
					var v runnerstore.V2AuthorityBindingView
					v, err = scanAuthorityBindingView(recoveryPageRow{row: rows, key: &record.Key, receipt: &receipt})
					if err == nil {
						indexKey := record.Key
						record, err = recoveryV3BindingRecord(v, receipt, kind, view)
						if err == nil && record.Key != indexKey {
							err = runnerstore.Failure(runnerstore.ErrorReconciliation, "recovery record index identity differs", nil)
						}
					}
				}
				if err != nil {
					rows.Close()
					return result, err
				}
				var fits bool
				fits, err = page.Add(record, record.Key)
				if err != nil {
					rows.Close()
					return result, err
				}
				if !fits {
					more = true
					break
				}
				view.Records = append(view.Records, record)
				after = record.Key
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return result, databaseFailure("iterate recovery record page", err)
			}
			if more || count < batchSize {
				break
			}
		}
		if more {
			break
		}
	}
	result.Bytes, view.NextCursor, err = page.Finish(more)
	if err != nil {
		return result, err
	}
	view.Complete = q.BindingID == "" && !more
	view.Records = view.Records[:page.Count()]
	result.Evidence = view
	if err = tx.Commit(ctx); err != nil {
		return runnerstore.RecoveryEvidenceV3Page{}, databaseFailure("finish recovery page", err)
	}
	return result, nil
}

func recoveryV3BindingRecord(v runnerstore.V2AuthorityBindingView, receipt []byte, kind string, view runnerstore.RecoveryEvidenceV3) (runnerstore.RecoveryEvidenceRecord, error) {
	record := runnerstore.RecoveryEvidenceRecord{Key: kind + "." + v.BindingID, Kind: kind}
	if err := validateRecoveredBinding(v); err != nil {
		return record, err
	}
	stage, err := runnerbindingcontract.ParseStageBytes(v.ExactStageBytes)
	if err != nil {
		return record, err
	}
	if v.WorkspaceID != view.WorkspaceID || v.RunID != view.RunID || bindingString(stage, "workspaceId") != view.WorkspaceID || bindingString(stage, "runId") != view.RunID ||
		bindingInt(bindingRecord(stage, "route"), "routingEpoch") != view.Route["routingEpoch"] || bindingString(bindingRecord(stage, "route"), "authorityBuildHash") != view.Route["authorityBuildHash"] {
		return record, runnerstore.Failure(runnerstore.ErrorReconciliation, "recovery binding identity differs", nil)
	}
	if len(receipt) > 0 {
		if _, err = validateBindingSettlement(receipt, v); err != nil {
			return record, err
		}
	}
	switch kind {
	case "binding":
		entry := runnerstore.RecoveryBinding{BindingID: v.BindingID, State: v.State, Stage: string(v.ExactStageBytes), StageReceipt: string(v.ExactStageReceipt)}
		if len(v.ExactResolutionBytes) > 0 {
			s := string(v.ExactResolutionBytes)
			entry.Resolution = &s
		}
		if len(v.ExactResolutionReceipt) > 0 {
			s := string(v.ExactResolutionReceipt)
			entry.ResolutionReceipt = &s
		}
		record.Value = entry
	case "diagnostic":
		if len(receipt) > 0 || v.State == "completed" {
			return record, runnerstore.Failure(runnerstore.ErrorReconciliation, "recovery diagnostic index differs", nil)
		}
		record.Value = runnerstore.RecoveryDiagnostic{BindingID: v.BindingID, Operation: string(v.Operation), State: v.State}
	case "settlement":
		if len(receipt) == 0 {
			return record, runnerstore.Failure(runnerstore.ErrorReconciliation, "recovery settlement index differs", nil)
		}
		record.Value = string(receipt)
	}
	return record, nil
}
