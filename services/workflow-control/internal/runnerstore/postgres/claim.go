package postgres

import (
	"context"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

type claimRecord struct {
	workspaceID, jobID, workflowRunID, correlationID string
	descriptorRef, workflowID, workflowVersion       string
	descriptorHash, jobSpecHash                      []byte
	sourceHash, manifestHash, inputHash              []byte
	wholeDeadline                                    time.Time
	revision, currentFence                           int64
}

func (repository *Repository) ClaimNext(ctx context.Context, input runnerstore.ClaimInput) (runnerstore.AttemptLease, error) {
	if err := validateID(input.WorkspaceID, "workspaceId"); err != nil {
		return runnerstore.AttemptLease{}, err
	}
	if err := validateID(input.SupervisorInstanceID, "supervisorInstanceId"); err != nil {
		return runnerstore.AttemptLease{}, err
	}
	if input.LeaseOfferTimeout < runnerstore.MinLeaseDuration || input.LeaseOfferTimeout > runnerstore.MaxLeaseDuration ||
		input.LeaseDuration < input.LeaseOfferTimeout || input.LeaseDuration > runnerstore.MaxLeaseDuration {
		return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "lease durations are outside the closed range", nil)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.AttemptLease{}, databaseFailure("begin runner claim", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.AttemptLease{}, err
	}
	var job claimRecord
	err = tx.QueryRow(ctx, claimJobSQL, input.WorkspaceID, now).Scan(
		&job.workspaceID, &job.jobID, &job.workflowRunID, &job.correlationID,
		&job.descriptorRef, &job.descriptorHash, &job.jobSpecHash,
		&job.workflowID, &job.workflowVersion, &job.sourceHash, &job.manifestHash, &job.inputHash,
		&job.wholeDeadline, &job.revision, &job.currentFence,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorNoWork, "no queued runner job is available", err)
	}
	if err != nil {
		return runnerstore.AttemptLease{}, databaseFailure("claim queued runner job", err)
	}
	if job.currentFence >= runnerprotocol.MaxSafeInteger {
		return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "runner job exhausted its fencing token range", nil)
	}
	var ordinal int64
	if err := tx.QueryRow(ctx, attemptOrdinalSQL, job.workspaceID, job.jobID).Scan(&ordinal); err != nil {
		return runnerstore.AttemptLease{}, databaseFailure("allocate attempt ordinal", err)
	}
	attemptID, err := randomToken("attempt")
	if err != nil {
		return runnerstore.AttemptLease{}, databaseFailure("generate attempt id", err)
	}
	leaseID, err := randomToken("lease")
	if err != nil {
		return runnerstore.AttemptLease{}, databaseFailure("generate lease id", err)
	}
	eventID, err := randomToken("control")
	if err != nil {
		return runnerstore.AttemptLease{}, databaseFailure("generate lease offer event id", err)
	}
	fence := job.currentFence + 1
	offerExpires := now.Add(input.LeaseOfferTimeout)
	leaseExpires := now.Add(input.LeaseDuration)
	if leaseExpires.After(job.wholeDeadline) {
		leaseExpires = job.wholeDeadline
	}
	if offerExpires.After(leaseExpires) {
		offerExpires = leaseExpires
	}
	if !offerExpires.After(now) {
		return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorTimeout, "workflow deadline elapsed before claim", nil)
	}
	sequence := int64(1)
	jobID, runID, attempt, lease := job.jobID, job.workflowRunID, attemptID, leaseID
	leaseOffer := runnerprotocol.Envelope{
		ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: runnerprotocol.KindLeaseOffer,
		WorkspaceID: job.workspaceID, JobID: &jobID, WorkflowRunID: &runID,
		AttemptID: &attempt, LeaseID: &lease, FencingToken: &fence, Sequence: &sequence,
		EventID: eventID, CorrelationID: job.correlationID, SentAt: runnerstore.CanonicalTimestamp(now),
		Payload: map[string]any{
			"executionDescriptorRef":  job.descriptorRef,
			"executionDescriptorHash": hex.EncodeToString(job.descriptorHash),
			"jobSpecHash":             hex.EncodeToString(job.jobSpecHash),
			"workflowId":              job.workflowID, "workflowVersion": job.workflowVersion,
			"workflowSourceHash": hex.EncodeToString(job.sourceHash),
			"manifestHash":       hex.EncodeToString(job.manifestHash),
			"inputHash":          hex.EncodeToString(job.inputHash),
			"offeredAt":          runnerstore.CanonicalTimestamp(now),
			"expiresAt":          runnerstore.CanonicalTimestamp(leaseExpires),
		},
	}
	prepared, err := runnerprotocol.PrepareEnvelope(leaseOffer)
	if err != nil {
		return runnerstore.AttemptLease{}, err
	}
	digest, _ := hex.DecodeString(prepared.MessageDigest)
	if _, err := tx.Exec(ctx, attemptInsertSQL,
		attemptID, job.workspaceID, job.jobID, ordinal, input.SupervisorInstanceID,
		fence, now,
	); err != nil {
		return runnerstore.AttemptLease{}, mapWriteFailure("insert runner attempt", err)
	}
	if _, err := tx.Exec(ctx, leaseInsertSQL,
		leaseID, attemptID, job.workspaceID, job.jobID, fence,
		offerExpires, leaseExpires, now,
	); err != nil {
		return runnerstore.AttemptLease{}, mapWriteFailure("insert runner lease", err)
	}
	if _, err := tx.Exec(ctx, controlInsertSQL,
		eventID, attemptID, "lease_offer", sequence, prepared.Body, digest, now,
	); err != nil {
		return runnerstore.AttemptLease{}, mapWriteFailure("insert durable lease offer", err)
	}
	tag, err := tx.Exec(ctx, claimJobUpdateSQL, fence, attemptID, now, job.workspaceID, job.jobID, job.revision)
	if err != nil {
		return runnerstore.AttemptLease{}, mapWriteFailure("advance claimed runner job", err)
	}
	if tag.RowsAffected() != 1 {
		return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorConflict, "runner job claim CAS lost", nil)
	}
	if err := repository.commit(ctx, tx); err != nil {
		return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "runner claim commit outcome is unknown", err)
	}
	return runnerstore.AttemptLease{
		WorkspaceID: job.workspaceID, JobID: job.jobID, WorkflowRunID: job.workflowRunID,
		CorrelationID: job.correlationID, AttemptID: attemptID, AttemptOrdinal: ordinal,
		LeaseID: leaseID, FencingToken: fence, ControlSequence: sequence,
		ExecutionDescriptorRef:  job.descriptorRef,
		ExecutionDescriptorHash: hex.EncodeToString(job.descriptorHash),
		JobSpecHash:             hex.EncodeToString(job.jobSpecHash), WorkflowID: job.workflowID,
		WorkflowVersion: job.workflowVersion, WorkflowSourceHash: hex.EncodeToString(job.sourceHash),
		ManifestHash: hex.EncodeToString(job.manifestHash), InputHash: hex.EncodeToString(job.inputHash),
		OfferedAt: now, OfferExpiresAt: offerExpires, LeaseExpiresAt: leaseExpires,
		WholeDeadline: job.wholeDeadline, LeaseOffer: leaseOffer,
		LeaseOfferBytes: append([]byte(nil), prepared.Body...),
	}, nil
}
