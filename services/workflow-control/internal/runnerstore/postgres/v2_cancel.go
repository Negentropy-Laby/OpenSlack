package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

func (repository *Repository) PrepareV2Cancel(ctx context.Context, lease runnerstore.AttemptLease, control runnerstore.CancelControl) (runnerstore.V2CancelControl, error) {
	if lease.RequiredProtocolVersion != authoritycontract.ProtocolVersion || lease.AttemptID != control.AttemptID ||
		lease.LeaseID != control.LeaseID || lease.FencingToken != control.FencingToken || lease.JobID != control.JobID ||
		lease.WorkspaceID != control.WorkspaceID || lease.WorkflowRunID != control.WorkflowRunID {
		return runnerstore.V2CancelControl{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "v2 cancel does not bind the active lease", nil)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.V2CancelControl{}, databaseFailure("begin v2 cancel binding", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, "v2-cancel\x00"+control.CancelID, control.WorkspaceID, control.JobID); err != nil {
		return runnerstore.V2CancelControl{}, err
	}
	if existing, readErr := readV2CancelBinding(tx.QueryRow(ctx, `SELECT exact_v1_message_hash,exact_v2_message_bytes
FROM workflow_runner_v2_cancel_bindings WHERE cancel_id=$1`, control.CancelID), control); readErr == nil {
		return existing, nil
	} else if !errors.Is(readErr, pgx.ErrNoRows) {
		return runnerstore.V2CancelControl{}, readErr
	}
	var pending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workflow_runner_v2_event_inbox
WHERE attempt_id=$1 AND state IN ('pending_authority','authority_committed','reconciliation_required'))`, control.AttemptID).Scan(&pending); err != nil {
		return runnerstore.V2CancelControl{}, databaseFailure("read v2 cancel event lane", err)
	}
	if pending {
		return runnerstore.V2CancelControl{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "v2 cancellation cannot enter an unsettled authority event lane", nil)
	}
	var backend, authority, buildHash string
	var routingEpoch, runRevision, resumeGeneration int64
	var build []byte
	if err := tx.QueryRow(ctx, `SELECT authority_backend,workflow_authority,routing_epoch,authority_build_hash,current_run_revision,current_resume_generation
FROM workflow_runner_v2_attempt_bindings WHERE attempt_id=$1 FOR UPDATE`, control.AttemptID).Scan(
		&backend, &authority, &routingEpoch, &build, &runRevision, &resumeGeneration); err != nil {
		return runnerstore.V2CancelControl{}, databaseFailure("read v2 cancel authority binding", err)
	}
	buildHash = hex.EncodeToString(build)
	jobID, runID, attemptID, leaseID, fence, sequence := control.JobID, control.WorkflowRunID, control.AttemptID, control.LeaseID, control.FencingToken, control.ControlSequence
	message := authoritycontract.Message{
		Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion,
		Kind: authoritycontract.KindCancelRequest, WorkspaceID: control.WorkspaceID, JobID: &jobID,
		WorkflowRunID: &runID, AttemptID: &attemptID, LeaseID: &leaseID, FencingToken: &fence, Sequence: &sequence,
		AuthorityBackend: &backend, Authority: &authority, RoutingEpoch: &routingEpoch, AuthorityBuildHash: &buildHash,
		RunRevision: &runRevision, ResumeGeneration: &resumeGeneration, EventID: control.Message.EventID,
		CorrelationID: control.Message.CorrelationID, SentAt: control.Message.SentAt, Payload: control.Message.Payload,
	}
	prepared, err := prepareV2Message(message)
	if err != nil {
		return runnerstore.V2CancelControl{}, err
	}
	v1Hash := sha256.Sum256(control.ExactBytes)
	v2Digest, _ := hex.DecodeString(prepared.MessageDigest)
	if _, err := tx.Exec(ctx, `INSERT INTO workflow_runner_v2_cancel_bindings (
cancel_id,control_event_id,attempt_id,authority_backend,workflow_authority,routing_epoch,authority_build_hash,
run_revision,resume_generation,exact_v1_message_hash,v2_message_digest,exact_v2_message_bytes)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, control.CancelID, message.EventID, control.AttemptID,
		backend, authority, routingEpoch, build, runRevision, resumeGeneration, v1Hash[:], v2Digest, []byte(prepared.Body)); err != nil {
		return runnerstore.V2CancelControl{}, mapWriteFailure("insert durable v2 cancel binding", err)
	}
	if repository.v2RuntimeDelivery {
		var pendingDecision bool
		if err := tx.QueryRow(ctx, pendingV2AuthorityDecisionSQL, control.AttemptID).Scan(&pendingDecision); err != nil {
			return runnerstore.V2CancelControl{}, databaseFailure("read v2 cancel decision predecessor", err)
		}
		if pendingDecision {
			return runnerstore.V2CancelControl{}, runnerstore.Failure(runnerstore.ErrorSequenceConflict, "v2 cancel cannot replace an immutable authority decision", nil)
		}
	}
	if err := repository.commit(ctx, tx); err != nil {
		return runnerstore.V2CancelControl{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "v2 cancel binding commit outcome is unknown", err)
	}
	return runnerstore.V2CancelControl{CancelID: control.CancelID, Message: message, ExactBytes: []byte(prepared.Body)}, nil
}

func readV2CancelBinding(row pgx.Row, control runnerstore.CancelControl) (runnerstore.V2CancelControl, error) {
	var v1Hash, exact []byte
	if err := row.Scan(&v1Hash, &exact); err != nil {
		return runnerstore.V2CancelControl{}, err
	}
	expected := sha256.Sum256(control.ExactBytes)
	if subtle.ConstantTimeCompare(v1Hash, expected[:]) != 1 {
		return runnerstore.V2CancelControl{}, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "v2 cancel identity is bound to different v1 bytes", nil)
	}
	message, err := authoritycontract.DecodeMessageJSON(exact)
	if err != nil || message.Kind != authoritycontract.KindCancelRequest || message.EventID != control.Message.EventID || !bytes.Equal(exact, []byte(mustPreparedBody(message))) {
		return runnerstore.V2CancelControl{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "stored v2 cancel binding is invalid", err)
	}
	return runnerstore.V2CancelControl{CancelID: control.CancelID, Message: message, ExactBytes: exact}, nil
}

func mustPreparedBody(message authoritycontract.Message) string {
	prepared, err := prepareV2Message(message)
	if err != nil {
		return ""
	}
	return prepared.Body
}
