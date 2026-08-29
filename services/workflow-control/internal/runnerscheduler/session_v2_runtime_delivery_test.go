package runnerscheduler

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/processsupervisor"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

func TestV2AuthorityControlOrdering(t *testing.T) {
	for _, test := range []struct {
		name         string
		decisionKind authoritycontract.Kind
	}{
		{name: "effect authorize", decisionKind: authoritycontract.KindEffectAuthorization},
		{name: "budget reserve", decisionKind: authoritycontract.KindBudgetAuthorization},
		{name: "resume advance", decisionKind: authoritycontract.KindResumeOffer},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, process, lease, recorded := authorityControlFixture(test.decisionKind, true, 12)
			session := &V2Session{config: V2SessionConfig{Store: store, Now: time.Now}}
			sent, err := session.sendRecordedV2Controls(t.Context(), process, lease, recorded, true)
			if err != nil || !sent {
				t.Fatalf("deliver decision authority lane: sent=%v err=%v", sent, err)
			}
			if got, want := strings.Join(store.acknowledged, ","), "event_receipt:10,"+string(test.decisionKind)+":11"; got != want {
				t.Fatalf("authority control ACK order = %s, want %s", got, want)
			}
			if got := strings.Join(store.delivered, ","); got != "event_receipt,"+string(test.decisionKind)+",cancel_request" {
				t.Fatalf("decision successor cancel did not use ordinary Runner v2 delivery: %s", got)
			}
		})
	}

	t.Run("no decision uses exact optional companion", func(t *testing.T) {
		store, process, lease, recorded := authorityControlFixture("", false, 11)
		session := &V2Session{config: V2SessionConfig{Store: store, Now: time.Now}}
		sent, err := session.sendRecordedV2Controls(t.Context(), process, lease, recorded, true)
		if err != nil || !sent {
			t.Fatalf("deliver no-decision authority lane: sent=%v err=%v", sent, err)
		}
		if got, want := strings.Join(store.acknowledged, ","), "event_receipt:10,cancel_request:11"; got != want {
			t.Fatalf("optional cancellation companion order = %s, want %s", got, want)
		}
	})

	t.Run("pre-event cancel is reconciliation not reverse delivery", func(t *testing.T) {
		store, process, lease, recorded := authorityControlFixture(authoritycontract.KindEffectAuthorization, true, 9)
		session := &V2Session{config: V2SessionConfig{Store: store, Now: time.Now}}
		sent, err := session.sendRecordedV2Controls(t.Context(), process, lease, recorded, true)
		if sent || !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) || process.stdin.Len() != 0 {
			t.Fatalf("lower cancellation sequence escaped fail-closed ordering: sent=%v bytes=%d err=%v", sent, process.stdin.Len(), err)
		}
	})

	t.Run("decision response loss stops before cancel", func(t *testing.T) {
		store, process, lease, recorded := authorityControlFixture(authoritycontract.KindResumeOffer, true, 12)
		store.failAcknowledgement = recorded.Decision.EventID
		session := &V2Session{config: V2SessionConfig{Store: store, Now: time.Now}}
		sent, err := session.sendRecordedV2Controls(t.Context(), process, lease, recorded, true)
		if sent || err == nil || strings.Contains(strings.Join(store.delivered, ","), "cancel_request") {
			t.Fatalf("decision response loss advanced into cancel: sent=%v delivered=%v err=%v", sent, store.delivered, err)
		}
		if got := strings.Join(store.reconciled, ","); got != string(authoritycontract.KindResumeOffer) {
			t.Fatalf("decision response loss was not latched: %s", got)
		}
	})

	t.Run("durable reconciliation ACK stops before decision and cancel", func(t *testing.T) {
		store, process, lease, recorded := authorityControlFixture(authoritycontract.KindBudgetAuthorization, true, 12)
		store.reconciliationAcknowledgement = recorded.Receipt.EventID
		session := &V2Session{config: V2SessionConfig{Store: store, Now: time.Now}}
		sent, err := session.sendRecordedV2Controls(t.Context(), process, lease, recorded, true)
		if sent || !runnerstore.IsCode(err, runnerstore.ErrorReconciliation) ||
			strings.Contains(strings.Join(store.delivered, ","), string(authoritycontract.KindBudgetAuthorization)) ||
			strings.Contains(strings.Join(store.delivered, ","), "cancel_request") {
			t.Fatalf("reconciliation ACK advanced into dependent control: sent=%v delivered=%v err=%v", sent, store.delivered, err)
		}
	})

	t.Run("ACK deadline is the lease and job hard bound rather than thirty seconds", func(t *testing.T) {
		store, process, lease, recorded := authorityControlFixture("", false, 11)
		now := time.Date(2026, 8, 22, 0, 0, 0, 0, time.UTC)
		lease.LeaseExpiresAt = now.Add(2 * time.Minute)
		lease.WholeDeadline = now.Add(5 * time.Minute)
		store.expectedDeadline = lease.LeaseExpiresAt
		session := &V2Session{config: V2SessionConfig{Store: store, Now: func() time.Time { return now }}}
		if _, err := session.sendRecordedV2Controls(t.Context(), process, lease, recorded, false); err != nil {
			t.Fatalf("deliver control before hard deadline: %v", err)
		}
		if !store.observedDeadline.Equal(lease.LeaseExpiresAt) || store.observedDeadline.Equal(now.Add(30*time.Second)) {
			t.Fatalf("ACK deadline = %s, want lease hard bound %s", store.observedDeadline, lease.LeaseExpiresAt)
		}
	})
}

type v2ControlOrderStore struct {
	runnerstore.V2SessionStore
	mu                            sync.Mutex
	sequences                     map[string]int64
	pending                       *runnerstore.CancelControl
	preparedCancel                runnerstore.V2CancelControl
	delivered                     []string
	acknowledged                  []string
	reconciled                    []string
	failAcknowledgement           string
	reconciliationAcknowledgement string
	expectedDeadline              time.Time
	observedDeadline              time.Time
	authorityACK                  map[string]bool
}

func (store *v2ControlOrderStore) PendingCancel(context.Context, string, string, string) (*runnerstore.CancelControl, error) {
	return store.pending, nil
}

func (store *v2ControlOrderStore) PrepareV2Cancel(context.Context, runnerstore.AttemptLease, runnerstore.CancelControl) (runnerstore.V2CancelControl, error) {
	return store.preparedCancel, nil
}

func (store *v2ControlOrderStore) MarkV2ControlDeliveryStarted(context.Context, string, string, string, time.Time) error {
	return nil
}

func (store *v2ControlOrderStore) MarkV2ControlDelivered(_ context.Context, _ string, eventID, kind string, _ time.Time) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.delivered = append(store.delivered, kind)
	return nil
}

func (store *v2ControlOrderStore) MarkV2ControlDeliveryReconciliation(_ context.Context, _ string, _ string, kind string, _ time.Time) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.reconciled = append(store.reconciled, kind)
	return nil
}

func (store *v2ControlOrderStore) WaitV2ControlAcknowledged(ctx context.Context, _ string, eventID string) (runnerstore.V2ControlDeliveryDisposition, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if deadline, ok := ctx.Deadline(); ok {
		store.observedDeadline = deadline
		if !store.expectedDeadline.IsZero() && !deadline.Equal(store.expectedDeadline) {
			return "", errors.New("unexpected acknowledgement deadline")
		}
	}
	if !store.authorityACK[eventID] {
		return runnerstore.V2ControlDeliveryAccepted, nil
	}
	if eventID == store.reconciliationAcknowledgement {
		return runnerstore.V2ControlDeliveryReconciliationRequired, nil
	}
	if eventID == store.failAcknowledgement {
		return "", errors.New("simulated acknowledgement response loss")
	}
	kind := "unknown"
	for candidate, sequence := range store.sequences {
		if strings.HasPrefix(candidate, eventID+"\x00") {
			kind = strings.TrimPrefix(candidate, eventID+"\x00") + ":" + fmtInt(sequence)
			break
		}
	}
	store.acknowledged = append(store.acknowledged, kind)
	return runnerstore.V2ControlDeliveryAccepted, nil
}

func authorityControlFixture(
	decisionKind authoritycontract.Kind,
	withDecision bool,
	cancelSequence int64,
) (*v2ControlOrderStore, *v2CaptureProcess, runnerstore.AttemptLease, runnerstore.V2RecordedEvent) {
	bindingID := "binding-order"
	receiptSequence, decisionSequence := int64(10), int64(11)
	receipt := authoritycontract.Message{Kind: authoritycontract.KindEventReceipt, EventID: "receipt", Sequence: &receiptSequence}
	cancel := authoritycontract.Message{Kind: authoritycontract.KindCancelRequest, EventID: "cancel", Sequence: &cancelSequence}
	store := &v2ControlOrderStore{
		sequences: map[string]int64{
			receipt.EventID + "\x00" + string(receipt.Kind): receiptSequence,
			cancel.EventID + "\x00" + string(cancel.Kind):   cancelSequence,
		},
		pending:        &runnerstore.CancelControl{ControlSequence: cancelSequence},
		preparedCancel: runnerstore.V2CancelControl{Message: cancel, ExactBytes: []byte("{}\n")},
		authorityACK:   map[string]bool{receipt.EventID: true, cancel.EventID: !withDecision},
	}
	recorded := runnerstore.V2RecordedEvent{
		Receipt: receipt, ReceiptBytes: []byte("{}\n"), AuthorityBindingID: &bindingID,
	}
	if withDecision {
		decision := authoritycontract.Message{Kind: decisionKind, EventID: "decision", Sequence: &decisionSequence}
		recorded.Decision, recorded.DecisionBytes = &decision, []byte("{}\n")
		store.sequences[decision.EventID+"\x00"+string(decision.Kind)] = decisionSequence
		store.authorityACK[decision.EventID] = true
	}
	lease := runnerstore.AttemptLease{WorkspaceID: "workspace", JobID: "job", AttemptID: "attempt"}
	return store, &v2CaptureProcess{done: make(chan struct{})}, lease, recorded
}

func fmtInt(value int64) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}

type v2CaptureProcess struct {
	stdin bytes.Buffer
	done  chan struct{}
}

func (process *v2CaptureProcess) Stdin() io.WriteCloser {
	return nopWriteCloser{Writer: &process.stdin}
}
func (process *v2CaptureProcess) Stdout() io.ReadCloser { return io.NopCloser(bytes.NewReader(nil)) }
func (process *v2CaptureProcess) Done() <-chan struct{} { return process.done }
func (process *v2CaptureProcess) Wait(context.Context) (processsupervisor.Result, error) {
	return processsupervisor.Result{}, nil
}
func (process *v2CaptureProcess) Terminate(context.Context, time.Duration) error { return nil }
func (process *v2CaptureProcess) ForceKill(context.Context) error                { return nil }
