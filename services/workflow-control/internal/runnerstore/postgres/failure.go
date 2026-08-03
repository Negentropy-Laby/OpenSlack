package postgres

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func (repository *Repository) RecordAttemptFailure(ctx context.Context, input runnerstore.AttemptFailureInput) (runnerstore.JobView, error) {
	for label, value := range map[string]string{"workspaceId": input.WorkspaceID, "jobId": input.JobID, "attemptId": input.AttemptID, "leaseId": input.LeaseID} {
		if err := validateID(value, label); err != nil {
			return runnerstore.JobView{}, err
		}
	}
	if input.FencingToken < 1 || input.FencingToken > runnerprotocol.MaxSafeInteger ||
		(input.Kind != runnerstore.AttemptLaunchFailed && input.Kind != runnerstore.AttemptTerminationUncertain) {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "attempt failure input is invalid", nil)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.JobView{}, databaseFailure("begin attempt failure", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, "attempt-failure\x00"+input.AttemptID, input.WorkspaceID, input.JobID); err != nil {
		return runnerstore.JobView{}, err
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, input.WorkspaceID, input.JobID))
	if err != nil {
		return runnerstore.JobView{}, err
	}
	if current.currentFence != input.FencingToken || current.currentAttemptID != input.AttemptID {
		return runnerstore.JobView{}, repository.staleFence("attempt failure belongs to a stale attempt", nil)
	}
	var leaseID string
	if err := tx.QueryRow(ctx, `SELECT lease_id FROM workflow_runner_leases WHERE attempt_id=$1 FOR UPDATE`, input.AttemptID).Scan(&leaseID); err != nil {
		return runnerstore.JobView{}, databaseFailure("read attempt failure lease", err)
	}
	if leaseID != input.LeaseID {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "attempt failure lease differs", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.JobView{}, err
	}
	if !input.ObservedAt.IsZero() && input.ObservedAt.UTC().After(now.Add(time.Second)) {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "attempt failure observation is in the future", nil)
	}

	jobState := runnerstore.JobQueued
	attemptState := runnerstore.AttemptCrashed
	leaseState := "released"
	var terminalStatus, terminalReason, reconciliationID any
	nextFailures := current.dispatchFailures + 1
	if input.Kind == runnerstore.AttemptTerminationUncertain || nextFailures >= runnerstore.MaxDispatchFailures {
		processInput := runnerstore.ProcessExitInput{WorkspaceID: input.WorkspaceID, JobID: input.JobID, AttemptID: input.AttemptID, LeaseID: input.LeaseID, FencingToken: input.FencingToken, Class: runnerstore.ProcessForced, ObservedAt: now}
		value, insertErr := insertProcessReconciliation(ctx, tx, processInput, now)
		if insertErr != nil {
			return runnerstore.JobView{}, insertErr
		}
		jobState, attemptState = runnerstore.JobReconciliationRequired, runnerstore.AttemptReconciliationRequired
		if input.Kind == runnerstore.AttemptTerminationUncertain {
			leaseState = "cancelling"
		}
		terminalStatus, terminalReason, reconciliationID = string(runnerprotocol.TerminalReconciliationRequired), "commit_outcome_unknown", value
	}
	if _, err := tx.Exec(ctx, `UPDATE workflow_runner_attempts SET state=$1,finished_at=CASE WHEN $1='crashed' THEN $2 ELSE finished_at END,updated_at=$2 WHERE attempt_id=$3`, string(attemptState), now, input.AttemptID); err != nil {
		return runnerstore.JobView{}, mapWriteFailure("record attempt failure", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE workflow_runner_leases SET state=$1,updated_at=$2 WHERE lease_id=$3`, leaseState, now, input.LeaseID); err != nil {
		return runnerstore.JobView{}, mapWriteFailure("record attempt failure lease", err)
	}
	if _, err := tx.Exec(ctx, jobEventUpdateSQL, string(jobState), terminalStatus, terminalReason, nil, reconciliationID, now, input.WorkspaceID, input.JobID, current.jobRevision); err != nil {
		return runnerstore.JobView{}, mapWriteFailure("record attempt failure job", err)
	}
	errorCode := string(input.Kind)
	if err := applyDispatchFailure(ctx, tx, input.WorkspaceID, input.JobID, input.AttemptID, nextFailures, errorCode, now); err != nil {
		return runnerstore.JobView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return runnerstore.JobView{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "attempt failure commit outcome is unknown", err)
	}
	return repository.ReadJob(ctx, input.WorkspaceID, input.JobID)
}

func applyDispatchFailure(ctx context.Context, tx pgx.Tx, workspaceID, jobID, attemptID string, failures int64, code string, now time.Time) error {
	state := "backoff"
	notBefore := now.Add(dispatchBackoff(failures))
	if failures >= runnerstore.MaxDispatchFailures || code == string(runnerstore.AttemptTerminationUncertain) {
		failures = runnerstore.MaxDispatchFailures
		state = "dead"
		notBefore = now
	}
	tag, err := tx.Exec(ctx, `
UPDATE workflow_runner_jobs
SET dispatch_failures=$1,dispatch_not_before=$2,dispatch_state=$3,last_dispatch_error=$4
WHERE workspace_id=$5 AND job_id=$6 AND current_attempt_id=$7`, failures, notBefore, state, normalizedDispatchError(code), workspaceID, jobID, attemptID)
	if err != nil {
		return mapWriteFailure("record runner dispatch failure", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.Failure(runnerstore.ErrorConflict, "runner dispatch failure lost current attempt", nil)
	}
	return nil
}

func normalizedDispatchError(code string) string {
	if code == "lease_rejected" {
		return code
	}
	if code == string(runnerstore.AttemptLaunchFailed) {
		return "launch_failed"
	}
	if code == string(runnerstore.AttemptTerminationUncertain) {
		return "termination_uncertain"
	}
	return "process_crash"
}

func dispatchBackoff(failures int64) time.Duration {
	if failures < 1 {
		failures = 1
	}
	delay := runnerstore.MinDispatchBackoff
	for index := int64(1); index < failures && delay < runnerstore.MaxDispatchBackoff; index++ {
		delay *= 2
	}
	if delay > runnerstore.MaxDispatchBackoff {
		return runnerstore.MaxDispatchBackoff
	}
	return delay
}
