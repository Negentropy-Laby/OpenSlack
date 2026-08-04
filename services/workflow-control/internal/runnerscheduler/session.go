package runnerscheduler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/processsupervisor"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

type SessionStore interface {
	runnerstore.Store
	RecordAttemptFailure(context.Context, runnerstore.AttemptFailureInput) (runnerstore.JobView, error)
}

type SessionConfig struct {
	Store             SessionStore
	Launcher          ProcessLauncher
	ControlBuildHash  string
	HeartbeatInterval time.Duration
	LeaseOfferTimeout time.Duration
	CancelWindow      time.Duration
	CancelGrace       time.Duration
	TerminalExitGrace time.Duration
	PollInterval      time.Duration
	Now               func() time.Time
}

type Session struct {
	config  SessionConfig
	writeMu sync.Mutex
}

type WorkerProcess interface {
	Stdin() io.WriteCloser
	Stdout() io.ReadCloser
	Done() <-chan struct{}
	Wait(context.Context) (processsupervisor.Result, error)
	Terminate(context.Context, time.Duration) error
	ForceKill(context.Context) error
}

type ProcessLauncher interface {
	Start(context.Context) (WorkerProcess, error)
}

type SealedLauncher struct{ Supervisor *processsupervisor.Supervisor }

func (launcher SealedLauncher) Start(ctx context.Context) (WorkerProcess, error) {
	if launcher.Supervisor == nil {
		return nil, fmt.Errorf("sealed process supervisor is required")
	}
	return launcher.Supervisor.Start(ctx)
}

func NewSession(config SessionConfig) (*Session, error) {
	if config.Store == nil || config.Launcher == nil {
		return nil, fmt.Errorf("runner session store and process launcher are required")
	}
	if len(config.ControlBuildHash) != 64 {
		return nil, fmt.Errorf("runner session control build hash is invalid")
	}
	if config.HeartbeatInterval < time.Duration(runnerprotocol.MinHeartbeatIntervalMS)*time.Millisecond || config.HeartbeatInterval > time.Duration(runnerprotocol.MaxHeartbeatIntervalMS)*time.Millisecond {
		return nil, fmt.Errorf("runner session heartbeat interval is invalid")
	}
	if config.LeaseOfferTimeout <= 0 || config.LeaseOfferTimeout > runnerstore.MaxLeaseDuration {
		return nil, fmt.Errorf("runner session lease offer timeout is invalid")
	}
	if config.CancelWindow <= 0 || config.CancelWindow > runnerstore.MaxCancellationWindow {
		return nil, fmt.Errorf("runner session cancel window is invalid")
	}
	if config.CancelGrace <= 0 || config.CancelGrace > 5*time.Minute {
		return nil, fmt.Errorf("runner session cancel grace is invalid")
	}
	if config.TerminalExitGrace <= 0 || config.TerminalExitGrace > time.Minute {
		return nil, fmt.Errorf("runner session terminal exit grace is invalid")
	}
	if config.PollInterval <= 0 || config.PollInterval > time.Second {
		return nil, fmt.Errorf("runner session poll interval is invalid")
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &Session{config: config}, nil
}

type decodedFrame struct {
	message runnerprotocol.Envelope
	exact   []byte
	err     error
}

type sessionErrorDisposition uint8

const (
	sessionErrorFatal sessionErrorDisposition = iota
	sessionErrorRetryable
	sessionErrorSettled
)

type sessionRunError struct {
	disposition sessionErrorDisposition
	err         error
}

func (failure *sessionRunError) Error() string { return failure.err.Error() }
func (failure *sessionRunError) Unwrap() error { return failure.err }

func settledSessionError(view runnerstore.JobView, err error) error {
	disposition := sessionErrorSettled
	if view.State == runnerstore.JobQueued {
		disposition = sessionErrorRetryable
	}
	return &sessionRunError{disposition: disposition, err: err}
}

func (session *Session) Run(ctx context.Context, lease runnerstore.AttemptLease) error {
	clock := newAttemptClock(lease)
	process, err := session.config.Launcher.Start(ctx)
	if err != nil {
		view, recordErr := session.config.Store.RecordAttemptFailure(context.Background(), runnerstore.AttemptFailureInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken, Kind: runnerstore.AttemptLaunchFailed, ObservedAt: session.config.Now()})
		if recordErr != nil {
			return errors.Join(fmt.Errorf("start sealed TypeScript worker: %w", err), recordErr)
		}
		return settledSessionError(view, fmt.Errorf("start sealed TypeScript worker: %w", err))
	}
	frames := make(chan decodedFrame, 1)
	go decodeFrames(process.Stdout(), frames)
	first, err := awaitFrame(ctx, frames, clock.remainingOffer())
	if err != nil {
		return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("runner hello: %w", err))
	}
	if clock.remainingOffer() <= 0 {
		return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, runnerstore.Failure(runnerstore.ErrorLeaseExpired, "runner negotiation consumed the lease offer window", nil))
	}
	if first.message.Kind != runnerprotocol.KindHello {
		return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("runner first frame is not hello"))
	}
	negotiation, err := session.config.Store.RecordNegotiation(ctx, runnerstore.NegotiationInput{
		Lease: lease, Hello: first.message, ExactBytes: first.exact,
		ControlBuildHash:  session.config.ControlBuildHash,
		HeartbeatInterval: session.config.HeartbeatInterval,
		LeaseOfferTimeout: session.config.LeaseOfferTimeout, Now: session.config.Now(),
	})
	if err != nil {
		return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("persist runner negotiation: %w", err))
	}
	if clock.remainingOffer() <= 0 {
		return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, runnerstore.Failure(runnerstore.ErrorLeaseExpired, "runner negotiation consumed the lease offer window", nil))
	}
	if err := session.send(ctx, process, lease.AttemptID, negotiation.HelloAck, negotiation.HelloAckBytes); err != nil {
		return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("send hello acknowledgement: %w", err))
	}
	if err := session.send(ctx, process, lease.AttemptID, lease.LeaseOffer, lease.LeaseOfferBytes); err != nil {
		return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("send lease offer: %w", err))
	}

	poll := time.NewTicker(session.config.PollInterval)
	defer poll.Stop()
	deadline := time.NewTimer(positiveDuration(clock.remainingWhole()))
	defer deadline.Stop()
	leaseTimer := time.NewTimer(positiveDuration(clock.remainingLease()))
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
				return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("runner stdout closed before terminal receipt"))
			}
			if frame.err != nil {
				if terminalReceived && errors.Is(frame.err, io.EOF) {
					frames = nil
					continue
				}
				return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("decode runner frame: %w", frame.err))
			}
			if frame.message.Kind == runnerprotocol.KindHello {
				return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("runner repeated hello after negotiation"))
			}
			recorded, recordErr := session.config.Store.RecordEvent(ctx, runnerstore.RecordEventInput{Message: frame.message, ExactBytes: frame.exact, ControlBuildHash: session.config.ControlBuildHash, Now: session.config.Now()})
			if recordErr != nil {
				return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("persist runner event: %w", recordErr))
			}
			if err := session.send(ctx, process, lease.AttemptID, recorded.Receipt, recorded.ReceiptBytes); err != nil {
				return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("send runner event receipt: %w", err))
			}
			if frame.message.Kind == runnerprotocol.KindLeaseReject {
				return session.finishRejectedProcess(process, lease, recorded.JobState)
			}
			if recorded.Status == runnerstore.ReceiptReconciliationRequired || recorded.JobState == runnerstore.JobReconciliationRequired {
				return session.failProcess(ctx, process, lease, runnerstore.ProcessForced, runnerstore.Failure(runnerstore.ErrorReconciliation, "runner event requires reconciliation", nil))
			}
			if frame.message.Kind == runnerprotocol.KindTerminal {
				terminalReceived = true
				terminalTimer = time.NewTimer(session.config.TerminalExitGrace)
				terminalTimerChannel = terminalTimer.C
			}
		case <-poll.C:
			if !cancelSent {
				control, pendingErr := session.config.Store.PendingCancel(ctx, lease.WorkspaceID, lease.JobID, lease.AttemptID)
				if pendingErr != nil {
					return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, fmt.Errorf("poll runner cancellation: %w", pendingErr))
				}
				if control != nil {
					if err := session.send(ctx, process, lease.AttemptID, control.Message, control.ExactBytes); err != nil {
						return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, err)
					}
					cancelSent = true
					cancelTimer = time.NewTimer(session.config.CancelGrace)
					cancelTimerChannel = cancelTimer.C
				}
			}
		case <-deadline.C:
			if !cancelSent && !terminalReceived {
				if err := session.createAndSendCancel(ctx, process, lease, "timeout"); err != nil {
					return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, err)
				}
				cancelSent = true
				cancelTimer = time.NewTimer(session.config.CancelGrace)
				cancelTimerChannel = cancelTimer.C
			}
		case <-leaseTimer.C:
			if !cancelSent && !terminalReceived {
				if err := session.createAndSendCancel(ctx, process, lease, "lease_expired"); err != nil {
					return session.failProcess(ctx, process, lease, runnerstore.ProcessCrashed, err)
				}
				cancelSent = true
				cancelTimer = time.NewTimer(session.config.CancelGrace)
				cancelTimerChannel = cancelTimer.C
			}
		case <-cancelTimerChannel:
			return session.forceProcess(process, lease, fmt.Errorf("runner did not exit after cancellation grace"))
		case <-terminalTimerChannel:
			return session.forceProcess(process, lease, fmt.Errorf("runner did not exit after terminal receipt"))
		case <-process.Done():
			if cancelTimer != nil {
				cancelTimer.Stop()
			}
			if terminalTimer != nil {
				terminalTimer.Stop()
			}
			result, waitErr := process.Wait(context.Background())
			if waitErr != nil {
				return session.recordUncertainTermination(lease, errors.Join(fmt.Errorf("wait for runner process exit: %w", waitErr), result.Err))
			}
			if terminalReceived && result.ExitCode == 0 {
				return nil
			}
			class := runnerstore.ProcessCrashed
			view, recordErr := session.config.Store.RecordProcessExit(context.Background(), runnerstore.ProcessExitInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken, Class: class, ObservedAt: session.config.Now()})
			if recordErr != nil {
				return errors.Join(result.Err, recordErr)
			}
			cause := result.Err
			if cause == nil {
				cause = runnerstore.Failure(runnerstore.ErrorProcessCrash, "runner exited without receipt-proven terminal", nil)
			}
			return settledSessionError(view, cause)
		case <-ctx.Done():
			var cancelErr error
			if !cancelSent && !terminalReceived {
				cancelErr = session.createAndSendCancel(context.Background(), process, lease, "shutdown")
			}
			return session.failProcess(context.Background(), process, lease, runnerstore.ProcessForced, errors.Join(ctx.Err(), cancelErr))
		}
	}
}

func decodeFrames(source io.Reader, destination chan<- decodedFrame) {
	defer close(destination)
	reader := newFrameReader(source)
	for {
		message, exact, err := reader.Read()
		destination <- decodedFrame{message: message, exact: exact, err: err}
		if err != nil {
			return
		}
	}
}

func awaitFrame(ctx context.Context, frames <-chan decodedFrame, timeout time.Duration) (decodedFrame, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case value, ok := <-frames:
		if !ok {
			return decodedFrame{}, io.EOF
		}
		return value, value.err
	case <-timer.C:
		return decodedFrame{}, runnerstore.Failure(runnerstore.ErrorLeaseExpired, "runner negotiation deadline expired", nil)
	case <-ctx.Done():
		return decodedFrame{}, ctx.Err()
	}
}

func (session *Session) send(ctx context.Context, process WorkerProcess, attemptID string, message runnerprotocol.Envelope, body []byte) error {
	session.writeMu.Lock()
	defer session.writeMu.Unlock()
	if err := writeFrame(process.Stdin(), body); err != nil {
		return err
	}
	return session.config.Store.MarkControlDelivered(ctx, attemptID, message.EventID, string(message.Kind), session.config.Now())
}

func (session *Session) createAndSendCancel(ctx context.Context, process WorkerProcess, lease runnerstore.AttemptLease, reason string) error {
	now := session.config.Now().UTC().Truncate(time.Millisecond)
	input := runnerstore.CancelInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, CorrelationID: lease.CorrelationID, ExpectedAttemptID: lease.AttemptID, ExpectedLeaseID: lease.LeaseID, ExpectedFence: lease.FencingToken, Reason: reason, Now: now, ExpiresAt: now.Add(session.config.CancelWindow)}
	key, fingerprint, err := runnerstore.CancelBindings(input)
	if err != nil {
		return err
	}
	input.IdempotencyKey = key
	input.RequestFingerprint = fingerprint
	control, err := session.config.Store.RequestCancel(ctx, input)
	if err != nil {
		return err
	}
	return session.send(ctx, process, lease.AttemptID, control.Message, control.ExactBytes)
}

func (session *Session) failProcess(ctx context.Context, process WorkerProcess, lease runnerstore.AttemptLease, class runnerstore.ProcessExitClass, cause error) error {
	termination, cancel := context.WithTimeout(context.Background(), session.config.CancelGrace+session.config.TerminalExitGrace)
	defer cancel()
	terminateErr := process.Terminate(termination, session.config.CancelGrace)
	_, waitErr := process.Wait(termination)
	if terminateErr != nil || waitErr != nil {
		return session.recordUncertainTermination(lease, errors.Join(cause, terminateErr, waitErr))
	}
	view, recordErr := session.config.Store.RecordProcessExit(context.Background(), runnerstore.ProcessExitInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken, Class: class, ObservedAt: session.config.Now()})
	if recordErr != nil {
		return errors.Join(cause, recordErr)
	}
	return settledSessionError(view, cause)
}

func (session *Session) finishRejectedProcess(process WorkerProcess, lease runnerstore.AttemptLease, state runnerstore.JobState) error {
	termination, cancel := context.WithTimeout(context.Background(), session.config.CancelGrace+session.config.TerminalExitGrace)
	defer cancel()
	terminateErr := process.Terminate(termination, session.config.CancelGrace)
	_, waitErr := process.Wait(termination)
	if terminateErr != nil || waitErr != nil {
		return session.recordUncertainTermination(lease, errors.Join(fmt.Errorf("stop lease-reject worker"), terminateErr, waitErr))
	}
	disposition := sessionErrorRetryable
	if state == runnerstore.JobReconciliationRequired {
		disposition = sessionErrorSettled
	}
	return &sessionRunError{disposition: disposition, err: runnerstore.Failure(runnerstore.ErrorConflict, "runner rejected the leased execution descriptor", nil)}
}

func (session *Session) forceProcess(process WorkerProcess, lease runnerstore.AttemptLease, cause error) error {
	forceCtx, cancel := context.WithTimeout(context.Background(), session.config.CancelGrace)
	defer cancel()
	forceErr := process.ForceKill(forceCtx)
	result, waitErr := process.Wait(forceCtx)
	if forceErr != nil || waitErr != nil {
		return session.recordUncertainTermination(lease, errors.Join(cause, forceErr, waitErr, result.Err))
	}
	view, recordErr := session.config.Store.RecordProcessExit(context.Background(), runnerstore.ProcessExitInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken, Class: runnerstore.ProcessForced, ObservedAt: session.config.Now()})
	if recordErr != nil {
		return errors.Join(cause, result.Err, recordErr)
	}
	return settledSessionError(view, errors.Join(cause, result.Err))
}

func (session *Session) recordUncertainTermination(lease runnerstore.AttemptLease, cause error) error {
	view, recordErr := session.config.Store.RecordAttemptFailure(context.Background(), runnerstore.AttemptFailureInput{WorkspaceID: lease.WorkspaceID, JobID: lease.JobID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID, FencingToken: lease.FencingToken, Kind: runnerstore.AttemptTerminationUncertain, ObservedAt: session.config.Now()})
	if recordErr != nil {
		return errors.Join(cause, recordErr)
	}
	return settledSessionError(view, cause)
}

type attemptClock struct {
	started                               time.Time
	offerBudget, leaseBudget, wholeBudget time.Duration
}

func newAttemptClock(lease runnerstore.AttemptLease) attemptClock {
	return attemptClock{started: time.Now(), offerBudget: lease.OfferExpiresAt.Sub(lease.OfferedAt), leaseBudget: lease.LeaseExpiresAt.Sub(lease.OfferedAt), wholeBudget: lease.WholeDeadline.Sub(lease.OfferedAt)}
}

func (clock attemptClock) remainingOffer() time.Duration {
	return clock.offerBudget - time.Since(clock.started)
}
func (clock attemptClock) remainingLease() time.Duration {
	return clock.leaseBudget - time.Since(clock.started)
}
func (clock attemptClock) remainingWhole() time.Duration {
	return clock.wholeBudget - time.Since(clock.started)
}

func positiveDuration(value time.Duration) time.Duration {
	if value <= 0 {
		return time.Nanosecond
	}
	return value
}
