package runnerscheduler

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/processsupervisor"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func TestSessionRequiresDurableAcceptAndTerminalReceipts(t *testing.T) {
	now := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	store := &sessionStore{now: now}
	lease := testLease(now)
	launcher := newFakeLauncher(t, store, lease)
	session, err := NewSession(SessionConfig{Store: store, Launcher: launcher, ControlBuildHash: strings.Repeat("f", 64), HeartbeatInterval: time.Second, LeaseOfferTimeout: 5 * time.Second, CancelWindow: 5 * time.Second, CancelGrace: time.Second, TerminalExitGrace: time.Second, PollInterval: 10 * time.Millisecond, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Run(t.Context(), lease); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if strings.Join(store.events, ",") != "lease_accept,terminal" {
		t.Fatalf("durable event order = %v", store.events)
	}
	if strings.Join(store.delivered, ",") != "hello_ack,lease_offer,event_receipt,event_receipt" {
		t.Fatalf("control delivery order = %v", store.delivered)
	}
	if !store.executionObservedAfterAcceptReceipt {
		t.Fatal("worker execution was not gated by durable lease_accept receipt")
	}
	if !store.successExitAfterTerminalReceipt {
		t.Fatal("worker success exit was not gated by terminal receipt")
	}
}

func TestSessionStopsAfterAcceptedEffectOutcomeRequiresReconciliation(t *testing.T) {
	now := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	store := &sessionStore{now: now, reconcileOnKind: runnerprotocol.KindEffectOutcome}
	lease := testLease(now)
	launcher := newReconciliationLauncher(t, store, lease)
	session := testSession(t, store, launcher, now)

	err := session.Run(t.Context(), lease)
	if !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) {
		t.Fatalf("accepted effect reconciliation did not stop the session: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if strings.Join(store.events, ",") != "lease_accept,effect_outcome" {
		t.Fatalf("events continued after reconciliation: %v", store.events)
	}
	if strings.Join(store.delivered, ",") != "hello_ack,lease_offer,event_receipt,event_receipt" {
		t.Fatalf("reconciliation receipt was not delivered before stop: %v", store.delivered)
	}
	if store.processExitCalls != 1 {
		t.Fatalf("reconciliation stop recorded %d process exits", store.processExitCalls)
	}
}

func TestSessionDoesNotCancelAfterTerminalReceiptDuringDeadlineWindow(t *testing.T) {
	now := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	store := &sessionStore{now: now}
	lease := testLease(now)
	lease.WholeDeadline = now.Add(25 * time.Millisecond)
	launcher := newFakeLauncherWithExitDelay(t, store, lease, 100*time.Millisecond)
	session := testSession(t, store, launcher, now)

	if err := session.Run(t.Context(), lease); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.cancelRequests != 0 {
		t.Fatalf("terminal receipt was followed by %d cancellation requests", store.cancelRequests)
	}
}

func TestSessionTimersUseDatabaseDurationsDespiteHostClockSkew(t *testing.T) {
	databaseNow := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	store := &sessionStore{now: databaseNow}
	lease := testLease(databaseNow)
	launcher := newFakeLauncher(t, store, lease)
	session, err := NewSession(SessionConfig{
		Store: store, Launcher: launcher, ControlBuildHash: strings.Repeat("f", 64),
		HeartbeatInterval: time.Second, LeaseOfferTimeout: 5 * time.Second,
		CancelWindow: 5 * time.Second, CancelGrace: time.Second,
		TerminalExitGrace: time.Second, PollInterval: 10 * time.Millisecond,
		Now: func() time.Time { return databaseNow.Add(10 * 365 * 24 * time.Hour) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Run(t.Context(), lease); err != nil {
		t.Fatalf("host clock skew collapsed database-derived timers: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.cancelRequests != 0 {
		t.Fatalf("host clock skew caused %d premature cancellations", store.cancelRequests)
	}
}

func TestSessionOfferBudgetIncludesSlowNegotiationPersistence(t *testing.T) {
	now := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	store := &sessionStore{now: now, negotiationDelay: 60 * time.Millisecond}
	lease := testLease(now)
	lease.OfferExpiresAt = now.Add(40 * time.Millisecond)
	launcher := newFakeLauncher(t, store, lease)
	session := testSession(t, store, launcher, now)

	err := session.Run(t.Context(), lease)
	if !runnerstore.IsCode(err, runnerstore.ErrorLeaseExpired) {
		t.Fatalf("slow negotiation did not exhaust the real offer budget: %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.delivered) != 0 {
		t.Fatalf("expired negotiation still delivered controls: %v", store.delivered)
	}
}

func TestSessionUnprovenTerminationRequiresReconciliation(t *testing.T) {
	now := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	store := &sessionStore{now: now}
	reader, writer := io.Pipe()
	_ = writer.Close()
	process := &uncertainProcess{stdin: nopWriteCloser{Writer: io.Discard}, stdout: reader, done: make(chan struct{})}
	session, err := NewSession(SessionConfig{Store: store, Launcher: &fakeLauncher{process: (*fakeProcess)(nil)}, ControlBuildHash: strings.Repeat("f", 64), HeartbeatInterval: time.Second, LeaseOfferTimeout: 5 * time.Second, CancelWindow: 5 * time.Second, CancelGrace: 10 * time.Millisecond, TerminalExitGrace: 10 * time.Millisecond, PollInterval: time.Millisecond, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	session.config.Launcher = processLauncherFunc(func(context.Context) (WorkerProcess, error) { return process, nil })
	err = session.Run(t.Context(), testLease(now))
	if store.attemptFailureCalls != 1 || store.processExitCalls != 0 {
		t.Fatalf("unproven termination was not fail-closed: attemptFailures=%d processExits=%d err=%v", store.attemptFailureCalls, store.processExitCalls, err)
	}
}

func TestSessionLeaseRejectEndsProcessAndReturnsRetryable(t *testing.T) {
	now := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	store := &sessionStore{now: now}
	lease := testLease(now)
	launcher := newLeaseRejectLauncher(t, store, lease)
	session := testSession(t, store, launcher, now)
	err := session.Run(t.Context(), lease)
	var sessionFailure *sessionRunError
	if !errors.As(err, &sessionFailure) || sessionFailure.disposition != sessionErrorRetryable {
		t.Fatalf("lease reject was not classified as retryable: %v", err)
	}
	select {
	case <-launcher.process.done:
	default:
		t.Fatal("lease-reject worker process was left running")
	}
}

func testSession(t testing.TB, store SessionStore, launcher ProcessLauncher, now time.Time) *Session {
	t.Helper()
	session, err := NewSession(SessionConfig{
		Store: store, Launcher: launcher, ControlBuildHash: strings.Repeat("f", 64),
		HeartbeatInterval: time.Second, LeaseOfferTimeout: 5 * time.Second,
		CancelWindow: 5 * time.Second, CancelGrace: time.Second,
		TerminalExitGrace: time.Second, PollInterval: 10 * time.Millisecond,
		Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func TestNewSessionRejectsNilDurableSessionStore(t *testing.T) {
	var store SessionStore
	if _, err := NewSession(SessionConfig{Store: store}); err == nil {
		t.Fatal("session accepted a nil durable settlement store")
	}
}

type sessionStore struct {
	runnerstore.Store
	mu                                                                   sync.Mutex
	now                                                                  time.Time
	events, delivered                                                    []string
	acceptCommitted, terminalCommitted                                   bool
	executionObservedAfterAcceptReceipt, successExitAfterTerminalReceipt bool
	reconcileOnKind                                                      runnerprotocol.Kind
	negotiationDelay                                                     time.Duration
	cancelRequests, processExitCalls, attemptFailureCalls                int
}

var _ SessionStore = (*sessionStore)(nil)

func (store *sessionStore) RecordNegotiation(_ context.Context, input runnerstore.NegotiationInput) (runnerstore.Negotiation, error) {
	if store.negotiationDelay > 0 {
		time.Sleep(store.negotiationDelay)
	}
	sequenceNull := (*int64)(nil)
	eventID := "ack-1"
	message := runnerprotocol.Envelope{ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: runnerprotocol.KindHelloAck, WorkspaceID: input.Lease.WorkspaceID, JobID: nil, WorkflowRunID: nil, AttemptID: nil, LeaseID: nil, FencingToken: nil, Sequence: sequenceNull, EventID: eventID, CorrelationID: input.Hello.CorrelationID, SentAt: runnerstore.CanonicalTimestamp(store.now), Payload: map[string]any{"controlBuildHash": input.ControlBuildHash, "selectedProtocolVersion": runnerprotocol.ProtocolVersion, "heartbeatIntervalMs": input.HeartbeatInterval.Milliseconds(), "leaseOfferTimeoutMs": input.LeaseOfferTimeout.Milliseconds()}}
	body, err := runnerprotocol.CanonicalEnvelopeBytes(message)
	return runnerstore.Negotiation{ProcessSessionID: "session-1", HelloAck: message, HelloAckBytes: body}, err
}
func (store *sessionStore) RecordEvent(_ context.Context, input runnerstore.RecordEventInput) (runnerstore.RecordedEvent, error) {
	store.mu.Lock()
	store.events = append(store.events, string(input.Message.Kind))
	if input.Message.Kind == runnerprotocol.KindLeaseAccept {
		store.acceptCommitted = true
	}
	if input.Message.Kind == runnerprotocol.KindTerminal {
		store.terminalCommitted = true
	}
	store.mu.Unlock()
	sequence := *input.Message.Sequence + 10
	receipt, err := runnerprotocol.CreateEventReceipt(input.Message, runnerprotocol.CreateReceiptInput{Sequence: sequence, SentAt: runnerstore.CanonicalTimestamp(store.now), Status: runnerprotocol.ReceiptAccepted, ControlBuildHash: input.ControlBuildHash})
	if err != nil {
		return runnerstore.RecordedEvent{}, err
	}
	body, err := runnerprotocol.CanonicalEnvelopeBytes(receipt)
	jobState, attemptState := runnerstore.JobRunning, runnerstore.AttemptRunning
	if input.Message.Kind == runnerprotocol.KindTerminal {
		jobState, attemptState = runnerstore.JobTerminal, runnerstore.AttemptTerminal
	}
	if input.Message.Kind == runnerprotocol.KindLeaseReject {
		jobState, attemptState = runnerstore.JobQueued, runnerstore.AttemptRejected
	}
	if input.Message.Kind == store.reconcileOnKind {
		jobState, attemptState = runnerstore.JobReconciliationRequired, runnerstore.AttemptReconciliationRequired
	}
	return runnerstore.RecordedEvent{Receipt: receipt, ReceiptBytes: body, Status: runnerstore.ReceiptAccepted, JobState: jobState, AttemptState: attemptState}, err
}
func (store *sessionStore) MarkControlDelivered(_ context.Context, _ string, _ string, kind string, _ time.Time) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.delivered = append(store.delivered, kind)
	return nil
}
func (store *sessionStore) PendingCancel(context.Context, string, string, string) (*runnerstore.CancelControl, error) {
	return nil, nil
}

func (store *sessionStore) RequestCancel(context.Context, runnerstore.CancelInput) (runnerstore.CancelControl, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.cancelRequests++
	return runnerstore.CancelControl{}, runnerstore.Failure(runnerstore.ErrorConflict, "unexpected cancellation request", nil)
}

func (store *sessionStore) RecordProcessExit(context.Context, runnerstore.ProcessExitInput) (runnerstore.JobView, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.processExitCalls++
	return runnerstore.JobView{}, nil
}

func (store *sessionStore) RecordAttemptFailure(context.Context, runnerstore.AttemptFailureInput) (runnerstore.JobView, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.attemptFailureCalls++
	return runnerstore.JobView{State: runnerstore.JobReconciliationRequired}, nil
}

type processLauncherFunc func(context.Context) (WorkerProcess, error)

func (function processLauncherFunc) Start(ctx context.Context) (WorkerProcess, error) {
	return function(ctx)
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }

type uncertainProcess struct {
	stdin  io.WriteCloser
	stdout io.ReadCloser
	done   chan struct{}
}

func (process *uncertainProcess) Stdin() io.WriteCloser { return process.stdin }
func (process *uncertainProcess) Stdout() io.ReadCloser { return process.stdout }
func (process *uncertainProcess) Done() <-chan struct{} { return process.done }
func (process *uncertainProcess) Wait(ctx context.Context) (processsupervisor.Result, error) {
	<-ctx.Done()
	return processsupervisor.Result{}, ctx.Err()
}
func (process *uncertainProcess) Terminate(context.Context, time.Duration) error {
	return errors.New("termination not proven")
}
func (process *uncertainProcess) ForceKill(context.Context) error {
	return errors.New("kill not proven")
}

type fakeLauncher struct{ process *fakeProcess }

func (launcher *fakeLauncher) Start(context.Context) (WorkerProcess, error) {
	return launcher.process, nil
}

type fakeProcess struct {
	stdin  io.WriteCloser
	stdout io.ReadCloser
	done   chan struct{}
	result processsupervisor.Result
	once   sync.Once
}

func (process *fakeProcess) Stdin() io.WriteCloser { return process.stdin }
func (process *fakeProcess) Stdout() io.ReadCloser { return process.stdout }
func (process *fakeProcess) Done() <-chan struct{} { return process.done }
func (process *fakeProcess) Wait(ctx context.Context) (processsupervisor.Result, error) {
	select {
	case <-process.done:
		return process.result, nil
	case <-ctx.Done():
		return processsupervisor.Result{}, ctx.Err()
	}
}
func (process *fakeProcess) Terminate(context.Context, time.Duration) error {
	process.once.Do(func() { close(process.done) })
	return nil
}
func (process *fakeProcess) ForceKill(ctx context.Context) error { return process.Terminate(ctx, 0) }

func newFakeLauncher(t *testing.T, store *sessionStore, lease runnerstore.AttemptLease) *fakeLauncher {
	return newFakeLauncherWithExitDelay(t, store, lease, 0)
}

func newFakeLauncherWithExitDelay(t *testing.T, store *sessionStore, lease runnerstore.AttemptLease, exitDelay time.Duration) *fakeLauncher {
	t.Helper()
	controlReader, controlWriter := io.Pipe()
	workerReader, workerWriter := io.Pipe()
	process := &fakeProcess{stdin: controlWriter, stdout: workerReader, done: make(chan struct{}), result: processsupervisor.Result{ExitCode: 0}}
	go func() {
		defer workerWriter.Close()
		reader := newFrameReader(controlReader)
		hello := testHello()
		helloBytes, _ := runnerprotocol.CanonicalEnvelopeBytes(hello)
		_ = writeFrame(workerWriter, helloBytes)
		ack, _, err := reader.Read()
		if err != nil || ack.Kind != runnerprotocol.KindHelloAck {
			process.result = processsupervisor.Result{Err: err, ExitCode: 2}
			process.once.Do(func() { close(process.done) })
			return
		}
		offer, _, err := reader.Read()
		if err != nil || offer.Kind != runnerprotocol.KindLeaseOffer {
			process.result = processsupervisor.Result{Err: err, ExitCode: 3}
			process.once.Do(func() { close(process.done) })
			return
		}
		accept := leasedMessage(lease, runnerprotocol.KindLeaseAccept, 1, "accept-1", store.now, map[string]any{"acceptedAt": runnerstore.CanonicalTimestamp(store.now), "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)})
		acceptBytes, _ := runnerprotocol.CanonicalEnvelopeBytes(accept)
		_ = writeFrame(workerWriter, acceptBytes)
		receipt, _, err := reader.Read()
		store.mu.Lock()
		store.executionObservedAfterAcceptReceipt = err == nil && receipt.Kind == runnerprotocol.KindEventReceipt && store.acceptCommitted
		store.mu.Unlock()
		terminal := leasedMessage(lease, runnerprotocol.KindTerminal, 2, "terminal-1", store.now, map[string]any{"status": "completed", "finishedAt": runnerstore.CanonicalTimestamp(store.now), "resultHash": strings.Repeat("1", 64), "terminalReason": nil})
		terminalBytes, _ := runnerprotocol.CanonicalEnvelopeBytes(terminal)
		_ = writeFrame(workerWriter, terminalBytes)
		receipt, _, err = reader.Read()
		store.mu.Lock()
		store.successExitAfterTerminalReceipt = err == nil && receipt.Kind == runnerprotocol.KindEventReceipt && store.terminalCommitted
		store.mu.Unlock()
		if exitDelay > 0 {
			time.Sleep(exitDelay)
		}
		process.once.Do(func() { close(process.done) })
	}()
	return &fakeLauncher{process: process}
}

func newReconciliationLauncher(t *testing.T, store *sessionStore, lease runnerstore.AttemptLease) *fakeLauncher {
	t.Helper()
	controlReader, controlWriter := io.Pipe()
	workerReader, workerWriter := io.Pipe()
	process := &fakeProcess{stdin: controlWriter, stdout: workerReader, done: make(chan struct{}), result: processsupervisor.Result{ExitCode: 0}}
	go func() {
		defer workerWriter.Close()
		reader := newFrameReader(controlReader)
		helloBytes, _ := runnerprotocol.CanonicalEnvelopeBytes(testHello())
		_ = writeFrame(workerWriter, helloBytes)
		if ack, _, err := reader.Read(); err != nil || ack.Kind != runnerprotocol.KindHelloAck {
			return
		}
		if offer, _, err := reader.Read(); err != nil || offer.Kind != runnerprotocol.KindLeaseOffer {
			return
		}
		accept := leasedMessage(lease, runnerprotocol.KindLeaseAccept, 1, "accept-reconciliation", store.now, map[string]any{
			"acceptedAt": runnerstore.CanonicalTimestamp(store.now), "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt),
		})
		acceptBytes, _ := runnerprotocol.CanonicalEnvelopeBytes(accept)
		_ = writeFrame(workerWriter, acceptBytes)
		if receipt, _, err := reader.Read(); err != nil || receipt.Kind != runnerprotocol.KindEventReceipt {
			return
		}
		outcome := leasedMessage(lease, runnerprotocol.KindEffectOutcome, 2, "effect-reconciliation", store.now, map[string]any{
			"effectId": "effect-1", "status": "reconciliation_required", "outcomeHash": strings.Repeat("2", 64),
		})
		outcomeBytes, _ := runnerprotocol.CanonicalEnvelopeBytes(outcome)
		_ = writeFrame(workerWriter, outcomeBytes)
		if receipt, _, err := reader.Read(); err != nil || receipt.Kind != runnerprotocol.KindEventReceipt {
			return
		}
		<-process.done
	}()
	return &fakeLauncher{process: process}
}

func newLeaseRejectLauncher(t *testing.T, store *sessionStore, lease runnerstore.AttemptLease) *fakeLauncher {
	t.Helper()
	controlReader, controlWriter := io.Pipe()
	workerReader, workerWriter := io.Pipe()
	process := &fakeProcess{stdin: controlWriter, stdout: workerReader, done: make(chan struct{}), result: processsupervisor.Result{ExitCode: 0}}
	go func() {
		defer workerWriter.Close()
		reader := newFrameReader(controlReader)
		helloBytes, _ := runnerprotocol.CanonicalEnvelopeBytes(testHello())
		_ = writeFrame(workerWriter, helloBytes)
		if ack, _, err := reader.Read(); err != nil || ack.Kind != runnerprotocol.KindHelloAck {
			return
		}
		if offer, _, err := reader.Read(); err != nil || offer.Kind != runnerprotocol.KindLeaseOffer {
			return
		}
		reject := leasedMessage(lease, runnerprotocol.KindLeaseReject, 1, "reject-1", store.now, map[string]any{"reason": "unsupported", "rejectedAt": runnerstore.CanonicalTimestamp(store.now)})
		rejectBytes, _ := runnerprotocol.CanonicalEnvelopeBytes(reject)
		_ = writeFrame(workerWriter, rejectBytes)
		_, _, _ = reader.Read()
		<-process.done
	}()
	return &fakeLauncher{process: process}
}

func testLease(now time.Time) runnerstore.AttemptLease {
	jobID, runID, attemptID, leaseID := "job-1", "run-1", "attempt-1", "lease-1"
	fence, sequence := int64(1), int64(1)
	offer := runnerprotocol.Envelope{ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: runnerprotocol.KindLeaseOffer, WorkspaceID: "workspace-1", JobID: &jobID, WorkflowRunID: &runID, AttemptID: &attemptID, LeaseID: &leaseID, FencingToken: &fence, Sequence: &sequence, EventID: "offer-1", CorrelationID: "correlation-1", SentAt: runnerstore.CanonicalTimestamp(now), Payload: map[string]any{"executionDescriptorRef": "descriptor-1", "executionDescriptorHash": strings.Repeat("a", 64), "jobSpecHash": strings.Repeat("b", 64), "workflowId": "workflow-1", "workflowVersion": "1.0.0", "workflowSourceHash": strings.Repeat("c", 64), "manifestHash": strings.Repeat("d", 64), "inputHash": strings.Repeat("e", 64), "offeredAt": runnerstore.CanonicalTimestamp(now), "expiresAt": runnerstore.CanonicalTimestamp(now.Add(time.Minute))}}
	body, _ := runnerprotocol.CanonicalEnvelopeBytes(offer)
	return runnerstore.AttemptLease{WorkspaceID: "workspace-1", JobID: jobID, WorkflowRunID: runID, CorrelationID: "correlation-1", AttemptID: attemptID, LeaseID: leaseID, FencingToken: fence, OfferedAt: now, LeaseExpiresAt: now.Add(time.Minute), OfferExpiresAt: now.Add(5 * time.Second), WholeDeadline: now.Add(time.Minute), LeaseOffer: offer, LeaseOfferBytes: body}
}
func leasedMessage(lease runnerstore.AttemptLease, kind runnerprotocol.Kind, sequence int64, eventID string, now time.Time, payload map[string]any) runnerprotocol.Envelope {
	jobID, runID, attemptID, leaseID, fence := lease.JobID, lease.WorkflowRunID, lease.AttemptID, lease.LeaseID, lease.FencingToken
	return runnerprotocol.Envelope{ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: kind, WorkspaceID: lease.WorkspaceID, JobID: &jobID, WorkflowRunID: &runID, AttemptID: &attemptID, LeaseID: &leaseID, FencingToken: &fence, Sequence: &sequence, EventID: eventID, CorrelationID: lease.CorrelationID, SentAt: runnerstore.CanonicalTimestamp(now), Payload: payload}
}
