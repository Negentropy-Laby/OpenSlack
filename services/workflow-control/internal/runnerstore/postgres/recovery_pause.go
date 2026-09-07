package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/jackc/pgx/v5"
)

func (repository *Repository) PauseReconciledRun(ctx context.Context, input runnerstore.RecoveryPauseRequest) ([]byte, error) {
	if input.Schema != "openslack.workflow_runner_recovery_pause.v1" || input.ExpectedRevision < 1 || input.ExpectedRevision >= 9007199254740991 || len(input.ExpectedRecordHash) != 64 {
		return nil, runnerstore.Failure(runnerstore.ErrorInputInvalid, "recovery pause requires an exact expected head", nil)
	}
	if err := validateID(input.WorkspaceID, "workspaceId"); err != nil {
		return nil, err
	}
	if err := validateID(input.RunID, "runId"); err != nil {
		return nil, err
	}
	if repository.schemaVersion < 10 || !repository.v2RuntimeDelivery {
		return nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "recovery pause requires the schema 10 runtime capability", nil)
	}
	// Returning an immutable historical receipt grants no new execution authority.
	// Fresh convergence still requires the live source proof and run locks below.
	var prior, raw []byte
	err := repository.pool.QueryRow(ctx, `SELECT prior_record_hash,exact_receipt_bytes FROM workflow_control_recovery_pauses WHERE workspace_id=$1 AND run_id=$2 AND expected_revision=$3`, input.WorkspaceID, input.RunID, input.ExpectedRevision).Scan(&prior, &raw)
	if err == nil {
		if hex.EncodeToString(prior) != input.ExpectedRecordHash {
			return nil, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "recovery pause expected head differs", nil)
		}
		return raw, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, databaseFailure("read prior recovery pause receipt", err)
	}
	tx, err := repository.reconciliationTx(ctx, input.WorkspaceID, input.RunID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err = lockReconciliationRun(ctx, tx, input.WorkspaceID, input.RunID); err != nil {
		return nil, err
	}
	err = tx.QueryRow(ctx, `SELECT prior_record_hash,exact_receipt_bytes FROM workflow_control_recovery_pauses WHERE workspace_id=$1 AND run_id=$2 AND expected_revision=$3`, input.WorkspaceID, input.RunID, input.ExpectedRevision).Scan(&prior, &raw)
	if err == nil {
		if hex.EncodeToString(prior) != input.ExpectedRecordHash {
			return nil, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "recovery pause expected head differs", nil)
		}
		return raw, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, databaseFailure("read recovery pause receipt", err)
	}
	// Lease writes share the run arbitration lock in schema 10. New leases for
	// old jobs are fenced after this pause; normal resume must create a new job.
	var blocked bool
	err = tx.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM workflow_runner_leases l JOIN workflow_runner_jobs j ON j.job_id=l.job_id AND j.workspace_id=l.workspace_id
   WHERE j.workspace_id=$1 AND j.workflow_run_id=$2 AND l.state IN ('offered','active','cancelling') AND l.lease_expires_at>clock_timestamp())
 OR EXISTS(SELECT 1 FROM workflow_runner_authority_bindings b WHERE b.workspace_id=$1 AND b.run_id=$2 AND b.state<>'completed'
   AND NOT EXISTS(SELECT 1 FROM workflow_runner_binding_settlements s WHERE s.binding_id=b.binding_id))
 OR EXISTS(SELECT 1 FROM workflow_runner_v2_event_inbox i JOIN workflow_runner_jobs j ON j.workspace_id=i.workspace_id AND j.job_id=i.job_id
   WHERE j.workspace_id=$1 AND j.workflow_run_id=$2 AND i.state<>'runner_committed'
    AND NOT EXISTS(SELECT 1 FROM workflow_runner_authority_bindings b JOIN workflow_runner_binding_settlements s USING(binding_id) WHERE b.target_event_id=i.event_id))
 OR EXISTS(SELECT 1 FROM workflow_control_budget_reconciliations r WHERE r.workspace_id=$1 AND r.run_id=$2 AND r.status='open')
 OR EXISTS(SELECT 1 FROM workflow_control_budget_reservations r WHERE r.workspace_id=$1 AND r.run_id=$2 AND r.status='open')
 OR EXISTS(SELECT 1 FROM workflow_control_reconciliations r JOIN workflow_control_transition_receipts receipt ON receipt.receipt_id=r.receipt_id
   WHERE r.workspace_id=$1 AND r.run_id=$2 AND r.status='open' AND NOT EXISTS(
    SELECT 1 FROM workflow_runner_binding_settlements s JOIN workflow_runner_authority_bindings b USING(binding_id)
    WHERE b.workspace_id=r.workspace_id AND b.run_id=r.run_id AND receipt.correlation_id='resume.'||encode(b.stage_hash,'hex')))`, input.WorkspaceID, input.RunID).Scan(&blocked)
	if err != nil {
		return nil, databaseFailure("check whole-run recovery frontier", err)
	}
	if blocked {
		return nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "run still has active ownership or unresolved side effects and bindings", nil)
	}
	if err = verifyRecoveryEffectFrontier(ctx, tx, input.WorkspaceID, input.RunID); err != nil {
		return nil, err
	}
	var recordHash, recordBytes []byte
	var revision int64
	var state string
	err = tx.QueryRow(ctx, `SELECT revision,state,record_hash,canonical_record_bytes FROM workflow_control_runs WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE NOWAIT`, input.WorkspaceID, input.RunID).Scan(&revision, &state, &recordHash, &recordBytes)
	if err != nil {
		return nil, databaseFailure("lock recovery authority head", err)
	}
	if revision != input.ExpectedRevision || hex.EncodeToString(recordHash) != input.ExpectedRecordHash || (state != "running" && state != "resuming") {
		return nil, runnerstore.Failure(runnerstore.ErrorConflict, "recovery pause requires the unchanged running or resuming head", nil)
	}
	var record authoritystore.RunRecord
	if json.Unmarshal(recordBytes, &record) != nil {
		return nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "authority head bytes are invalid", nil)
	}
	canonical, err := canonicaljson.Encode(record)
	digest := sha256.Sum256(recordBytes)
	if err != nil || !bytes.Equal(append(canonical, '\n'), recordBytes) || !bytes.Equal(digest[:], recordHash) || record.Revision != revision || string(record.State) != state || record.WorkspaceID != input.WorkspaceID || record.RunID != input.RunID {
		return nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "authority head bytes differ from their identity", err)
	}
	record.State = "paused"
	record.Revision++
	next, err := canonicaljson.Encode(record)
	if err != nil {
		return nil, err
	}
	next = append(next, '\n')
	nextHash := sha256.Sum256(next)
	var at time.Time
	if err = tx.QueryRow(ctx, `SELECT date_trunc('milliseconds',clock_timestamp())`).Scan(&at); err != nil {
		return nil, databaseFailure("read recovery pause timestamp", err)
	}
	raw, err = canonicaljson.Encode(map[string]any{"schema": "openslack.workflow_runner_recovery_pause_receipt.v1", "workspaceId": input.WorkspaceID, "runId": input.RunID,
		"expectedRevision": revision, "acceptedRevision": record.Revision, "resumeGeneration": record.ResumeGeneration, "priorRecordHash": input.ExpectedRecordHash, "record": string(next), "recordHash": hex.EncodeToString(nextHash[:]), "committedAt": runnerstore.CanonicalTimestamp(at)})
	if err != nil {
		return nil, err
	}
	raw = append(raw, '\n')
	_, err = tx.Exec(ctx, `INSERT INTO workflow_control_recovery_pauses(workspace_id,run_id,expected_revision,accepted_revision,resume_generation,prior_record_hash,exact_record_bytes,record_hash,exact_receipt_bytes,committed_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, input.WorkspaceID, input.RunID, revision, record.Revision, record.ResumeGeneration, recordHash, next, nextHash[:], raw, at)
	if err != nil {
		return nil, databaseFailure("record recovery pause proof", err)
	}
	tag, err := tx.Exec(ctx, `UPDATE workflow_control_runs SET state='paused',revision=$3,record_hash=$4,canonical_record_bytes=$5,updated_at=$6
 WHERE workspace_id=$1 AND run_id=$2 AND revision=$7 AND record_hash=$8`, input.WorkspaceID, input.RunID, record.Revision, nextHash[:], next, at, revision, recordHash)
	if err != nil {
		return nil, databaseFailure("commit exact recovery head CAS", err)
	}
	if tag.RowsAffected() != 1 {
		return nil, runnerstore.Failure(runnerstore.ErrorConflict, "recovery authority head changed", nil)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "recovery pause outcome is unknown; retry the original exact head request", err)
	}
	return raw, nil
}
