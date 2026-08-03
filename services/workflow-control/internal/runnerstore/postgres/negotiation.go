package postgres

import (
	"bytes"
	"context"
	"encoding/hex"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func (repository *Repository) RecordNegotiation(ctx context.Context, input runnerstore.NegotiationInput) (runnerstore.Negotiation, error) {
	if err := runnerprotocol.ValidateEnvelope(input.Hello); err != nil {
		return runnerstore.Negotiation{}, err
	}
	if input.Hello.Kind != runnerprotocol.KindHello {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "negotiation requires hello", nil)
	}
	expectedCapabilities := []string{"cancel_ack", "effect_receipts", "lease_heartbeat"}
	advertisedCapabilities, ok := input.Hello.Payload["capabilities"].([]any)
	if !ok || len(advertisedCapabilities) != len(expectedCapabilities) {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "runner hello must advertise the exact GS8-B capabilities", nil)
	}
	for index, capability := range expectedCapabilities {
		if advertisedCapabilities[index] != capability {
			return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "runner hello must advertise the exact GS8-B capabilities", nil)
		}
	}
	if input.Hello.Payload["maxConcurrentJobs"] != int64(1) {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "runner hello maxConcurrentJobs must equal one", nil)
	}
	preparedHello, err := runnerprotocol.PrepareEnvelope(input.Hello)
	if err != nil {
		return runnerstore.Negotiation{}, err
	}
	if !bytes.Equal(preparedHello.Body, input.ExactBytes) {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorHashMismatch, "hello bytes are not canonical", nil)
	}
	if input.Hello.WorkspaceID != input.Lease.WorkspaceID {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "hello does not bind the claimed workspace", nil)
	}
	if input.HeartbeatInterval < time.Duration(runnerprotocol.MinHeartbeatIntervalMS)*time.Millisecond || input.HeartbeatInterval > time.Duration(runnerprotocol.MaxHeartbeatIntervalMS)*time.Millisecond {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "heartbeat interval is invalid", nil)
	}
	if input.LeaseOfferTimeout < time.Millisecond || input.LeaseOfferTimeout > time.Duration(runnerprotocol.MaxLeaseDurationMS)*time.Millisecond {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "lease offer timeout is invalid", nil)
	}
	if _, err := hex.DecodeString(input.ControlBuildHash); err != nil || len(input.ControlBuildHash) != 64 {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorHashMismatch, "control build hash is invalid", err)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.Negotiation{}, databaseFailure("begin runner negotiation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, preparedHello.IdempotencyKey, input.Lease.WorkspaceID, input.Lease.JobID); err != nil {
		return runnerstore.Negotiation{}, err
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, input.Lease.WorkspaceID, input.Lease.JobID))
	if err != nil {
		return runnerstore.Negotiation{}, err
	}
	if current.currentFence != input.Lease.FencingToken || current.currentAttemptID != input.Lease.AttemptID || current.attemptState != runnerstore.AttemptOffered {
		return runnerstore.Negotiation{}, repository.staleFence("negotiation lease is no longer current", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.Negotiation{}, err
	}
	if now.After(input.Lease.OfferExpiresAt) {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorLeaseExpired, "lease offer expired during negotiation", nil)
	}
	processSessionID, err := randomToken("runner-session")
	if err != nil {
		return runnerstore.Negotiation{}, databaseFailure("generate process session id", err)
	}
	eventID, err := randomToken("control")
	if err != nil {
		return runnerstore.Negotiation{}, databaseFailure("generate hello acknowledgement id", err)
	}
	helloAck := runnerprotocol.Envelope{
		ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: runnerprotocol.KindHelloAck,
		WorkspaceID: input.Lease.WorkspaceID, JobID: nil, WorkflowRunID: nil,
		AttemptID: nil, LeaseID: nil, FencingToken: nil, Sequence: nil,
		EventID: eventID, CorrelationID: input.Hello.CorrelationID,
		SentAt: runnerstore.CanonicalTimestamp(now),
		Payload: map[string]any{
			"controlBuildHash":        input.ControlBuildHash,
			"selectedProtocolVersion": runnerprotocol.ProtocolVersion,
			"heartbeatIntervalMs":     input.HeartbeatInterval.Milliseconds(),
			"leaseOfferTimeoutMs":     input.LeaseOfferTimeout.Milliseconds(),
		},
	}
	preparedAck, err := runnerprotocol.PrepareEnvelope(helloAck)
	if err != nil {
		return runnerstore.Negotiation{}, err
	}
	runnerBuild, _ := hex.DecodeString(input.Hello.Payload["runnerBuildHash"].(string))
	controlBuild, _ := hex.DecodeString(input.ControlBuildHash)
	if _, err := tx.Exec(ctx, `
INSERT INTO workflow_runner_process_sessions (
    process_session_id, attempt_id, runner_build_hash, control_build_hash,
    runtime_name, runtime_version, protocol_version, capabilities, negotiated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		processSessionID, input.Lease.AttemptID, runnerBuild, controlBuild,
		input.Hello.Payload["runtimeName"], input.Hello.Payload["runtimeVersion"],
		runnerprotocol.ProtocolVersion, expectedCapabilities, now); err != nil {
		return runnerstore.Negotiation{}, mapWriteFailure("insert runner process session", err)
	}
	digest, _ := hex.DecodeString(preparedAck.MessageDigest)
	if _, err := tx.Exec(ctx, controlInsertSQL, eventID, input.Lease.AttemptID, "hello_ack", nil, preparedAck.Body, digest, now); err != nil {
		return runnerstore.Negotiation{}, mapWriteFailure("insert durable hello acknowledgement", err)
	}
	if err := repository.commit(ctx, tx); err != nil {
		return runnerstore.Negotiation{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "runner negotiation commit outcome is unknown", err)
	}
	return runnerstore.Negotiation{ProcessSessionID: processSessionID, HelloAck: helloAck, HelloAckBytes: preparedAck.Body}, nil
}
