// Package notificationstore — pure state-machine decision logic.
//
// These functions have no database side effects and are unit-tested directly.
package notificationstore

import (
	"fmt"
	"time"
)

// validPolicyTerminationReasons lists the reasons allowed for a deterministic
// pre-send policy termination.
var validPolicyTerminationReasons = map[string]struct{}{
	ReasonAttemptLimit:          {},
	ReasonDeadlineExceeded:      {},
	ReasonVendorUnavailable:     {},
	ReasonDestinationRejected:   {},
	ReasonCredentialUnavailable: {},
	ReasonRequestUnbuildable:    {},
}

// validActualDieReasons lists the reasons allowed for an actual-result die.
var validActualDieReasons = map[string]struct{}{
	ReasonNonRetryableHTTPStatus: {},
	ReasonVendorUnreachable:      {},
	ReasonDeadlineExceeded:       {},
}

// ValidateDeliveryResult checks the delivery result matrix and returns the
// appropriate rejection for illegal combinations.
func ValidateDeliveryResult(req TransitionRequest) (*DeliveryResult, error) {
	dr := req.DeliveryResult
	if dr == nil {
		return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "missing delivery_result"}
	}
	switch req.RequestedTransition {
	case TransitionSucceed:
		if dr.ResultKind != ResultKindHTTPResponse {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "succeed requires http_response"}
		}
		if dr.OutcomeClass != OutcomeClassSuccess {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "succeed requires outcome_class=success"}
		}
		if !validHTTPStatus(dr.HTTPStatus) {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "succeed requires http_status"}
		}
		if dr.ErrorCode != "" || dr.Reason != "" {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "succeed forbids error_code/reason"}
		}
		return dr, nil
	case TransitionRetry:
		if dr.ResultKind != ResultKindHTTPResponse && dr.ResultKind != ResultKindTransportFailure {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "retry requires http_response or transport_failure"}
		}
		if dr.OutcomeClass != OutcomeClassRetryableFailure {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "retry requires outcome_class=retryable_failure"}
		}
		if dr.ResultKind == ResultKindHTTPResponse && !validHTTPStatus(dr.HTTPStatus) {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "http_response requires http_status"}
		}
		if dr.ResultKind == ResultKindTransportFailure && dr.ErrorCode == "" {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "transport_failure requires error_code"}
		}
		if dr.Reason != "" {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "retry forbids reason"}
		}
		if req.NextAttemptAt == nil {
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "retry requires next_attempt_at"}
		}
		return dr, nil
	case TransitionDie:
		switch dr.ResultKind {
		case ResultKindHTTPResponse, ResultKindTransportFailure:
			if dr.OutcomeClass != OutcomeClassPermanentFailure {
				return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "actual-result die requires outcome_class=permanent_failure"}
			}
			if _, ok := validActualDieReasons[dr.Reason]; !ok {
				return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "unrecognized die reason"}
			}
			if dr.ResultKind == ResultKindHTTPResponse && !validHTTPStatus(dr.HTTPStatus) {
				return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "http_response die requires http_status"}
			}
			if dr.ResultKind == ResultKindTransportFailure && dr.ErrorCode == "" {
				return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "transport_failure die requires error_code"}
			}
			return dr, nil
		case ResultKindPolicyTermination:
			if dr.OutcomeClass != OutcomeClassPermanentFailure {
				return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "policy_termination requires outcome_class=permanent_failure"}
			}
			if _, ok := validPolicyTerminationReasons[dr.Reason]; !ok {
				return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "unrecognized policy_termination reason"}
			}
			if dr.HTTPStatus != 0 || dr.ErrorCode != "" {
				return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "policy_termination forbids http_status/error_code"}
			}
			return dr, nil
		default:
			return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "die requires http_response/transport_failure/policy_termination"}
		}
	default:
		return nil, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "no delivery_result expected for this transition"}
	}
}

func validHTTPStatus(status int) bool { return status >= 100 && status <= 999 }

// TransitionDecision is the pure output of DecideTransition.
type TransitionDecision struct {
	NewState          State
	AttemptCountDelta int // 0 or +1
	ClearLease        bool
	SetDeliveredAt    bool
	SetDeadAt         bool
	DeadReason        string
	SetNextAttemptAt  *time.Time
	SetReplayedAt     bool
	ReplayActor       string
	ReplayReason      string
	ClearLastOutcome  bool
	LastOutcomeClass  string
	LastErrorCode     string
	EventKind         EventKind
	ResultKind        ResultKind
	OutcomeClass      OutcomeClass
	HTTPStatus        *int
	ErrorCode         string
	Reason            string
}

// DecideTransition validates the request against the current notification and
// returns a decision to be applied by the repository. It does not perform any
// database I/O and does not know the current time.
func DecideTransition(actor ActorContext, req TransitionRequest, current Notification) (TransitionDecision, error) {
	// Actor capability checks are performed by the caller (repository) before
	// invoking DecideTransition, because the actor has already been verified to
	// be present. This function focuses on state-machine legality and result
	// fields.

	if current.Version != req.ExpectedVersion {
		return TransitionDecision{}, Rejection{Category: RejectionStaleVersion, Reason: fmt.Sprintf("expected version %d, got %d", req.ExpectedVersion, current.Version)}
	}
	if current.State != req.ExpectedState {
		return TransitionDecision{}, Rejection{Category: RejectionIllegalTransition, Reason: fmt.Sprintf("expected state %s, got %s", req.ExpectedState, current.State)}
	}

	switch req.RequestedTransition {
	case TransitionSucceed:
		if current.State != StateInFlight {
			return TransitionDecision{}, Rejection{Category: RejectionIllegalTransition, Reason: "succeed requires in_flight"}
		}
		dr, err := ValidateDeliveryResult(req)
		if err != nil {
			return TransitionDecision{}, err
		}
		status := dr.HTTPStatus
		return TransitionDecision{
			NewState:          StateDelivered,
			AttemptCountDelta: 1,
			ClearLease:        true,
			SetDeliveredAt:    true,
			LastOutcomeClass:  string(OutcomeClassSuccess),
			ClearLastOutcome:  false,
			EventKind:         EventKindOutcome,
			ResultKind:        dr.ResultKind,
			OutcomeClass:      dr.OutcomeClass,
			HTTPStatus:        &status,
		}, nil
	case TransitionRetry:
		if current.State != StateInFlight {
			return TransitionDecision{}, Rejection{Category: RejectionIllegalTransition, Reason: "retry requires in_flight"}
		}
		dr, err := ValidateDeliveryResult(req)
		if err != nil {
			return TransitionDecision{}, err
		}
		httpStatus := 0
		if dr.ResultKind == ResultKindHTTPResponse {
			httpStatus = dr.HTTPStatus
		}
		errorCode := ""
		if dr.ResultKind == ResultKindTransportFailure {
			errorCode = dr.ErrorCode
		} else if dr.ResultKind == ResultKindHTTPResponse && dr.ErrorCode != "" {
			errorCode = dr.ErrorCode
		}
		lastError := fmt.Sprintf("http_status:%d", httpStatus)
		if errorCode != "" {
			lastError = errorCode
		}
		return TransitionDecision{
			NewState:          StatePending,
			AttemptCountDelta: 1,
			ClearLease:        true,
			SetNextAttemptAt:  req.NextAttemptAt,
			LastOutcomeClass:  string(OutcomeClassRetryableFailure),
			LastErrorCode:     lastError,
			EventKind:         EventKindOutcome,
			ResultKind:        dr.ResultKind,
			OutcomeClass:      dr.OutcomeClass,
			HTTPStatus:        nullableInt(httpStatus),
			ErrorCode:         errorCode,
		}, nil
	case TransitionDie:
		if current.State != StateInFlight {
			return TransitionDecision{}, Rejection{Category: RejectionIllegalTransition, Reason: "die requires in_flight"}
		}
		dr, err := ValidateDeliveryResult(req)
		if err != nil {
			return TransitionDecision{}, err
		}
		delta := 1
		if dr.ResultKind == ResultKindPolicyTermination {
			delta = 0
		}
		httpStatus := 0
		if dr.ResultKind == ResultKindHTTPResponse {
			httpStatus = dr.HTTPStatus
		}
		return TransitionDecision{
			NewState:          StateDead,
			AttemptCountDelta: delta,
			ClearLease:        true,
			SetDeadAt:         true,
			DeadReason:        dr.Reason,
			LastOutcomeClass:  string(OutcomeClassPermanentFailure),
			LastErrorCode:     dr.Reason,
			EventKind:         EventKindOutcome,
			ResultKind:        dr.ResultKind,
			OutcomeClass:      dr.OutcomeClass,
			HTTPStatus:        nullableInt(httpStatus),
			ErrorCode:         dr.ErrorCode,
			Reason:            dr.Reason,
		}, nil
	case TransitionReplay:
		if current.State != StateDead {
			return TransitionDecision{}, Rejection{Category: RejectionIllegalTransition, Reason: "replay requires dead"}
		}
		if req.DeliveryResult != nil {
			return TransitionDecision{}, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "replay forbids delivery_result"}
		}
		if req.LeaseID != "" {
			return TransitionDecision{}, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "replay forbids lease_id"}
		}
		if len(req.Justification) < JustificationMinLen || len(req.Justification) > JustificationMaxLen {
			return TransitionDecision{}, Rejection{Category: RejectionInvalidJustification, Reason: fmt.Sprintf("justification must be %d..%d chars", JustificationMinLen, JustificationMaxLen)}
		}
		return TransitionDecision{
			NewState:          StatePending,
			AttemptCountDelta: -1, // reset to 0
			ClearLease:        true,
			SetReplayedAt:     true,
			ReplayActor:       actor.ActorID,
			ReplayReason:      req.Justification,
			ClearLastOutcome:  true,
			EventKind:         EventKindReplay,
		}, nil
	default:
		return TransitionDecision{}, Rejection{Category: RejectionInvalidDeliveryResult, Reason: "unknown transition"}
	}
}

func nullableInt(v int) *int {
	if v == 0 {
		return nil
	}
	return &v
}

// ValidateLease checks that the provided lease id and actor id match the
// current notification and that the lease is not expired at now.
func ValidateLease(current Notification, leaseID string, actorID string, now time.Time) error {
	if current.LeaseID == "" || current.LeaseID != leaseID {
		return Rejection{Category: RejectionInvalidLease, Reason: "lease_id mismatch"}
	}
	if current.LeaseActorID != actorID {
		return Rejection{Category: RejectionInvalidLease, Reason: "actor is not lease holder"}
	}
	if current.LeaseExpiresAt == nil || !current.LeaseExpiresAt.After(now) {
		return Rejection{Category: RejectionExpiredLease, Reason: "lease expired"}
	}
	return nil
}

// ValidateClaimActor checks that an actor is allowed to claim deliveries.
func ValidateClaimActor(actor ActorContext) error {
	if err := actor.Validate(); err != nil {
		return err
	}
	if actor.Kind != ActorWorker {
		return Rejection{Category: RejectionForbiddenAction, Reason: "claim requires worker actor"}
	}
	if !actor.HasCapability(CapabilityClaimDelivery) {
		return Rejection{Category: RejectionForbiddenAction, Reason: "missing claim_delivery capability"}
	}
	return nil
}

// ValidateTransitionActor checks that an actor is allowed to record a delivery result.
func ValidateTransitionActor(actor ActorContext, transition Transition) error {
	if err := actor.Validate(); err != nil {
		return err
	}
	switch transition {
	case TransitionSucceed, TransitionRetry, TransitionDie:
		if actor.Kind != ActorWorker {
			return Rejection{Category: RejectionForbiddenAction, Reason: "outcome transitions require worker actor"}
		}
		if !actor.HasCapability(CapabilityRecordDeliveryResult) {
			return Rejection{Category: RejectionForbiddenAction, Reason: "missing record_delivery_result capability"}
		}
	case TransitionReplay:
		if actor.Kind != ActorOperator {
			return Rejection{Category: RejectionForbiddenAction, Reason: "replay requires operator actor"}
		}
		if !actor.HasCapability(CapabilityReplay) {
			return Rejection{Category: RejectionForbiddenAction, Reason: "missing replay capability"}
		}
	default:
		return Rejection{Category: RejectionInvalidDeliveryResult, Reason: "unknown transition"}
	}
	return nil
}
