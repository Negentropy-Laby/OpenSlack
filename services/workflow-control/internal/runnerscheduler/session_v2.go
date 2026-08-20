package runnerscheduler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerprotocols"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

type V2SessionConfig struct {
	Store                   runnerstore.V2SessionStore
	Launcher                ProcessLauncher
	ControlBuildHash        string
	ExpectedRunnerBuildHash string
	HeartbeatInterval       time.Duration
	LeaseOfferTimeout       time.Duration
	CancelGrace             time.Duration
	TerminalExitGrace       time.Duration
	Now                     func() time.Time
}

type V2Session struct {
	config V2SessionConfig
	base   *Session
}

func NewV2Session(config V2SessionConfig) (*V2Session, error) {
	if config.Store == nil || config.Launcher == nil || len(config.ControlBuildHash) != 64 || len(config.ExpectedRunnerBuildHash) != 64 {
		return nil, fmt.Errorf("runner v2 session identity and sealed launcher are required")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	base, err := NewSession(SessionConfig{Store: config.Store, Launcher: config.Launcher,
		ControlBuildHash: config.ControlBuildHash, HeartbeatInterval: config.HeartbeatInterval,
		LeaseOfferTimeout: config.LeaseOfferTimeout, CancelWindow: 30 * time.Second,
		CancelGrace: config.CancelGrace, TerminalExitGrace: config.TerminalExitGrace, PollInterval: 250 * time.Millisecond, Now: config.Now})
	if err != nil {
		return nil, err
	}
	return &V2Session{config: config, base: base}, nil
}

func (session *V2Session) Run(ctx context.Context, lease runnerstore.AttemptLease) error {
	if lease.RequiredProtocolVersion != runnerprotocols.V2 || lease.V2LeaseOffer == nil || lease.AuthorityRoute == nil {
		return runnerstore.Failure(runnerstore.ErrorUnsupportedProtocol, "v2 session received a non-v2 lease", nil)
	}
	process, err := session.config.Launcher.Start(ctx)
	if err != nil {
		return fmt.Errorf("start sealed v2 worker: %w", err)
	}
	decodeCtx, cancelDecode := context.WithCancel(ctx)
	defer cancelDecode()
	frames := make(chan protocolDecodedFrame[authoritycontract.Message], 1)
	go decodeProtocolFrames(decodeCtx, newV2FrameReader(process.Stdout()), frames)
	first, err := awaitV2Frame(ctx, frames, lease.OfferExpiresAt.Sub(session.config.Now()))
	if err != nil {
		return session.base.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("runner v2 hello: %w", err))
	}
	if first.message.Kind != authoritycontract.KindHello {
		return session.base.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("runner v2 first frame is not hello"))
	}
	negotiation, err := session.config.Store.RecordV2Negotiation(ctx, runnerstore.V2NegotiationInput{
		Lease: lease, Hello: first.message, ExactBytes: first.exact, ControlBuildHash: session.config.ControlBuildHash,
		ExpectedRunnerBuildHash: session.config.ExpectedRunnerBuildHash, HeartbeatInterval: session.config.HeartbeatInterval,
		LeaseOfferTimeout: session.config.LeaseOfferTimeout, Now: session.config.Now(),
	})
	if err != nil {
		return session.base.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("persist runner v2 negotiation: %w", err))
	}
	if err := session.send(ctx, process, lease.AttemptID, negotiation.HelloAck, negotiation.HelloAckBytes); err != nil {
		return session.base.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("send v2 hello acknowledgement: %w", err))
	}
	if err := session.send(ctx, process, lease.AttemptID, *lease.V2LeaseOffer, lease.V2LeaseOfferBytes); err != nil {
		return session.base.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("send v2 lease offer: %w", err))
	}
	poll := time.NewTicker(session.base.config.PollInterval)
	defer poll.Stop()
	deadline := time.NewTimer(positiveDuration(lease.WholeDeadline.Sub(session.config.Now())))
	defer deadline.Stop()
	leaseTimer := time.NewTimer(positiveDuration(lease.LeaseExpiresAt.Sub(session.config.Now())))
	defer leaseTimer.Stop()
	var cancelSent bool
	var cancelTimer *time.Timer
	var cancelTimerChannel <-chan time.Time
	var terminalTimer *time.Timer
	var terminalTimerChannel <-chan time.Time
	terminalReceived := false
	for {
		select {
		case frame, open := <-frames:
			if !open {
				if terminalReceived {
					frames = nil
					continue
				}
				return session.base.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("runner v2 stdout closed before terminal receipt"))
			}
			if frame.err != nil {
				if terminalReceived && errors.Is(frame.err, io.EOF) {
					frames = nil
					continue
				}
				return session.base.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("decode runner v2 frame: %w", frame.err))
			}
			if frame.message.Kind == authoritycontract.KindHello {
				return session.base.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("runner repeated v2 hello after negotiation"))
			}
			recorded, recordErr := session.config.Store.RecordV2Event(ctx, runnerstore.V2RecordEventInput{Message: frame.message, ExactBytes: frame.exact, ControlBuildHash: session.config.ControlBuildHash, Now: session.config.Now()})
			if recordErr != nil {
				return session.base.failProcess(ctx, process, lease, runnerstore.ProcessForced, fmt.Errorf("persist runner v2 event: %w", recordErr))
			}
			// A cancellation admitted before this event committed owns an earlier
			// control sequence and must leave first. A cancellation admitted after
			// commit necessarily follows the atomic receipt/decision pair.
			if !cancelSent && recorded.Receipt.Sequence != nil {
				sent, sendErr := session.sendPendingV2Cancel(ctx, process, lease, *recorded.Receipt.Sequence)
				if sendErr != nil {
					return session.base.failProcess(ctx, process, lease, runnerstore.ProcessForced, sendErr)
				}
				if sent {
					cancelSent = true
					cancelTimer = time.NewTimer(session.config.CancelGrace)
					cancelTimerChannel = cancelTimer.C
				}
			}
			// Receipt is always delivered and durably marked before a decision;
			// cancellation polling cannot interleave in this synchronous lane.
			if err := session.send(ctx, process, lease.AttemptID, recorded.Receipt, recorded.ReceiptBytes); err != nil {
				return session.base.failProcess(ctx, process, lease, runnerstore.ProcessForced, fmt.Errorf("send runner v2 event receipt: %w", err))
			}
			if recorded.Decision != nil {
				if err := session.send(ctx, process, lease.AttemptID, *recorded.Decision, recorded.DecisionBytes); err != nil {
					return session.base.failProcess(ctx, process, lease, runnerstore.ProcessForced, fmt.Errorf("send runner v2 authority decision: %w", err))
				}
			}
			if frame.message.Kind == authoritycontract.KindLeaseReject {
				return session.base.finishRejectedProcess(process, lease, recorded.JobState)
			}
			if recorded.Status == runnerstore.ReceiptReconciliationRequired || recorded.JobState == runnerstore.JobReconciliationRequired {
				return session.base.failProcess(ctx, process, lease, runnerstore.ProcessForced, runnerstore.Failure(runnerstore.ErrorReconciliation, "runner v2 event requires reconciliation", nil))
			}
			if frame.message.Kind == authoritycontract.KindTerminal {
				terminalReceived = true
				terminalTimer = time.NewTimer(session.config.TerminalExitGrace)
				terminalTimerChannel = terminalTimer.C
			}
		case <-poll.C:
			if !cancelSent && !terminalReceived {
				sent, sendErr := session.sendPendingV2Cancel(ctx, process, lease, 0)
				if sendErr != nil {
					return session.base.failProcess(ctx, process, lease, runnerstore.ProcessForced, fmt.Errorf("poll runner v2 cancellation: %w", sendErr))
				}
				if sent {
					cancelSent = true
					cancelTimer = time.NewTimer(session.config.CancelGrace)
					cancelTimerChannel = cancelTimer.C
				}
			}
		case <-process.Done():
			if cancelTimer != nil {
				cancelTimer.Stop()
			}
			if terminalTimer != nil {
				terminalTimer.Stop()
			}
			result, waitErr := process.Wait(context.Background())
			if waitErr != nil {
				return session.base.recordUncertainTermination(lease, errors.Join(fmt.Errorf("wait for runner v2 process exit: %w", waitErr), result.Err))
			}
			if terminalReceived && result.ExitCode == 0 {
				return nil
			}
			view, recordErr := session.config.Store.RecordProcessExit(context.Background(), runnerstore.ProcessExitInput{
				WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID,
				FencingToken: lease.FencingToken, Class: runnerstore.ProcessCrashed, ObservedAt: session.config.Now(),
			})
			if recordErr != nil {
				return errors.Join(result.Err, recordErr)
			}
			cause := result.Err
			if cause == nil {
				cause = runnerstore.Failure(runnerstore.ErrorProcessCrash, "runner v2 exited without receipt-proven terminal", nil)
			}
			return settledSessionError(view, cause)
		case <-deadline.C:
			if !cancelSent && !terminalReceived {
				if err := session.createAndSendV2Cancel(ctx, process, lease, "timeout"); err != nil {
					return session.base.failProcess(ctx, process, lease, runnerstore.ProcessForced, err)
				}
				cancelSent = true
				cancelTimer = time.NewTimer(session.config.CancelGrace)
				cancelTimerChannel = cancelTimer.C
			}
		case <-leaseTimer.C:
			if !cancelSent && !terminalReceived {
				if err := session.createAndSendV2Cancel(ctx, process, lease, "lease_expired"); err != nil {
					return session.base.failProcess(ctx, process, lease, runnerstore.ProcessForced, err)
				}
				cancelSent = true
				cancelTimer = time.NewTimer(session.config.CancelGrace)
				cancelTimerChannel = cancelTimer.C
			}
		case <-cancelTimerChannel:
			return session.base.forceProcess(process, lease, fmt.Errorf("runner v2 did not exit after cancellation grace"))
		case <-terminalTimerChannel:
			return session.base.forceProcess(process, lease, fmt.Errorf("runner v2 did not exit after terminal receipt"))
		case <-ctx.Done():
			var cancelErr error
			if !cancelSent && !terminalReceived {
				cancelErr = session.createAndSendV2Cancel(context.Background(), process, lease, "shutdown")
			}
			return session.base.failProcess(context.Background(), process, lease, runnerstore.ProcessForced, errors.Join(ctx.Err(), cancelErr))
		}
	}
}

func (session *V2Session) sendPendingV2Cancel(ctx context.Context, process WorkerProcess, lease runnerstore.AttemptLease, beforeSequence int64) (bool, error) {
	control, err := session.config.Store.PendingCancel(ctx, lease.WorkspaceID, lease.JobID, lease.AttemptID)
	if err != nil || control == nil {
		return false, err
	}
	if beforeSequence > 0 && control.ControlSequence >= beforeSequence {
		return false, nil
	}
	wrapped, err := session.config.Store.PrepareV2Cancel(ctx, lease, *control)
	if err != nil {
		return false, err
	}
	return true, session.send(ctx, process, lease.AttemptID, wrapped.Message, wrapped.ExactBytes)
}

func (session *V2Session) createAndSendV2Cancel(ctx context.Context, process WorkerProcess, lease runnerstore.AttemptLease, reason string) error {
	now := session.config.Now()
	input := runnerstore.CancelInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, CorrelationID: lease.CorrelationID,
		ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken,
		Reason: reason, Now: now, ExpiresAt: now.Add(session.base.config.CancelWindow)}
	key, fingerprint, err := runnerstore.CancelBindings(input)
	if err != nil {
		return err
	}
	input.IdempotencyKey, input.RequestFingerprint = key, fingerprint
	control, err := session.config.Store.RequestCancel(ctx, input)
	if err != nil {
		return err
	}
	wrapped, err := session.config.Store.PrepareV2Cancel(ctx, lease, control)
	if err != nil {
		return err
	}
	return session.send(ctx, process, lease.AttemptID, wrapped.Message, wrapped.ExactBytes)
}

func (session *V2Session) send(ctx context.Context, process WorkerProcess, attemptID string, message authoritycontract.Message, body []byte) error {
	if err := session.config.Store.MarkV2ControlDeliveryStarted(ctx, attemptID, message.EventID, string(message.Kind), session.config.Now()); err != nil {
		return err
	}
	if err := writeFrame(process.Stdin(), body); err != nil {
		markErr := session.config.Store.MarkV2ControlDeliveryReconciliation(context.Background(), attemptID, message.EventID, string(message.Kind), session.config.Now())
		return errors.Join(err, markErr)
	}
	if err := session.config.Store.MarkV2ControlDelivered(ctx, attemptID, message.EventID, string(message.Kind), session.config.Now()); err != nil {
		markErr := session.config.Store.MarkV2ControlDeliveryReconciliation(context.Background(), attemptID, message.EventID, string(message.Kind), session.config.Now())
		return errors.Join(err, markErr)
	}
	return nil
}

func awaitV2Frame(ctx context.Context, frames <-chan protocolDecodedFrame[authoritycontract.Message], timeout time.Duration) (protocolDecodedFrame[authoritycontract.Message], error) {
	timer := time.NewTimer(positiveDuration(timeout))
	defer timer.Stop()
	select {
	case value, ok := <-frames:
		if !ok {
			return protocolDecodedFrame[authoritycontract.Message]{}, io.EOF
		}
		return value, value.err
	case <-timer.C:
		return protocolDecodedFrame[authoritycontract.Message]{}, runnerstore.Failure(runnerstore.ErrorLeaseExpired, "runner v2 negotiation deadline expired", nil)
	case <-ctx.Done():
		return protocolDecodedFrame[authoritycontract.Message]{}, ctx.Err()
	}
}
