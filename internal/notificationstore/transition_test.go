package notificationstore

import (
	"testing"
	"time"
)

func workerActor() ActorContext {
	return ActorContext{
		Kind:         ActorWorker,
		ActorID:      "worker-1",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []Capability{CapabilityClaimDelivery, CapabilityRecordDeliveryResult},
	}
}

func operatorActor() ActorContext {
	return ActorContext{
		Kind:         ActorOperator,
		ActorID:      "op-1",
		VendorScope:  []string{"vendor-a"},
		Capabilities: []Capability{CapabilityReplay},
	}
}

func inFlightNotification() Notification {
	expires := time.Now().Add(30 * time.Second)
	return Notification{
		ID:             "n-1",
		CallerID:       "caller-1",
		VendorID:       "vendor-a",
		IdempotencyKey: "key-1",
		State:          StateInFlight,
		Version:        2,
		AttemptCount:   1,
		LeaseID:        "lease-1",
		LeaseActorID:   "worker-1",
		LeaseExpiresAt: &expires,
	}
}

func baseRequest(t Transition) TransitionRequest {
	return TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: t,
	}
}

func TestDecideTransition_Succeed(t *testing.T) {
	d, err := DecideTransition(workerActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: TransitionSucceed,
		DeliveryResult: &DeliveryResult{
			ResultKind:   ResultKindHTTPResponse,
			OutcomeClass: OutcomeClassSuccess,
			HTTPStatus:   200,
		},
	}, inFlightNotification())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.NewState != StateDelivered || d.AttemptCountDelta != 1 || !d.ClearLease || !d.SetDeliveredAt {
		t.Fatalf("bad decision: %+v", d)
	}
	if d.HTTPStatus == nil || *d.HTTPStatus != 200 {
		t.Fatalf("expected http_status 200, got %+v", d.HTTPStatus)
	}
	if d.LastOutcomeClass != string(OutcomeClassSuccess) {
		t.Fatalf("expected last outcome success, got %q", d.LastOutcomeClass)
	}
}

func TestDecideTransition_Succeed_RejectsWrongKind(t *testing.T) {
	_, err := DecideTransition(workerActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: TransitionSucceed,
		DeliveryResult: &DeliveryResult{
			ResultKind:   ResultKindTransportFailure,
			OutcomeClass: OutcomeClassSuccess,
		},
	}, inFlightNotification())
	if !IsRejection(err, RejectionInvalidDeliveryResult) {
		t.Fatalf("expected invalid-delivery-result, got %v", err)
	}
}

func TestDecideTransition_Retry(t *testing.T) {
	next := time.Now().Add(time.Minute)
	d, err := DecideTransition(workerActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: TransitionRetry,
		NextAttemptAt:       &next,
		DeliveryResult: &DeliveryResult{
			ResultKind:   ResultKindTransportFailure,
			OutcomeClass: OutcomeClassRetryableFailure,
			ErrorCode:    "dial_timeout",
		},
	}, inFlightNotification())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.NewState != StatePending || d.AttemptCountDelta != 1 {
		t.Fatalf("bad decision: %+v", d)
	}
	if d.SetNextAttemptAt == nil || !d.SetNextAttemptAt.Equal(next) {
		t.Fatalf("expected next_attempt_at %v, got %+v", next, d.SetNextAttemptAt)
	}
	if d.ErrorCode != "dial_timeout" {
		t.Fatalf("expected error code preserved, got %q", d.ErrorCode)
	}
}

func TestDecideTransition_Retry_RequiresNextAttemptAt(t *testing.T) {
	_, err := DecideTransition(workerActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: TransitionRetry,
		DeliveryResult: &DeliveryResult{
			ResultKind:   ResultKindHTTPResponse,
			OutcomeClass: OutcomeClassRetryableFailure,
			HTTPStatus:   503,
		},
	}, inFlightNotification())
	if !IsRejection(err, RejectionInvalidDeliveryResult) {
		t.Fatalf("expected invalid-delivery-result, got %v", err)
	}
}

func TestDecideTransition_Retry_TransportFailureRequiresErrorCode(t *testing.T) {
	next := time.Now().Add(time.Minute)
	_, err := DecideTransition(workerActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: TransitionRetry,
		NextAttemptAt:       &next,
		DeliveryResult: &DeliveryResult{
			ResultKind:   ResultKindTransportFailure,
			OutcomeClass: OutcomeClassRetryableFailure,
		},
	}, inFlightNotification())
	if !IsRejection(err, RejectionInvalidDeliveryResult) {
		t.Fatalf("expected invalid-delivery-result, got %v", err)
	}
}

func TestDecideTransition_Die_ActualResultCountsAttempt(t *testing.T) {
	d, err := DecideTransition(workerActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: TransitionDie,
		DeliveryResult: &DeliveryResult{
			ResultKind:   ResultKindHTTPResponse,
			OutcomeClass: OutcomeClassPermanentFailure,
			HTTPStatus:   400,
			Reason:       ReasonNonRetryableHTTPStatus,
		},
	}, inFlightNotification())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.NewState != StateDead || d.AttemptCountDelta != 1 || !d.SetDeadAt {
		t.Fatalf("actual-result die must count the attempt: %+v", d)
	}
	if d.SetNextAttemptAt != nil {
		t.Fatalf("dead rows must not schedule a next attempt")
	}
	if d.DeadReason != ReasonNonRetryableHTTPStatus {
		t.Fatalf("expected dead reason preserved, got %q", d.DeadReason)
	}
}

// B-01 adjudication: a retryable actual result finishing at/after the cycle
// send cutoff dies atomically in the current Store write, counts +1, and
// forbids next_attempt_at. deadline_exceeded is a valid actual-die reason.
func TestDecideTransition_Die_B01DeadlineExceededCountsAttempt(t *testing.T) {
	d, err := DecideTransition(workerActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: TransitionDie,
		DeliveryResult: &DeliveryResult{
			ResultKind:   ResultKindTransportFailure,
			OutcomeClass: OutcomeClassPermanentFailure,
			ErrorCode:    "dial_timeout",
			Reason:       ReasonDeadlineExceeded,
		},
	}, inFlightNotification())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.AttemptCountDelta != 1 {
		t.Fatalf("B-01 actual-result die must count +1, got delta %d", d.AttemptCountDelta)
	}
	if d.SetNextAttemptAt != nil {
		t.Fatalf("B-01 die forbids next_attempt_at")
	}
	if d.DeadReason != ReasonDeadlineExceeded {
		t.Fatalf("expected deadline_exceeded reason, got %q", d.DeadReason)
	}
}

func TestDecideTransition_Die_PolicyTerminationDoesNotCount(t *testing.T) {
	reasons := []string{
		ReasonAttemptLimit,
		ReasonDeadlineExceeded,
		ReasonVendorUnavailable,
		ReasonDestinationRejected,
		ReasonCredentialUnavailable,
		ReasonRequestUnbuildable,
	}
	for _, reason := range reasons {
		d, err := DecideTransition(workerActor(), TransitionRequest{
			NotificationID:      "n-1",
			ExpectedState:       StateInFlight,
			ExpectedVersion:     2,
			LeaseID:             "lease-1",
			RequestedTransition: TransitionDie,
			DeliveryResult: &DeliveryResult{
				ResultKind:   ResultKindPolicyTermination,
				OutcomeClass: OutcomeClassPermanentFailure,
				Reason:       reason,
			},
		}, inFlightNotification())
		if err != nil {
			t.Fatalf("reason %s: unexpected error: %v", reason, err)
		}
		if d.AttemptCountDelta != 0 {
			t.Fatalf("reason %s: policy termination must not count, got delta %d", reason, d.AttemptCountDelta)
		}
		if d.NewState != StateDead {
			t.Fatalf("reason %s: expected dead, got %s", reason, d.NewState)
		}
	}
}

func TestDecideTransition_Die_PolicyTerminationForbidsHTTPFields(t *testing.T) {
	_, err := DecideTransition(workerActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: TransitionDie,
		DeliveryResult: &DeliveryResult{
			ResultKind:   ResultKindPolicyTermination,
			OutcomeClass: OutcomeClassPermanentFailure,
			Reason:       ReasonAttemptLimit,
			HTTPStatus:   500,
		},
	}, inFlightNotification())
	if !IsRejection(err, RejectionInvalidDeliveryResult) {
		t.Fatalf("expected invalid-delivery-result, got %v", err)
	}
}

func TestDecideTransition_Die_UnknownResultRejected(t *testing.T) {
	_, err := DecideTransition(workerActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		LeaseID:             "lease-1",
		RequestedTransition: TransitionDie,
		DeliveryResult: &DeliveryResult{
			ResultKind:   ResultKindUnknownResult,
			OutcomeClass: OutcomeClassPermanentFailure,
			Reason:       ReasonVendorUnreachable,
		},
	}, inFlightNotification())
	if !IsRejection(err, RejectionInvalidDeliveryResult) {
		t.Fatalf("expected invalid-delivery-result, got %v", err)
	}
}

func TestDecideTransition_Replay(t *testing.T) {
	n := inFlightNotification()
	n.State = StateDead
	n.AttemptCount = 25
	justification := "vendor restored after incident 2026-07-21"
	d, err := DecideTransition(operatorActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateDead,
		ExpectedVersion:     2,
		RequestedTransition: TransitionReplay,
		Justification:       justification,
	}, n)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d.NewState != StatePending || d.AttemptCountDelta != -1 {
		t.Fatalf("replay must reset attempt count: %+v", d)
	}
	if !d.ClearLastOutcome || !d.SetReplayedAt {
		t.Fatalf("replay must clear last outcome and set replayed_at: %+v", d)
	}
	if d.ReplayReason != justification || d.ReplayActor != "op-1" {
		t.Fatalf("replay actor/reason mismatch: %+v", d)
	}
}

func TestDecideTransition_Replay_JustificationBounds(t *testing.T) {
	n := inFlightNotification()
	n.State = StateDead
	_, err := DecideTransition(operatorActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateDead,
		ExpectedVersion:     2,
		RequestedTransition: TransitionReplay,
		Justification:       "too short",
	}, n)
	if !IsRejection(err, RejectionInvalidJustification) {
		t.Fatalf("expected invalid-justification, got %v", err)
	}
}

func TestDecideTransition_Replay_RequiresDeadState(t *testing.T) {
	_, err := DecideTransition(operatorActor(), TransitionRequest{
		NotificationID:      "n-1",
		ExpectedState:       StateInFlight,
		ExpectedVersion:     2,
		RequestedTransition: TransitionReplay,
		Justification:       "vendor restored after incident",
	}, inFlightNotification())
	if !IsRejection(err, RejectionIllegalTransition) {
		t.Fatalf("expected illegal-transition, got %v", err)
	}
}

func TestDecideTransition_StaleVersion(t *testing.T) {
	req := baseRequest(TransitionSucceed)
	req.ExpectedVersion = 99
	req.DeliveryResult = &DeliveryResult{
		ResultKind:   ResultKindHTTPResponse,
		OutcomeClass: OutcomeClassSuccess,
		HTTPStatus:   200,
	}
	_, err := DecideTransition(workerActor(), req, inFlightNotification())
	if !IsRejection(err, RejectionStaleVersion) {
		t.Fatalf("expected stale-version, got %v", err)
	}
}

func TestDecideTransition_ExpectedStateMismatch(t *testing.T) {
	req := baseRequest(TransitionSucceed)
	req.ExpectedState = StatePending
	req.DeliveryResult = &DeliveryResult{
		ResultKind:   ResultKindHTTPResponse,
		OutcomeClass: OutcomeClassSuccess,
		HTTPStatus:   200,
	}
	_, err := DecideTransition(workerActor(), req, inFlightNotification())
	if !IsRejection(err, RejectionIllegalTransition) {
		t.Fatalf("expected illegal-transition, got %v", err)
	}
}

func TestValidateLease(t *testing.T) {
	n := inFlightNotification()
	now := time.Now()
	if err := ValidateLease(n, "lease-1", "worker-1", now); err != nil {
		t.Fatalf("valid lease rejected: %v", err)
	}
	if err := ValidateLease(n, "lease-other", "worker-1", now); !IsRejection(err, RejectionInvalidLease) {
		t.Fatalf("expected invalid-lease for wrong id, got %v", err)
	}
	if err := ValidateLease(n, "lease-1", "worker-2", now); !IsRejection(err, RejectionInvalidLease) {
		t.Fatalf("expected invalid-lease for wrong actor, got %v", err)
	}
	if err := ValidateLease(n, "lease-1", "worker-1", now.Add(time.Hour)); !IsRejection(err, RejectionExpiredLease) {
		t.Fatalf("expected expired-lease, got %v", err)
	}
}

func TestValidateClaimActor(t *testing.T) {
	if err := ValidateClaimActor(workerActor()); err != nil {
		t.Fatalf("worker actor rejected: %v", err)
	}
	if err := ValidateClaimActor(operatorActor()); !IsRejection(err, RejectionForbiddenAction) {
		t.Fatalf("expected forbidden-action for operator claim, got %v", err)
	}
	noCap := workerActor()
	noCap.Capabilities = []Capability{CapabilityReadNotifications}
	if err := ValidateClaimActor(noCap); !IsRejection(err, RejectionForbiddenAction) {
		t.Fatalf("expected forbidden-action for missing capability, got %v", err)
	}
}

func TestValidateTransitionActor(t *testing.T) {
	if err := ValidateTransitionActor(workerActor(), TransitionRetry); err != nil {
		t.Fatalf("worker retry rejected: %v", err)
	}
	if err := ValidateTransitionActor(operatorActor(), TransitionRetry); !IsRejection(err, RejectionForbiddenAction) {
		t.Fatalf("expected forbidden-action for operator retry, got %v", err)
	}
	if err := ValidateTransitionActor(workerActor(), TransitionReplay); !IsRejection(err, RejectionForbiddenAction) {
		t.Fatalf("expected forbidden-action for worker replay, got %v", err)
	}
	if err := ValidateTransitionActor(operatorActor(), TransitionReplay); err != nil {
		t.Fatalf("operator replay rejected: %v", err)
	}
}
