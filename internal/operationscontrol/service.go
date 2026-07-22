// Package operationscontrol implements the guarded, stateless operator query
// and manual-replay composition defined by the Operations Control CDD.
package operationscontrol

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"rc_wsman/internal/calleraccess"
	"rc_wsman/internal/notificationstore"
)

const ReplayBatchMax = 100

const (
	RejectionInvalidRequest = "invalid-request"
	RejectionUnavailable    = "unavailable"
)

type Rejection struct {
	Category string
	Reason   string
}

func (r Rejection) Error() string { return r.Category + ": " + r.Reason }

func IsRejection(err error, category string) bool {
	var rejection Rejection
	return errors.As(err, &rejection) && rejection.Category == category
}

type Store interface {
	Get(context.Context, notificationstore.ActorContext, notificationstore.NotificationID) (notificationstore.Notification, error)
	QueryOutbox(context.Context, notificationstore.ActorContext, []string) (notificationstore.OutboxProjection, error)
	ListDead(context.Context, notificationstore.ActorContext, []string, int, string) (notificationstore.DeadPage, error)
	ListAttemptHistory(context.Context, notificationstore.ActorContext, notificationstore.NotificationID, int, string) (notificationstore.AttemptPage, error)
	Transition(context.Context, notificationstore.ActorContext, notificationstore.TransitionRequest) (notificationstore.TransitionResult, error)
}

type Service struct{ store Store }

func New(store Store) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("operations control: missing store")
	}
	return &Service{store: store}, nil
}

type OutboxProjection struct {
	PendingCount            int     `json:"pending_count"`
	InFlightCount           int     `json:"in_flight_count"`
	DeliveredCount          int     `json:"delivered_count"`
	DeadCount               int     `json:"dead_count"`
	OldestPendingAgeSeconds float64 `json:"oldest_pending_age_seconds"`
}

type NotificationStatus struct {
	NotificationID         string     `json:"notification_id"`
	State                  string     `json:"state"`
	Version                int64      `json:"version"`
	AttemptCount           int        `json:"attempt_count"`
	DeliveryCycleStartedAt time.Time  `json:"delivery_cycle_started_at"`
	ReplayCount            int        `json:"replay_count"`
	LastOutcomeClass       string     `json:"last_outcome_class,omitempty"`
	LastErrorCode          string     `json:"last_error_code,omitempty"`
	CreatedAt              time.Time  `json:"created_at"`
	DeliveredAt            *time.Time `json:"delivered_at,omitempty"`
	DeadAt                 *time.Time `json:"dead_at,omitempty"`
	ReplayedAt             *time.Time `json:"replayed_at,omitempty"`
}

type DeadProjection struct {
	NotificationID string    `json:"notification_id"`
	VendorID       string    `json:"vendor_id"`
	State          string    `json:"state"`
	Version        int64     `json:"version"`
	AttemptCount   int       `json:"attempt_count"`
	ReplayCount    int       `json:"replay_count"`
	DeadAt         time.Time `json:"dead_at"`
	DeadReason     string    `json:"dead_reason"`
}

type DeadPage struct {
	Items      []DeadProjection `json:"items"`
	NextCursor string           `json:"next_cursor,omitempty"`
}

type AttemptProjection struct {
	AttemptSeq   int64     `json:"attempt_seq"`
	EventKind    string    `json:"event_kind"`
	ResultKind   string    `json:"result_kind,omitempty"`
	OutcomeClass string    `json:"outcome_class,omitempty"`
	HTTPStatus   *int      `json:"http_status,omitempty"`
	ErrorCode    string    `json:"error_code,omitempty"`
	Reason       string    `json:"reason,omitempty"`
	RecordedAt   time.Time `json:"recorded_at"`
}

type AttemptPage struct {
	Items      []AttemptProjection `json:"items"`
	NextCursor string              `json:"next_cursor,omitempty"`
}

type ReplayPreviewItem struct {
	InputIndex      int    `json:"input_index"`
	NotificationID  string `json:"notification_id"`
	Outcome         string `json:"outcome"`
	Reason          string `json:"reason,omitempty"`
	CurrentState    string `json:"current_state,omitempty"`
	ExpectedVersion int64  `json:"expected_version,omitempty"`
}

type ReplayExecuteInput struct {
	NotificationID  string `json:"notification_id"`
	ExpectedVersion int64  `json:"expected_version"`
}

type ReplaySucceeded struct {
	InputIndex     int    `json:"input_index"`
	NotificationID string `json:"notification_id"`
	State          string `json:"state"`
	Version        int64  `json:"version"`
}

type ReplaySkipped struct {
	InputIndex     int    `json:"input_index"`
	NotificationID string `json:"notification_id"`
	Reason         string `json:"reason"`
}

type ReplayFailed struct {
	InputIndex     int    `json:"input_index"`
	NotificationID string `json:"notification_id"`
	Reason         string `json:"reason"`
}

type ReplayExecuteResult struct {
	Succeeded []ReplaySucceeded `json:"succeeded"`
	Skipped   []ReplaySkipped   `json:"skipped"`
	Failed    []ReplayFailed    `json:"failed"`
}

func (s *Service) QueryOutbox(ctx context.Context, op calleraccess.OperatorPrincipal, vendorFilter []string) (OutboxProjection, error) {
	actor, err := readActor(op, vendorFilter)
	if err != nil {
		return OutboxProjection{}, err
	}
	projection, err := s.store.QueryOutbox(ctx, actor, vendorFilter)
	if err != nil {
		return OutboxProjection{}, err
	}
	return OutboxProjection{projection.PendingCount, projection.InFlightCount, projection.DeliveredCount, projection.DeadCount, projection.OldestPendingAgeSeconds}, nil
}

func (s *Service) QueryNotification(ctx context.Context, op calleraccess.OperatorPrincipal, id string) (NotificationStatus, error) {
	if err := validateNotificationID(id); err != nil {
		return NotificationStatus{}, err
	}
	actor, err := readActor(op, nil)
	if err != nil {
		return NotificationStatus{}, err
	}
	n, err := s.store.Get(ctx, actor, notificationstore.NotificationID(id))
	if err != nil {
		return NotificationStatus{}, err
	}
	return projectNotification(n), nil
}

func (s *Service) ListDead(ctx context.Context, op calleraccess.OperatorPrincipal, vendorFilter []string, limit int, cursor string) (DeadPage, error) {
	actor, err := readActor(op, vendorFilter)
	if err != nil {
		return DeadPage{}, err
	}
	page, err := s.store.ListDead(ctx, actor, vendorFilter, limit, cursor)
	if err != nil {
		return DeadPage{}, err
	}
	items := make([]DeadProjection, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, DeadProjection{item.NotificationID, item.VendorID, string(item.State), item.Version, item.AttemptCount, item.ReplayCount, item.DeadAt, item.DeadReason})
	}
	return DeadPage{Items: items, NextCursor: page.NextCursor}, nil
}

func (s *Service) ListAttemptHistory(ctx context.Context, op calleraccess.OperatorPrincipal, id string, limit int, cursor string) (AttemptPage, error) {
	if err := validateNotificationID(id); err != nil {
		return AttemptPage{}, err
	}
	actor, err := readActor(op, nil)
	if err != nil {
		return AttemptPage{}, err
	}
	page, err := s.store.ListAttemptHistory(ctx, actor, notificationstore.NotificationID(id), limit, cursor)
	if err != nil {
		return AttemptPage{}, err
	}
	items := make([]AttemptProjection, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, AttemptProjection{item.AttemptSeq, string(item.EventKind), item.ResultKind, item.OutcomeClass, item.HTTPStatus, item.ErrorCode, item.Reason, item.RecordedAt})
	}
	return AttemptPage{Items: items, NextCursor: page.NextCursor}, nil
}

func (s *Service) PreviewReplay(ctx context.Context, op calleraccess.OperatorPrincipal, ids []string, justification string) ([]ReplayPreviewItem, error) {
	if err := op.AuthorizeOperatorAction("replay_preview"); err != nil {
		return nil, err
	}
	if err := validateReplayIDs(ids, justification); err != nil {
		return nil, err
	}
	attenuated, ok := op.NewStoreReadContext(nil)
	if !ok {
		return nil, calleraccess.Rejection{Category: calleraccess.RejectionForbidden, Reason: "scope attenuation failed"}
	}
	actor := storeActor(attenuated)
	items := make([]ReplayPreviewItem, 0, len(ids))
	for index, id := range ids {
		n, err := s.store.Get(ctx, actor, notificationstore.NotificationID(id))
		if err != nil {
			if notificationstore.IsRejection(err, notificationstore.RejectionNotFound) {
				items = append(items, ReplayPreviewItem{InputIndex: index, NotificationID: id, Outcome: "skipped", Reason: "not_found"})
				continue
			}
			return nil, Rejection{Category: RejectionUnavailable, Reason: "preview store query failed"}
		}
		if n.State != notificationstore.StateDead {
			items = append(items, ReplayPreviewItem{InputIndex: index, NotificationID: id, Outcome: "skipped", Reason: "not_dead", CurrentState: string(n.State)})
			continue
		}
		items = append(items, ReplayPreviewItem{InputIndex: index, NotificationID: id, Outcome: "eligible", CurrentState: string(n.State), ExpectedVersion: n.Version})
	}
	return items, nil
}

func (s *Service) ExecuteReplay(ctx context.Context, op calleraccess.OperatorPrincipal, inputs []ReplayExecuteInput, justification string) (ReplayExecuteResult, error) {
	if err := op.AuthorizeOperatorAction("replay_execute"); err != nil {
		return ReplayExecuteResult{}, err
	}
	if len(inputs) > 1 {
		if err := op.AuthorizeOperatorAction("replay_batch"); err != nil {
			return ReplayExecuteResult{}, err
		}
	}
	if err := validateExecuteInputs(inputs, justification); err != nil {
		return ReplayExecuteResult{}, err
	}
	actor := storeActor(op.NewStoreReplayContext())
	result := ReplayExecuteResult{
		Succeeded: make([]ReplaySucceeded, 0),
		Skipped:   make([]ReplaySkipped, 0),
		Failed:    make([]ReplayFailed, 0),
	}
	for index, input := range inputs {
		transition, err := s.store.Transition(ctx, actor, notificationstore.TransitionRequest{
			NotificationID: input.NotificationID, ExpectedState: notificationstore.StateDead,
			ExpectedVersion: input.ExpectedVersion, RequestedTransition: notificationstore.TransitionReplay,
			Justification: justification,
		})
		if err == nil {
			result.Succeeded = append(result.Succeeded, ReplaySucceeded{index, input.NotificationID, string(transition.State), transition.Version})
			continue
		}
		switch {
		case notificationstore.IsRejection(err, notificationstore.RejectionNotFound):
			result.Skipped = append(result.Skipped, ReplaySkipped{index, input.NotificationID, "not_found"})
		case notificationstore.IsRejection(err, notificationstore.RejectionStaleVersion):
			result.Skipped = append(result.Skipped, ReplaySkipped{index, input.NotificationID, "stale_version"})
		case notificationstore.IsRejection(err, notificationstore.RejectionIllegalTransition):
			result.Skipped = append(result.Skipped, ReplaySkipped{index, input.NotificationID, "illegal_transition"})
		case notificationstore.IsRejection(err, notificationstore.RejectionForbiddenAction):
			result.Failed = append(result.Failed, ReplayFailed{index, input.NotificationID, "forbidden"})
		case notificationstore.IsRejection(err, notificationstore.RejectionCommitOutcomeUnknown):
			result.Failed = append(result.Failed, ReplayFailed{index, input.NotificationID, "outcome_unknown"})
		default:
			result.Failed = append(result.Failed, ReplayFailed{index, input.NotificationID, "unavailable"})
		}
	}
	return result, nil
}

func readActor(op calleraccess.OperatorPrincipal, vendorFilter []string) (notificationstore.ActorContext, error) {
	if err := op.AuthorizeOperatorAction("read_notifications"); err != nil {
		return notificationstore.ActorContext{}, err
	}
	attenuated, ok := op.NewStoreReadContext(vendorFilter)
	if !ok {
		return notificationstore.ActorContext{}, calleraccess.Rejection{Category: calleraccess.RejectionForbidden, Reason: "scope attenuation failed"}
	}
	return storeActor(attenuated), nil
}

func storeActor(actor calleraccess.AttenuatedContext) notificationstore.ActorContext {
	capabilities := make([]notificationstore.Capability, 0, len(actor.Capabilities))
	for _, capability := range actor.Capabilities {
		capabilities = append(capabilities, notificationstore.Capability(capability))
	}
	return notificationstore.ActorContext{Kind: notificationstore.ActorKind(actor.Kind), ActorID: actor.ActorID, VendorScope: append([]string(nil), actor.VendorScope...), Capabilities: capabilities}
}

func projectNotification(n notificationstore.Notification) NotificationStatus {
	return NotificationStatus{string(n.ID), string(n.State), n.Version, n.AttemptCount, n.DeliveryCycleStartedAt, n.ReplayCount, n.LastOutcomeClass, n.LastErrorCode, n.CreatedAt, n.DeliveredAt, n.DeadAt, n.ReplayedAt}
}

func validateReplayIDs(ids []string, justification string) error {
	if len(ids) < 1 || len(ids) > ReplayBatchMax || !validJustification(justification) {
		return Rejection{Category: RejectionInvalidRequest, Reason: "invalid replay batch or justification"}
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if err := validateNotificationID(id); err != nil {
			return err
		}
		if _, duplicate := seen[id]; duplicate {
			return Rejection{Category: RejectionInvalidRequest, Reason: "duplicate notification id"}
		}
		seen[id] = struct{}{}
	}
	return nil
}

func validateExecuteInputs(inputs []ReplayExecuteInput, justification string) error {
	if len(inputs) < 1 || len(inputs) > ReplayBatchMax || !validJustification(justification) {
		return Rejection{Category: RejectionInvalidRequest, Reason: "invalid replay batch or justification"}
	}
	seen := make(map[string]struct{}, len(inputs))
	for _, input := range inputs {
		if err := validateNotificationID(input.NotificationID); err != nil || input.ExpectedVersion < 1 {
			return Rejection{Category: RejectionInvalidRequest, Reason: "invalid replay item"}
		}
		if _, duplicate := seen[input.NotificationID]; duplicate {
			return Rejection{Category: RejectionInvalidRequest, Reason: "duplicate notification id"}
		}
		seen[input.NotificationID] = struct{}{}
	}
	return nil
}

func validateNotificationID(id string) error {
	if strings.TrimSpace(id) == "" || len(id) > 128 {
		return Rejection{Category: RejectionInvalidRequest, Reason: "invalid notification id"}
	}
	return nil
}

func validJustification(value string) bool {
	return len(value) >= notificationstore.JustificationMinLen && len(value) <= notificationstore.JustificationMaxLen
}
