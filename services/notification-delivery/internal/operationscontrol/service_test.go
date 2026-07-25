package operationscontrol

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/calleraccess"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore"
)

type fakeStore struct {
	actor         notificationstore.ActorContext
	filter        []string
	get           map[string]notificationstore.Notification
	getErr        map[string]error
	transitions   []notificationstore.TransitionRequest
	transition    func(notificationstore.TransitionRequest) (notificationstore.TransitionResult, error)
	getCalls      int
	queryCalls    int
	deadCalls     int
	historyCalls  int
	deadLimit     int
	deadCursor    string
	historyID     string
	historyLimit  int
	historyCursor string
	outbox        notificationstore.OutboxProjection
	dead          notificationstore.DeadPage
	attempts      notificationstore.AttemptPage
}

func (f *fakeStore) Get(_ context.Context, actor notificationstore.ActorContext, id notificationstore.NotificationID) (notificationstore.Notification, error) {
	f.getCalls++
	f.actor = actor
	if err := f.getErr[string(id)]; err != nil {
		return notificationstore.Notification{}, err
	}
	return f.get[string(id)], nil
}
func (f *fakeStore) QueryOutbox(_ context.Context, actor notificationstore.ActorContext, filter []string) (notificationstore.OutboxProjection, error) {
	f.queryCalls++
	f.actor, f.filter = actor, append([]string(nil), filter...)
	return f.outbox, nil
}
func (f *fakeStore) ListDead(_ context.Context, actor notificationstore.ActorContext, filter []string, limit int, cursor string) (notificationstore.DeadPage, error) {
	f.deadCalls++
	f.actor, f.filter = actor, append([]string(nil), filter...)
	f.deadLimit, f.deadCursor = limit, cursor
	return f.dead, nil
}
func (f *fakeStore) ListAttemptHistory(_ context.Context, actor notificationstore.ActorContext, id notificationstore.NotificationID, limit int, cursor string) (notificationstore.AttemptPage, error) {
	f.historyCalls++
	f.actor = actor
	f.historyID, f.historyLimit, f.historyCursor = string(id), limit, cursor
	return f.attempts, nil
}
func (f *fakeStore) Transition(_ context.Context, actor notificationstore.ActorContext, req notificationstore.TransitionRequest) (notificationstore.TransitionResult, error) {
	f.actor = actor
	f.transitions = append(f.transitions, req)
	if f.transition != nil {
		return f.transition(req)
	}
	return notificationstore.TransitionResult{}, nil
}

func (f *fakeStore) calls() int {
	return f.getCalls + f.queryCalls + f.deadCalls + f.historyCalls + len(f.transitions)
}

func reader() calleraccess.OperatorPrincipal {
	return calleraccess.OperatorPrincipal{PrincipalID: "operator-1", VendorScope: []string{"vendor-a", "vendor-b"}, Capabilities: []string{
		calleraccess.CapabilityReadNotifications, calleraccess.CapabilityReplayPreview,
		calleraccess.CapabilityReplayExecute, calleraccess.CapabilityReplayBatch,
	}}
}

func TestServiceQueriesUseClosedScopedProjection(t *testing.T) {
	now := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	store := &fakeStore{
		outbox:   notificationstore.OutboxProjection{PendingCount: 2, InFlightCount: 1, DeliveredCount: 3, DeadCount: 4, OldestPendingAgeSeconds: 5},
		get:      map[string]notificationstore.Notification{"n-1": {ID: "n-1", State: notificationstore.StateDead, Version: 7, AttemptCount: 2, ReplayCount: 1, DeliveryCycleStartedAt: now, CreatedAt: now, Payload: []byte("must-not-project"), LeaseID: "must-not-project"}},
		dead:     notificationstore.DeadPage{Items: []notificationstore.DeadNotification{{NotificationID: "n-1", VendorID: "vendor-a", State: notificationstore.StateDead, Version: 7, AttemptCount: 2, DeadAt: now, DeadReason: "deadline_exceeded"}}, NextCursor: "cursor"},
		attempts: notificationstore.AttemptPage{Items: []notificationstore.Attempt{{AttemptSeq: 1, EventKind: notificationstore.EventKindClaimed, RecordedAt: now, ActorID: "must-not-project", LeaseID: "must-not-project"}}},
	}
	service, _ := New(store)
	outbox, err := service.QueryOutbox(t.Context(), reader(), []string{"vendor-a"})
	if err != nil || outbox.PendingCount != 2 || len(store.filter) != 1 || store.actor.ActorID != "operator-1" || len(store.actor.Capabilities) != 1 {
		t.Fatalf("outbox=%+v actor=%+v filter=%v err=%v", outbox, store.actor, store.filter, err)
	}
	status, err := service.QueryNotification(t.Context(), reader(), "n-1")
	if err != nil || status.NotificationID != "n-1" || status.State != "dead" {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	dead, err := service.ListDead(t.Context(), reader(), []string{"vendor-a"}, 10, "")
	if err != nil || len(dead.Items) != 1 || dead.NextCursor != "cursor" {
		t.Fatalf("dead=%+v err=%v", dead, err)
	}
	history, err := service.ListAttemptHistory(t.Context(), reader(), "n-1", 10, "")
	if err != nil || len(history.Items) != 1 || history.Items[0].EventKind != "claimed" {
		t.Fatalf("history=%+v err=%v", history, err)
	}
}

func TestServicePassesPaginationAndPreservesStoreOrdering(t *testing.T) {
	now := time.Date(2026, 7, 22, 1, 0, 0, 0, time.UTC)
	store := &fakeStore{
		dead: notificationstore.DeadPage{Items: []notificationstore.DeadNotification{
			{NotificationID: "n-older", VendorID: "vendor-a", State: notificationstore.StateDead, Version: 2, DeadAt: now},
			{NotificationID: "n-newer", VendorID: "vendor-a", State: notificationstore.StateDead, Version: 3, DeadAt: now.Add(time.Second)},
		}, NextCursor: "dead-next"},
		attempts: notificationstore.AttemptPage{Items: []notificationstore.Attempt{
			{AttemptSeq: 4, EventKind: notificationstore.EventKindClaimed, RecordedAt: now},
			{AttemptSeq: 5, EventKind: notificationstore.EventKindOutcome, RecordedAt: now.Add(time.Second)},
		}, NextCursor: "attempt-next"},
	}
	service, _ := New(store)
	dead, err := service.ListDead(t.Context(), reader(), []string{"vendor-a"}, 37, "dead-cursor")
	if err != nil || store.deadCalls != 1 || store.deadLimit != 37 || store.deadCursor != "dead-cursor" || len(dead.Items) != 2 || dead.Items[0].NotificationID != "n-older" || dead.Items[1].NotificationID != "n-newer" || dead.NextCursor != "dead-next" {
		t.Fatalf("dead=%+v limit=%d cursor=%q calls=%d err=%v", dead, store.deadLimit, store.deadCursor, store.deadCalls, err)
	}
	history, err := service.ListAttemptHistory(t.Context(), reader(), "n-older", 23, "attempt-cursor")
	if err != nil || store.historyCalls != 1 || store.historyID != "n-older" || store.historyLimit != 23 || store.historyCursor != "attempt-cursor" || len(history.Items) != 2 || history.Items[0].AttemptSeq != 4 || history.Items[1].AttemptSeq != 5 || history.NextCursor != "attempt-next" {
		t.Fatalf("history=%+v id=%q limit=%d cursor=%q calls=%d err=%v", history, store.historyID, store.historyLimit, store.historyCursor, store.historyCalls, err)
	}
}

func TestServiceRejectsMissingCapabilitiesAndOutOfScopeBeforeStore(t *testing.T) {
	withoutCapabilities := reader()
	withoutCapabilities.Capabilities = nil
	queryCases := []struct {
		name string
		call func(*Service) error
	}{
		{"outbox read", func(service *Service) error {
			_, err := service.QueryOutbox(t.Context(), withoutCapabilities, nil)
			return err
		}},
		{"notification read", func(service *Service) error {
			_, err := service.QueryNotification(t.Context(), withoutCapabilities, "n-1")
			return err
		}},
		{"dead read", func(service *Service) error {
			_, err := service.ListDead(t.Context(), withoutCapabilities, nil, 10, "")
			return err
		}},
		{"history read", func(service *Service) error {
			_, err := service.ListAttemptHistory(t.Context(), withoutCapabilities, "n-1", 10, "")
			return err
		}},
		{"preview", func(service *Service) error {
			_, err := service.PreviewReplay(t.Context(), withoutCapabilities, []string{"n-1"}, "vendor recovery was confirmed")
			return err
		}},
		{"execute", func(service *Service) error {
			_, err := service.ExecuteReplay(t.Context(), withoutCapabilities, []ReplayExecuteInput{{"n-1", 1}}, "vendor recovery was confirmed")
			return err
		}},
	}
	for _, tc := range queryCases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			service, _ := New(store)
			if err := tc.call(service); !calleraccess.IsRejection(err, calleraccess.RejectionForbidden) || store.calls() != 0 {
				t.Fatalf("err=%v downstream_calls=%d", err, store.calls())
			}
		})
	}
	for _, call := range []func(*Service) error{
		func(service *Service) error {
			_, err := service.QueryOutbox(t.Context(), reader(), []string{"vendor-outside"})
			return err
		},
		func(service *Service) error {
			_, err := service.ListDead(t.Context(), reader(), []string{"vendor-outside"}, 10, "")
			return err
		},
	} {
		store := &fakeStore{}
		service, _ := New(store)
		if err := call(service); !calleraccess.IsRejection(err, calleraccess.RejectionForbidden) || store.calls() != 0 {
			t.Fatalf("out-of-scope err=%v downstream_calls=%d", err, store.calls())
		}
	}
}

func TestPreviewReplayIsReadOnlyOrderedAndDeenumerated(t *testing.T) {
	store := &fakeStore{
		get: map[string]notificationstore.Notification{
			"dead": {ID: "dead", State: notificationstore.StateDead, Version: 4},
			"live": {ID: "live", State: notificationstore.StatePending, Version: 2},
		},
		getErr: map[string]error{"missing": notificationstore.Rejection{Category: notificationstore.RejectionNotFound}},
	}
	service, _ := New(store)
	items, err := service.PreviewReplay(t.Context(), reader(), []string{"dead", "missing", "live"}, "vendor recovery was confirmed")
	if err != nil || len(items) != 3 || items[0].Outcome != "eligible" || items[0].ExpectedVersion != 4 || items[1].Reason != "not_found" || items[1].CurrentState != "" || items[2].Reason != "not_dead" || len(store.transitions) != 0 {
		t.Fatalf("items=%+v transitions=%d err=%v", items, len(store.transitions), err)
	}
}

func TestExecuteReplayBestEffortClassifiesEveryInput(t *testing.T) {
	store := &fakeStore{}
	store.transition = func(req notificationstore.TransitionRequest) (notificationstore.TransitionResult, error) {
		switch req.NotificationID {
		case "ok":
			return notificationstore.TransitionResult{NotificationID: "ok", State: notificationstore.StatePending, Version: 3}, nil
		case "stale":
			return notificationstore.TransitionResult{}, notificationstore.Rejection{Category: notificationstore.RejectionStaleVersion}
		case "missing":
			return notificationstore.TransitionResult{}, notificationstore.Rejection{Category: notificationstore.RejectionNotFound}
		case "unknown":
			return notificationstore.TransitionResult{}, notificationstore.Rejection{Category: notificationstore.RejectionCommitOutcomeUnknown}
		default:
			return notificationstore.TransitionResult{}, errors.New("database unavailable")
		}
	}
	service, _ := New(store)
	inputs := []ReplayExecuteInput{{"ok", 2}, {"stale", 1}, {"missing", 1}, {"unknown", 1}, {"down", 1}}
	result, err := service.ExecuteReplay(t.Context(), reader(), inputs, "vendor recovery was confirmed")
	if err != nil || len(store.transitions) != 5 || len(result.Succeeded) != 1 || len(result.Skipped) != 2 || len(result.Failed) != 2 || result.Failed[0].Reason != "outcome_unknown" || result.Failed[1].Reason != "unavailable" {
		t.Fatalf("result=%+v calls=%d err=%v", result, len(store.transitions), err)
	}
	if store.actor.ActorID != "operator-1" || len(store.actor.Capabilities) != 1 || store.actor.Capabilities[0] != notificationstore.CapabilityReplay {
		t.Fatalf("replay context was not attenuated: %+v", store.actor)
	}
	for _, req := range store.transitions {
		if req.ExpectedState != notificationstore.StateDead || req.RequestedTransition != notificationstore.TransitionReplay || req.DeliveryResult != nil {
			t.Fatalf("non-canonical replay: %+v", req)
		}
	}
}

func TestReplayValidationAndCapabilityPreventsStoreCalls(t *testing.T) {
	store := &fakeStore{}
	service, _ := New(store)
	withoutBatch := reader()
	withoutBatch.Capabilities = []string{calleraccess.CapabilityReplayExecute}
	_, err := service.ExecuteReplay(t.Context(), withoutBatch, []ReplayExecuteInput{{"a", 1}, {"b", 1}}, "vendor recovery was confirmed")
	if !calleraccess.IsRejection(err, calleraccess.RejectionForbidden) || len(store.transitions) != 0 {
		t.Fatalf("missing batch capability: calls=%d err=%v", len(store.transitions), err)
	}
	_, err = service.ExecuteReplay(t.Context(), reader(), []ReplayExecuteInput{{"same", 1}, {"same", 2}}, "vendor recovery was confirmed")
	if !IsRejection(err, RejectionInvalidRequest) || len(store.transitions) != 0 {
		t.Fatalf("duplicate input reached store: calls=%d err=%v", len(store.transitions), err)
	}
	_, err = service.PreviewReplay(t.Context(), reader(), nil, "vendor recovery was confirmed")
	if !IsRejection(err, RejectionInvalidRequest) {
		t.Fatalf("empty preview error=%v", err)
	}
}

func TestReplayRejectsCompleteInvalidBatchMatrixBeforeStore(t *testing.T) {
	ids101 := make([]string, 101)
	inputs101 := make([]ReplayExecuteInput, 101)
	for i := range ids101 {
		ids101[i] = fmt.Sprintf("n-%d", i)
		inputs101[i] = ReplayExecuteInput{NotificationID: ids101[i], ExpectedVersion: 1}
	}
	validJustification := "vendor recovery was confirmed"
	previewCases := []struct {
		name          string
		ids           []string
		justification string
	}{
		{"empty", nil, validJustification},
		{"over 100", ids101, validJustification},
		{"duplicate", []string{"same", "same"}, validJustification},
		{"invalid id", []string{""}, validJustification},
		{"short justification", []string{"n-1"}, "short"},
		{"long justification", []string{"n-1"}, strings.Repeat("x", notificationstore.JustificationMaxLen+1)},
	}
	for _, tc := range previewCases {
		t.Run("preview/"+tc.name, func(t *testing.T) {
			store := &fakeStore{}
			service, _ := New(store)
			if _, err := service.PreviewReplay(t.Context(), reader(), tc.ids, tc.justification); !IsRejection(err, RejectionInvalidRequest) {
				t.Fatalf("error=%v", err)
			}
			if store.getCalls != 0 || len(store.transitions) != 0 {
				t.Fatalf("invalid preview reached Store: gets=%d transitions=%d", store.getCalls, len(store.transitions))
			}
		})
	}
	executeCases := []struct {
		name          string
		inputs        []ReplayExecuteInput
		justification string
	}{
		{"empty", nil, validJustification},
		{"over 100", inputs101, validJustification},
		{"duplicate", []ReplayExecuteInput{{"same", 1}, {"same", 2}}, validJustification},
		{"missing version", []ReplayExecuteInput{{"n-1", 0}}, validJustification},
		{"invalid id", []ReplayExecuteInput{{"", 1}}, validJustification},
		{"short justification", []ReplayExecuteInput{{"n-1", 1}}, "short"},
		{"long justification", []ReplayExecuteInput{{"n-1", 1}}, strings.Repeat("x", notificationstore.JustificationMaxLen+1)},
	}
	for _, tc := range executeCases {
		t.Run("execute/"+tc.name, func(t *testing.T) {
			store := &fakeStore{}
			service, _ := New(store)
			if _, err := service.ExecuteReplay(t.Context(), reader(), tc.inputs, tc.justification); !IsRejection(err, RejectionInvalidRequest) {
				t.Fatalf("error=%v", err)
			}
			if store.getCalls != 0 || len(store.transitions) != 0 {
				t.Fatalf("invalid execute reached Store: gets=%d transitions=%d", store.getCalls, len(store.transitions))
			}
		})
	}
}
