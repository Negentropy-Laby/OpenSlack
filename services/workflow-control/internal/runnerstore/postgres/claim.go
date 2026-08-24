package postgres

import (
	"context"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerprotocols"
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
	requiredProtocol                                 string
	requiredCapabilities                             []string
	authorityBackend, authority                      *string
	routingEpoch, runRevision, resumeGeneration      *int64
	authorityBuildHash                               []byte
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
	protocols := input.ProtocolVersions
	if len(protocols) == 0 {
		protocols = []string{runnerprotocol.ProtocolVersion}
	}
	for _, protocol := range protocols {
		if !runnerprotocols.IsSupported(protocol) {
			return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorUnsupportedProtocol, "scheduler requested an unsupported protocol", nil)
		}
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
	err = tx.QueryRow(ctx, claimJobSQL, input.WorkspaceID, now, protocols, repository.v2RuntimeDelivery).Scan(
		&job.workspaceID, &job.jobID, &job.workflowRunID, &job.correlationID,
		&job.descriptorRef, &job.descriptorHash, &job.jobSpecHash,
		&job.workflowID, &job.workflowVersion, &job.sourceHash, &job.manifestHash, &job.inputHash,
		&job.wholeDeadline, &job.revision, &job.currentFence, &job.requiredProtocol, &job.requiredCapabilities,
		&job.authorityBackend, &job.authority, &job.routingEpoch, &job.authorityBuildHash,
		&job.runRevision, &job.resumeGeneration,
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
	var v2LeaseOffer *authoritycontract.Message
	var preparedBody []byte
	var preparedDigest string
	if job.requiredProtocol == authoritycontract.ProtocolVersion {
		if job.authorityBackend == nil || job.authority == nil || job.routingEpoch == nil || job.runRevision == nil || job.resumeGeneration == nil || len(job.authorityBuildHash) != 32 {
			return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorAuthorityBinding, "v2 job durable authority binding is incomplete", nil)
		}
		message := authoritycontract.Message{
			Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion,
			Kind: authoritycontract.KindLeaseOffer, WorkspaceID: job.workspaceID, JobID: &jobID,
			WorkflowRunID: &runID, AttemptID: &attempt, LeaseID: &lease, FencingToken: &fence, Sequence: &sequence,
			AuthorityBackend: job.authorityBackend, Authority: job.authority, RoutingEpoch: job.routingEpoch,
			AuthorityBuildHash: stringPointer(hex.EncodeToString(job.authorityBuildHash)), RunRevision: job.runRevision,
			ResumeGeneration: job.resumeGeneration, EventID: eventID, CorrelationID: job.correlationID,
			SentAt: runnerstore.CanonicalTimestamp(now), Payload: cloneScalarPayload(leaseOffer.Payload),
		}
		preparedV2, prepareErr := prepareV2Message(message)
		if prepareErr != nil {
			return runnerstore.AttemptLease{}, prepareErr
		}
		v2LeaseOffer, preparedBody, preparedDigest = &message, []byte(preparedV2.Body), preparedV2.MessageDigest
	} else {
		preparedV1, prepareErr := runnerprotocol.PrepareEnvelope(leaseOffer)
		if prepareErr != nil {
			return runnerstore.AttemptLease{}, prepareErr
		}
		preparedBody, preparedDigest = preparedV1.Body, preparedV1.MessageDigest
	}
	digest, _ := hex.DecodeString(preparedDigest)
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
		eventID, attemptID, "lease_offer", sequence, preparedBody, digest, now,
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
	if job.requiredProtocol == authoritycontract.ProtocolVersion {
		insert := `INSERT INTO workflow_runner_v2_attempt_bindings (
attempt_id,workspace_id,job_id,authority_backend,workflow_authority,routing_epoch,authority_build_hash,
initial_run_revision,initial_resume_generation,current_run_revision,current_resume_generation,required_capabilities,created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10,$11)`
		args := []any{attemptID, job.workspaceID, job.jobID, *job.authorityBackend, *job.authority, *job.routingEpoch,
			job.authorityBuildHash, *job.runRevision, *job.resumeGeneration, job.requiredCapabilities, now}
		if _, err := tx.Exec(ctx, insert, args...); err != nil {
			return runnerstore.AttemptLease{}, mapWriteFailure("insert v2 attempt binding", err)
		}
	}
	if err := repository.commit(ctx, tx); err != nil {
		return runnerstore.AttemptLease{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "runner claim commit outcome is unknown", err)
	}
	var authorityRoute *authoritycontract.Route
	if job.requiredProtocol == authoritycontract.ProtocolVersion {
		authorityRoute = &authoritycontract.Route{Backend: *job.authorityBackend, Authority: *job.authority, RoutingEpoch: *job.routingEpoch, AuthorityBuildHash: hex.EncodeToString(job.authorityBuildHash)}
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
		LeaseOfferBytes: append([]byte(nil), preparedBody...), RequiredProtocolVersion: job.requiredProtocol,
		RequiredCapabilities: append([]string(nil), job.requiredCapabilities...), AuthorityRoute: authorityRoute,
		RunRevision: pointerInt64(job.runRevision), ResumeGeneration: pointerInt64(job.resumeGeneration),
		V2LeaseOffer: v2LeaseOffer, V2LeaseOfferBytes: append([]byte(nil), preparedBody...),
	}, nil
}

func stringPointer(value string) *string { return &value }

func cloneScalarPayload(value map[string]any) map[string]any {
	result := make(map[string]any, len(value))
	for key, item := range value {
		result[key] = item
	}
	return result
}

func pointerInt64(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
