package postgres

import (
	"bytes"
	"context"
	"encoding/hex"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

func (repository *Repository) RecordV2Negotiation(ctx context.Context, input runnerstore.V2NegotiationInput) (runnerstore.V2Negotiation, error) {
	if input.Lease.RequiredProtocolVersion != authoritycontract.ProtocolVersion || input.Lease.AuthorityRoute == nil {
		return runnerstore.V2Negotiation{}, runnerstore.Failure(runnerstore.ErrorUnsupportedProtocol, "v2 negotiation requires a v2-bound lease", nil)
	}
	if input.Hello.Kind != authoritycontract.KindHello {
		return runnerstore.V2Negotiation{}, runnerstore.Failure(runnerstore.ErrorInputInvalid, "v2 negotiation requires hello", nil)
	}
	preparedHello, err := prepareV2Message(input.Hello)
	if err != nil {
		return runnerstore.V2Negotiation{}, err
	}
	if !bytes.Equal([]byte(preparedHello.Body), input.ExactBytes) || input.Hello.WorkspaceID != input.Lease.WorkspaceID {
		return runnerstore.V2Negotiation{}, runnerstore.Failure(runnerstore.ErrorIdentityMismatch, "v2 hello does not bind the exact lease", nil)
	}
	capabilities, ok := input.Hello.Payload["capabilities"].([]any)
	if !ok || len(capabilities) != len(input.Lease.RequiredCapabilities) {
		return runnerstore.V2Negotiation{}, runnerstore.Failure(runnerstore.ErrorCapabilityMismatch, "v2 hello is missing required capabilities", nil)
	}
	for index, capability := range input.Lease.RequiredCapabilities {
		if capabilities[index] != capability {
			return runnerstore.V2Negotiation{}, runnerstore.Failure(runnerstore.ErrorCapabilityMismatch, "v2 hello capability order or value differs", nil)
		}
	}
	runnerBuild, ok := input.Hello.Payload["runnerBuildHash"].(string)
	if !ok || runnerBuild != input.ExpectedRunnerBuildHash || len(input.ControlBuildHash) != 64 {
		return runnerstore.V2Negotiation{}, runnerstore.Failure(runnerstore.ErrorHashMismatch, "v2 runner or control build hash differs", nil)
	}
	if input.HeartbeatInterval < 250*time.Millisecond || input.LeaseOfferTimeout <= 0 {
		return runnerstore.V2Negotiation{}, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "v2 negotiation timing is invalid", nil)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return runnerstore.V2Negotiation{}, databaseFailure("begin v2 negotiation", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockScopes(ctx, tx, preparedHello.IdempotencyKey, input.Lease.WorkspaceID, input.Lease.JobID); err != nil {
		return runnerstore.V2Negotiation{}, err
	}
	current, err := readActiveAttempt(tx.QueryRow(ctx, activeAttemptForUpdateSQL, input.Lease.WorkspaceID, input.Lease.JobID))
	if err != nil {
		return runnerstore.V2Negotiation{}, err
	}
	if current.currentFence != input.Lease.FencingToken || current.currentAttemptID != input.Lease.AttemptID || current.attemptState != runnerstore.AttemptOffered {
		return runnerstore.V2Negotiation{}, repository.staleFence("v2 negotiation lease is no longer current", nil)
	}
	now, err := databaseTime(ctx, tx)
	if err != nil {
		return runnerstore.V2Negotiation{}, err
	}
	if now.After(input.Lease.OfferExpiresAt) {
		return runnerstore.V2Negotiation{}, runnerstore.Failure(runnerstore.ErrorLeaseExpired, "v2 negotiation lease offer expired", nil)
	}
	processSessionID, err := randomToken("runner-v2-session")
	if err != nil {
		return runnerstore.V2Negotiation{}, err
	}
	eventID, err := randomToken("control-v2")
	if err != nil {
		return runnerstore.V2Negotiation{}, err
	}
	ack := authoritycontract.Message{
		Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion,
		Kind: authoritycontract.KindHelloAck, WorkspaceID: input.Lease.WorkspaceID,
		EventID: eventID, CorrelationID: input.Hello.CorrelationID, SentAt: runnerstore.CanonicalTimestamp(now),
		Payload: map[string]any{
			"controlBuildHash": input.ControlBuildHash, "selectedProtocolVersion": authoritycontract.ProtocolVersion,
			"heartbeatIntervalMs": input.HeartbeatInterval.Milliseconds(), "leaseOfferTimeoutMs": input.LeaseOfferTimeout.Milliseconds(),
		},
	}
	preparedAck, err := prepareV2Message(ack)
	if err != nil {
		return runnerstore.V2Negotiation{}, err
	}
	runnerBuildBytes, _ := hex.DecodeString(runnerBuild)
	controlBuildBytes, _ := hex.DecodeString(input.ControlBuildHash)
	if _, err := tx.Exec(ctx, `INSERT INTO workflow_runner_process_sessions (
process_session_id,attempt_id,runner_build_hash,control_build_hash,runtime_name,runtime_version,protocol_version,capabilities,negotiated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, processSessionID, input.Lease.AttemptID,
		runnerBuildBytes, controlBuildBytes, input.Hello.Payload["runtimeName"], input.Hello.Payload["runtimeVersion"],
		authoritycontract.ProtocolVersion, input.Lease.RequiredCapabilities, now); err != nil {
		return runnerstore.V2Negotiation{}, mapWriteFailure("insert v2 runner process session", err)
	}
	digest, _ := hex.DecodeString(preparedAck.MessageDigest)
	if _, err := tx.Exec(ctx, controlInsertSQL, eventID, input.Lease.AttemptID, "hello_ack", nil, []byte(preparedAck.Body), digest, now); err != nil {
		return runnerstore.V2Negotiation{}, mapWriteFailure("insert v2 hello acknowledgement", err)
	}
	if err := repository.commit(ctx, tx); err != nil {
		return runnerstore.V2Negotiation{}, runnerstore.Failure(runnerstore.ErrorCommitUnknown, "v2 negotiation commit outcome is unknown", err)
	}
	return runnerstore.V2Negotiation{ProcessSessionID: processSessionID, HelloAck: ack, HelloAckBytes: []byte(preparedAck.Body)}, nil
}
