package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func (repository *Repository) RecordProcessExit(ctx context.Context, input runnerstore.ProcessExitInput) (runnerstore.JobView, error) {
	for label, value := range map[string]string{
		"workspaceId": input.WorkspaceID, "jobId": input.JobID,
		"attemptId": input.AttemptID, "leaseId": input.LeaseID,
	} {
		if err := validateID(value, label); err != nil {
			return runnerstore.JobView{}, err
		}
	}
	if input.FencingToken < 1 || input.FencingToken > runnerprotocol.MaxSafeInteger {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "process exit fence is invalid", nil)
	}
	if input.Class != runnerstore.ProcessExitedCleanly && input.Class != runnerstore.ProcessCrashed && input.Class != runnerstore.ProcessForced {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "process exit class is invalid", nil)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.JobView{}, databaseFailure("begin process exit", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, "process-exit\x00"+input.AttemptID, input.WorkspaceID, input.JobID); err != nil {
		return runnerstore.JobView{}, err
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, input.WorkspaceID, input.JobID))
	if err != nil {
		// A terminal event already cleared the active lifecycle. Return the job
		// view rather than overwriting receipt-proven terminal evidence.
		view, readErr := readJobView(tx.QueryRow(ctx, jobViewSQL, input.WorkspaceID, input.JobID))
		if readErr == nil && (view.State == runnerstore.JobTerminal || view.State == runnerstore.JobReconciliationRequired) {
			return view, nil
		}
		return runnerstore.JobView{}, err
	}
	v2AuthorityOutstanding, err := hasOutstandingV2AuthorityEvent(ctx, tx, input.AttemptID)
	if err != nil {
		return runnerstore.JobView{}, err
	}
	if current.jobState == runnerstore.JobReconciliationRequired ||
		(current.jobState == runnerstore.JobTerminal && !v2AuthorityOutstanding) {
		// Settled terminal evidence is authoritative. A terminal receipt whose
		// delivery is uncertain is not settled: the worker may have observed it,
		// so process exit must latch reconciliation instead of returning terminal.
		return readJobView(tx.QueryRow(ctx, jobViewSQL, input.WorkspaceID, input.JobID))
	}
	if current.currentFence != input.FencingToken || current.currentAttemptID != input.AttemptID {
		return runnerstore.JobView{}, repository.staleFence("process exit belongs to a stale attempt", nil)
	}
	var storedLeaseID string
	if err := tx.QueryRow(ctx, `SELECT lease_id FROM workflow_runner_leases WHERE attempt_id=$1`, input.AttemptID).Scan(&storedLeaseID); err != nil {
		return runnerstore.JobView{}, databaseFailure("read process exit lease", err)
	}
	if storedLeaseID != input.LeaseID {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "process exit lease differs", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.JobView{}, err
	}
	if !input.ObservedAt.IsZero() && input.ObservedAt.UTC().After(now.Add(time.Second)) {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "process exit observation is in the future", nil)
	}

	jobState := runnerstore.JobTerminal
	attemptState := runnerstore.AttemptCrashed
	leaseState := "released"
	terminalStatus := string(runnerprotocol.TerminalFailed)
	terminalReason := "process_crash"
	var reconciliationID any
	if current.openEffectCount > 0 || v2AuthorityOutstanding {
		value, insertErr := insertProcessReconciliation(ctx, tx, input, now)
		if insertErr != nil {
			return runnerstore.JobView{}, insertErr
		}
		jobState, attemptState = runnerstore.JobReconciliationRequired, runnerstore.AttemptReconciliationRequired
		terminalStatus, terminalReason, reconciliationID = string(runnerprotocol.TerminalReconciliationRequired), "commit_outcome_unknown", value
		if v2AuthorityOutstanding {
			if _, updateErr := tx.Exec(ctx, `UPDATE workflow_runner_v2_event_inbox
SET state='reconciliation_required',reconciliation_id=$1,updated_at=$2
WHERE attempt_id=$3 AND state IN ('pending_authority','authority_committed','reconciliation_required')`, value, now, input.AttemptID); updateErr != nil {
				return runnerstore.JobView{}, mapWriteFailure("latch v2 process reconciliation", updateErr)
			}
		}
	} else if !current.executionStarted {
		if cancelReason, ok := activeCancelReason(ctx, tx, input.AttemptID); ok {
			jobState, attemptState = runnerstore.JobTerminal, runnerstore.AttemptTerminal
			terminalStatus, terminalReason = cancelledTerminal(cancelReason)
		} else {
			// No JavaScript execution was authorized by a durable lease_accept
			// receipt. It is safe to retry, but only through the durable bounded
			// dispatch backoff so a broken descriptor cannot hot-loop forever.
			jobState, attemptState, leaseState = runnerstore.JobQueued, runnerstore.AttemptCrashed, "released"
			terminalStatus, terminalReason = "", ""
			if current.dispatchFailures+1 >= runnerstore.MaxDispatchFailures {
				value, insertErr := insertProcessReconciliation(ctx, tx, input, now)
				if insertErr != nil {
					return runnerstore.JobView{}, insertErr
				}
				jobState, attemptState = runnerstore.JobReconciliationRequired, runnerstore.AttemptReconciliationRequired
				terminalStatus, terminalReason, reconciliationID = string(runnerprotocol.TerminalReconciliationRequired), "commit_outcome_unknown", value
			}
		}
	} else if cancelReason, ok := activeCancelReason(ctx, tx, input.AttemptID); ok {
		attemptState = runnerstore.AttemptTerminal
		terminalStatus, terminalReason = cancelledTerminal(cancelReason)
	}

	if _, err := tx.Exec(ctx, `
UPDATE workflow_runner_attempts
SET state=$1, process_exit_class=$2, finished_at=$3, updated_at=$3
WHERE attempt_id=$4`, string(attemptState), string(input.Class), now, input.AttemptID); err != nil {
		return runnerstore.JobView{}, mapWriteFailure("record runner process exit", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE workflow_runner_leases SET state=$1, updated_at=$2 WHERE lease_id=$3`, leaseState, now, input.LeaseID); err != nil {
		return runnerstore.JobView{}, mapWriteFailure("release process exit lease", err)
	}
	var terminalStatusValue, terminalReasonValue any
	if terminalStatus != "" {
		terminalStatusValue, terminalReasonValue = terminalStatus, terminalReason
	}
	if _, err := tx.Exec(ctx, jobEventUpdateSQL,
		string(jobState), terminalStatusValue, terminalReasonValue, nil, reconciliationID,
		now, input.WorkspaceID, input.JobID, current.jobRevision); err != nil {
		return runnerstore.JobView{}, mapWriteFailure("record process exit job state", err)
	}
	if !current.executionStarted && jobState != runnerstore.JobTerminal {
		if err := applyDispatchFailure(ctx, tx, input.WorkspaceID, input.JobID, input.AttemptID, current.dispatchFailures+1, "process_crash", now); err != nil {
			return runnerstore.JobView{}, err
		}
	}
	if err := repository.commit(ctx, tx); err != nil {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "process exit commit outcome is unknown", err)
	}
	return repository.ReadJob(ctx, input.WorkspaceID, input.JobID)
}

func (repository *Repository) RecoverExpired(ctx context.Context, input runnerstore.RecoverExpiredInput) ([]runnerstore.RecoveryResult, error) {
	if input.Limit < 1 || input.Limit > 1000 {
		return nil, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "recovery limit is invalid", nil)
	}
	rows, err := repository.pool.Query(ctx, `
SELECT l.workspace_id, l.job_id, l.attempt_id, l.lease_id, l.fencing_token,
       a.execution_started, a.open_effect_count
FROM workflow_runner_leases l
JOIN workflow_runner_attempts a ON a.attempt_id=l.attempt_id
WHERE l.state IN ('offered','active','cancelling') AND l.lease_expires_at <= clock_timestamp()
ORDER BY l.lease_expires_at, l.lease_id
LIMIT $1`, input.Limit)
	if err != nil {
		return nil, databaseFailure("scan expired runner leases", err)
	}
	type candidate struct {
		workspaceID, jobID, attemptID, leaseID string
		fence                                  int64
		executionStarted                       bool
		openEffects                            int64
	}
	var candidates []candidate
	for rows.Next() {
		var value candidate
		if err := rows.Scan(&value.workspaceID, &value.jobID, &value.attemptID, &value.leaseID, &value.fence, &value.executionStarted, &value.openEffects); err != nil {
			rows.Close()
			return nil, databaseFailure("read expired runner lease", err)
		}
		candidates = append(candidates, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, databaseFailure("iterate expired runner leases", err)
	}
	rows.Close()
	results := make([]runnerstore.RecoveryResult, 0, len(candidates))
	for _, value := range candidates {
		result, recoverErr := repository.recoverExpiredOne(ctx, value.workspaceID, value.jobID, value.attemptID, value.leaseID, value.fence)
		if recoverErr != nil {
			if runnerstore.IsCode(recoverErr, runnerstore.ErrorStaleFence) || runnerstore.IsCode(recoverErr, runnerstore.ErrorNotFound) {
				continue
			}
			return nil, recoverErr
		}
		results = append(results, result)
	}
	return results, nil
}

func (repository *Repository) recoverExpiredOne(ctx context.Context, workspaceID, jobID, attemptID, leaseID string, fence int64) (runnerstore.RecoveryResult, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.RecoveryResult{}, databaseFailure("begin expired lease recovery", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, "expired\x00"+attemptID, workspaceID, jobID); err != nil {
		return runnerstore.RecoveryResult{}, err
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, workspaceID, jobID))
	if err != nil {
		return runnerstore.RecoveryResult{}, err
	}
	if current.currentFence != fence || current.currentAttemptID != attemptID {
		return runnerstore.RecoveryResult{}, repository.staleFence("expired lease is no longer current", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.RecoveryResult{}, err
	}
	if now.Before(current.leaseExpiresAt) {
		return runnerstore.RecoveryResult{}, runnerstore.Failure(runnerstore.ErrorConflict, "lease no longer qualifies as expired", nil)
	}
	result := runnerstore.RecoveryResult{WorkspaceID: workspaceID, JobID: jobID, AttemptID: attemptID, LeaseID: leaseID, PreviousFence: fence}
	v2AuthorityOutstanding, err := hasOutstandingV2AuthorityEvent(ctx, tx, attemptID)
	if err != nil {
		return result, err
	}
	if v2AuthorityOutstanding {
		reconciliationID, insertErr := insertProcessReconciliation(ctx, tx, runnerstore.ProcessExitInput{
			WorkspaceID: workspaceID, JobID: jobID, AttemptID: attemptID, LeaseID: leaseID,
			FencingToken: fence, Class: runnerstore.ProcessCrashed, ObservedAt: now,
		}, now)
		if insertErr != nil {
			return result, insertErr
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_v2_event_inbox
SET state='reconciliation_required',reconciliation_id=$1,updated_at=$2
WHERE attempt_id=$3 AND state IN ('pending_authority','authority_committed','reconciliation_required')`, reconciliationID, now, attemptID); err != nil {
			return result, mapWriteFailure("latch expired v2 reconciliation", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_attempts SET state='reconciliation_required',finished_at=$1,updated_at=$1 WHERE attempt_id=$2`, now, attemptID); err != nil {
			return result, mapWriteFailure("reconcile expired v2 attempt", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_leases SET state='released',updated_at=$1 WHERE lease_id=$2`, now, leaseID); err != nil {
			return result, mapWriteFailure("release expired v2 lease", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_jobs SET state='reconciliation_required',revision=revision+1,
terminal_status='reconciliation_required',terminal_reason='commit_outcome_unknown',reconciliation_id=$1,updated_at=$2
WHERE workspace_id=$3 AND job_id=$4 AND revision=$5`, reconciliationID, now, workspaceID, jobID, current.jobRevision); err != nil {
			return result, mapWriteFailure("reconcile expired v2 job", err)
		}
		result.State, result.SafeForNewAttempt = runnerstore.JobReconciliationRequired, false
	} else if !current.executionStarted {
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_attempts SET state='expired', finished_at=$1, updated_at=$1 WHERE attempt_id=$2`, now, attemptID); err != nil {
			return result, mapWriteFailure("expire unstarted attempt", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_leases SET state='expired', updated_at=$1 WHERE lease_id=$2`, now, leaseID); err != nil {
			return result, mapWriteFailure("expire unstarted lease", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_jobs SET state='queued', revision=revision+1, updated_at=$1 WHERE workspace_id=$2 AND job_id=$3 AND revision=$4`, now, workspaceID, jobID, current.jobRevision); err != nil {
			return result, mapWriteFailure("requeue unstarted job", err)
		}
		result.State, result.SafeForNewAttempt = runnerstore.JobQueued, true
	} else {
		// Execution-started jobs cannot be taken over in GS8 because TS RunStore
		// has no Go-owned checkpoint/fence CAS yet. First request cancellation and
		// terminate the exact process; RecordProcessExit will settle failed or
		// reconciliation without automatically replaying the workflow.
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_attempts SET state='cancelling', updated_at=$1 WHERE attempt_id=$2`, now, attemptID); err != nil {
			return result, mapWriteFailure("mark expired attempt cancelling", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_leases SET state='cancelling', updated_at=$1 WHERE lease_id=$2`, now, leaseID); err != nil {
			return result, mapWriteFailure("mark expired lease cancelling", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE workflow_runner_jobs SET state='cancelling', revision=revision+1, updated_at=$1 WHERE workspace_id=$2 AND job_id=$3 AND revision=$4`, now, workspaceID, jobID, current.jobRevision); err != nil {
			return result, mapWriteFailure("mark expired job cancelling", err)
		}
		result.State, result.SafeForNewAttempt = runnerstore.JobCancelling, false
	}
	if err := tx.Commit(ctx); err != nil {
		return result, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "expired recovery commit outcome is unknown", err)
	}
	return result, nil
}

func hasOutstandingV2AuthorityEvent(ctx context.Context, tx pgx.Tx, attemptID string) (bool, error) {
	var relation *string
	if err := tx.QueryRow(ctx, `SELECT to_regclass('workflow_runner_v2_event_inbox')::TEXT`).Scan(&relation); err != nil {
		return false, databaseFailure("detect v2 event inbox", err)
	}
	if relation == nil {
		return false, nil
	}
	var outstanding bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM workflow_runner_v2_event_inbox
WHERE attempt_id=$1 AND state IN ('pending_authority','authority_committed','reconciliation_required'))`, attemptID).Scan(&outstanding); err != nil {
		return false, databaseFailure("read outstanding v2 authority event", err)
	}
	if !outstanding {
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM workflow_runner_control_messages message
JOIN workflow_runner_v2_attempt_bindings binding ON binding.attempt_id=message.attempt_id
WHERE message.attempt_id=$1 AND message.delivery_state IN ('delivering','reconciliation_required'))`, attemptID).Scan(&outstanding); err != nil {
			return false, databaseFailure("read uncertain v2 control delivery", err)
		}
	}
	return outstanding, nil
}

func (repository *Repository) RecoverOrphans(ctx context.Context, supervisorInstanceID string, now time.Time, limit int) ([]runnerstore.RecoveryResult, error) {
	if err := validateID(supervisorInstanceID, "supervisorInstanceId"); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 1000 {
		return nil, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "orphan recovery limit is invalid", nil)
	}
	rows, err := repository.pool.Query(ctx, `
SELECT a.workspace_id, a.job_id, a.attempt_id, l.lease_id, a.fencing_token
FROM workflow_runner_attempts a JOIN workflow_runner_leases l ON l.attempt_id=a.attempt_id
WHERE a.state IN ('offered','accepted','running','cancelling')
  AND a.supervisor_instance_id <> $1
ORDER BY a.created_at, a.attempt_id LIMIT $2`, supervisorInstanceID, limit)
	if err != nil {
		return nil, databaseFailure("scan orphan runner attempts", err)
	}
	var values []runnerstore.RecoveryResult
	for rows.Next() {
		var value runnerstore.RecoveryResult
		if err := rows.Scan(&value.WorkspaceID, &value.JobID, &value.AttemptID, &value.LeaseID, &value.PreviousFence); err != nil {
			rows.Close()
			return nil, databaseFailure("read orphan runner attempt", err)
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, databaseFailure("iterate orphan runner attempts", err)
	}
	rows.Close()
	results := make([]runnerstore.RecoveryResult, 0, len(values))
	for _, value := range values {
		view, exitErr := repository.RecordProcessExit(ctx, runnerstore.ProcessExitInput{
			WorkspaceID: value.WorkspaceID, JobID: value.JobID, AttemptID: value.AttemptID,
			LeaseID: value.LeaseID, FencingToken: value.PreviousFence,
			Class: runnerstore.ProcessCrashed, ObservedAt: now,
		})
		if exitErr != nil {
			if runnerstore.IsCode(exitErr, runnerstore.ErrorStaleFence) {
				continue
			}
			return nil, exitErr
		}
		value.State = view.State
		value.SafeForNewAttempt = view.State == runnerstore.JobQueued
		results = append(results, value)
	}
	return results, nil
}

func activeCancelReason(ctx context.Context, tx pgx.Tx, attemptID string) (string, bool) {
	var reason string
	err := tx.QueryRow(ctx, `SELECT reason FROM workflow_runner_cancel_controls WHERE attempt_id=$1 ORDER BY requested_at DESC LIMIT 1`, attemptID).Scan(&reason)
	return reason, err == nil
}

func cancelledTerminal(reason string) (string, string) {
	if reason == "timeout" {
		return string(runnerprotocol.TerminalTimedOut), "timeout"
	}
	return string(runnerprotocol.TerminalCancelled), "cancelled_by_control"
}

func insertProcessReconciliation(ctx context.Context, tx pgx.Tx, input runnerstore.ProcessExitInput, now time.Time) (string, error) {
	id, err := randomToken("runner-reconciliation")
	if err != nil {
		return "", databaseFailure("generate process reconciliation id", err)
	}
	bytes, err := canonicaljson.Encode(map[string]any{
		"schema":      "openslack.workflow_runner_process_reconciliation.v1",
		"workspaceId": input.WorkspaceID, "jobId": input.JobID, "attemptId": input.AttemptID,
		"leaseId": input.LeaseID, "fencingToken": input.FencingToken, "exitClass": input.Class,
		"observedAt": runnerstore.CanonicalTimestamp(now),
	})
	if err != nil {
		return "", runnerstore.Failure(runnerstore.ErrorInputInvalid, "encode process reconciliation evidence", err)
	}
	digest := sha256.Sum256(bytes)
	if _, err := tx.Exec(ctx, `INSERT INTO workflow_runner_reconciliations (reconciliation_id,workspace_id,job_id,attempt_id,code,evidence_hash,created_at) VALUES ($1,$2,$3,$4,'WORKFLOW_RUNNER_RECONCILIATION_REQUIRED',$5,$6)`, id, input.WorkspaceID, input.JobID, input.AttemptID, digest[:], now); err != nil {
		return "", mapWriteFailure("insert process reconciliation", err)
	}
	return id, nil
}

var _ = hex.EncodeToString
var _ = errors.Is
var _ = fmt.Sprintf
