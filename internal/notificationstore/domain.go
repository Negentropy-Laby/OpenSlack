// Package notificationstore defines the Notification Store domain model, typed
// rejections, and the repository interface that the PostgreSQL adapter
// implements.
//
// The package is intentionally database-agnostic. It only validates internal
// domain invariants and exposes the operations required by the B2
// Notification Store core.
package notificationstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"time"
)

// Maximum decoded vendor payload size. The CDD fixes this at 256 KiB.
const PayloadMaxBytes = 262144

// Idempotency key constraints per the CDD.
const (
	IdempotencyKeyMaxLen  = 255
	IdempotencyKeyPattern = `^[A-Za-z0-9._\-]{1,255}$`
)

// Lease TTL hard cap per architecture (delivery CDD may request lower values).
const LeaseTTLMax = 30 * time.Second

// Recovery batch bounds per the CDD.
const (
	RecoveryBatchMin = 1
	RecoveryBatchMax = 1000
)

// List pagination bounds per the CDD.
const (
	ListPageDefault = 100
	ListPageMax     = 500
	ListPageMin     = 1
)

// Justification bounds for operator replay.
const (
	JustificationMinLen = 20
	JustificationMaxLen = 1024
)

// State is the lifecycle of a notification.
type State string

// Notification states.
const (
	StatePending   State = "pending"
	StateInFlight  State = "in_flight"
	StateDelivered State = "delivered"
	StateDead      State = "dead"
)

// ActorKind identifies the principal namespace of a server-internal actor.
type ActorKind string

// Actor kinds.
const (
	ActorWorker   ActorKind = "worker"
	ActorOperator ActorKind = "operator"
	ActorSystem   ActorKind = "system"
)

// Capability is a fine-grained action permission carried by an ActorContext.
type Capability string

// Capabilities used by the Notification Store.
const (
	CapabilityClaimDelivery        Capability = "claim_delivery"
	CapabilityRecordDeliveryResult Capability = "record_delivery_result"
	CapabilityRecoverExpiredLeases Capability = "recover_expired_leases"
	CapabilityReadNotifications    Capability = "read_notifications"
	CapabilityReadAllNotifications Capability = "read_all_notifications"
	CapabilityReplay               Capability = "replay"
)

// EventKind is the type of a delivery_attempts row.
type EventKind string

const (
	EventKindClaimed  EventKind = "claimed"
	EventKindOutcome  EventKind = "outcome"
	EventKindRecovery EventKind = "recovery"
	EventKindReplay   EventKind = "replay"
)

// ResultKind is the normalized result of an attempt.
type ResultKind string

const (
	ResultKindHTTPResponse      ResultKind = "http_response"
	ResultKindTransportFailure  ResultKind = "transport_failure"
	ResultKindUnknownResult     ResultKind = "unknown_result"
	ResultKindPolicyTermination ResultKind = "policy_termination"
)

// OutcomeClass is the classification of an attempt result.
type OutcomeClass string

const (
	OutcomeClassSuccess          OutcomeClass = "success"
	OutcomeClassRetryableFailure OutcomeClass = "retryable_failure"
	OutcomeClassPermanentFailure OutcomeClass = "permanent_failure"
)

// Transition identifies a state-machine transition request.
type Transition string

const (
	TransitionSucceed Transition = "succeed"
	TransitionRetry   Transition = "retry"
	TransitionDie     Transition = "die"
	TransitionReplay  Transition = "replay"
)

// Rejection categories returned by the Store. They are stable values that the
// HTTP composition layer maps to public status codes.
const (
	RejectionInvalidActorContext    = "invalid-actor-context"
	RejectionNotFound               = "not-found"
	RejectionForbiddenAction        = "forbidden-action"
	RejectionInvalidDeliveryResult  = "invalid-delivery-result"
	RejectionInvalidLeaseTTL        = "invalid-lease-ttl"
	RejectionInvalidJustification   = "invalid-justification"
	RejectionInvalidRecoveryRequest = "invalid-recovery-request"
	RejectionInvalidBatchLimit      = "invalid-batch-limit"
	RejectionInvalidPageLimit       = "invalid-page-limit"
	RejectionInvalidCursor          = "invalid-cursor"
	RejectionClockUnavailable       = "clock-unavailable"
	RejectionIllegalTransition      = "illegal-transition"
	RejectionStaleVersion           = "stale-version"
	RejectionInvalidLease           = "invalid-lease"
	RejectionExpiredLease           = "expired-lease"
	RejectionInvariantViolation     = "invariant-violation"
	RejectionIdempotencyConflict    = "IdempotencyConflict"
	RejectionInvalidIntake          = "invalid-intake"
	RejectionPayloadTooLarge        = "payload-too-large"
	RejectionInvalidIdempotencyKey  = "invalid-idempotency-key"
	RejectionCommitRolledBack       = "commit-rolled-back"
	RejectionCommitOutcomeUnknown   = "commit-outcome-unknown"
)

// Valid result reasons for worker die transitions.
const (
	ReasonNonRetryableHTTPStatus = "non_retryable_http_status"
	ReasonVendorUnreachable      = "vendor_unreachable"
	ReasonDeadlineExceeded       = "deadline_exceeded"
)

// Valid policy-termination reasons.
const (
	ReasonAttemptLimit          = "attempt_limit"
	ReasonVendorUnavailable     = "vendor_unavailable"
	ReasonDestinationRejected   = "destination_rejected"
	ReasonCredentialUnavailable = "credential_unavailable"
	ReasonRequestUnbuildable    = "request_unbuildable"
)

// Fixed recovery error code.
const ErrorCodeLeaseExpiredUnknownResult = "lease_expired_unknown_result"

var idempotencyKeyRegex = regexp.MustCompile(IdempotencyKeyPattern)

// Rejection is a typed, non-retryable domain rejection. It carries a stable
// category string and a human-readable reason that is safe for logs (no
// payload or secrets).
type Rejection struct {
	Category string
	Reason   string
}

func (r Rejection) Error() string {
	if r.Reason == "" {
		return r.Category
	}
	return fmt.Sprintf("%s: %s", r.Category, r.Reason)
}

// IsRejection reports whether err is a Rejection with the given category.
func IsRejection(err error, category string) bool {
	var r Rejection
	if errors.As(err, &r) {
		return r.Category == category
	}
	return false
}

// ValidatedIntake is the internal handoff from the ingress composition layer.
// It is already caller-authenticated, vendor-authorized, and payload-decoded.
type ValidatedIntake struct {
	CallerID       string
	VendorID       string
	Payload        []byte
	IdempotencyKey string
}

// ActorContext is a trusted server-internal identity supplied by the
// composition layer. Store never accepts caller-provided identity fields.
type ActorContext struct {
	Kind         ActorKind
	ActorID      string
	VendorScope  []string
	Capabilities []Capability
}

// HasCapability reports whether the actor has the given capability.
func (a ActorContext) HasCapability(c Capability) bool {
	for _, have := range a.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// CoversVendor reports whether the actor's scope includes the vendor.
func (a ActorContext) CoversVendor(vendorID string) bool {
	for _, v := range a.VendorScope {
		if v == vendorID {
			return true
		}
	}
	return false
}

// EffectiveScope returns the intersection of the actor's vendor scope and the
// optional explicit filter. An empty filter resolves to the actor scope.
// If a filter value is outside the actor scope, the returned slice is empty
// and the caller should reject as not-found.
func (a ActorContext) EffectiveScope(filter []string) ([]string, bool) {
	if len(filter) == 0 {
		return a.VendorScope, true
	}
	allowed := make(map[string]struct{}, len(a.VendorScope))
	for _, v := range a.VendorScope {
		allowed[v] = struct{}{}
	}
	out := make([]string, 0, len(filter))
	for _, v := range filter {
		if _, ok := allowed[v]; !ok {
			return nil, false
		}
		out = append(out, v)
	}
	return out, true
}

// Validate checks that ActorContext is a fully populated, trusted context.
func (a ActorContext) Validate() error {
	if a.Kind == "" || a.ActorID == "" || len(a.VendorScope) == 0 || len(a.Capabilities) == 0 {
		return Rejection{Category: RejectionInvalidActorContext, Reason: "missing actor fields"}
	}
	if a.Kind != ActorWorker && a.Kind != ActorOperator && a.Kind != ActorSystem {
		return Rejection{Category: RejectionInvalidActorContext, Reason: "unknown actor kind"}
	}
	seenVendors := make(map[string]struct{}, len(a.VendorScope))
	for _, vendorID := range a.VendorScope {
		if vendorID == "" {
			return Rejection{Category: RejectionInvalidActorContext, Reason: "empty vendor scope member"}
		}
		if _, duplicate := seenVendors[vendorID]; duplicate {
			return Rejection{Category: RejectionInvalidActorContext, Reason: "duplicate vendor scope member"}
		}
		seenVendors[vendorID] = struct{}{}
	}
	allowedCapabilities := map[Capability]struct{}{
		CapabilityClaimDelivery: {}, CapabilityRecordDeliveryResult: {},
		CapabilityRecoverExpiredLeases: {}, CapabilityReadNotifications: {},
		CapabilityReadAllNotifications: {}, CapabilityReplay: {},
	}
	seenCapabilities := make(map[Capability]struct{}, len(a.Capabilities))
	for _, capability := range a.Capabilities {
		if _, allowed := allowedCapabilities[capability]; !allowed {
			return Rejection{Category: RejectionInvalidActorContext, Reason: "unknown capability"}
		}
		if _, duplicate := seenCapabilities[capability]; duplicate {
			return Rejection{Category: RejectionInvalidActorContext, Reason: "duplicate capability"}
		}
		seenCapabilities[capability] = struct{}{}
	}
	return nil
}

// NotificationID is an opaque identifier for a notification.
type NotificationID string

// Notification is the aggregate root of the Notification Store.
type Notification struct {
	ID                     NotificationID
	CallerID               string
	VendorID               string
	IdempotencyKey         string
	RequestFingerprint     []byte
	Payload                []byte
	State                  State
	Version                int64
	AttemptCount           int
	DeliveryCycleStartedAt time.Time
	ReplayCount            int
	CreatedAt              time.Time
	UpdatedAt              time.Time
	NextAttemptAt          *time.Time
	LeaseID                string
	LeaseExpiresAt         *time.Time
	LeaseActorID           string
	DeliveredAt            *time.Time
	DeadAt                 *time.Time
	DeadReason             string
	ReplayedAt             *time.Time
	ReplayActor            string
	ReplayReason           string
	LastOutcomeClass       string
	LastErrorCode          string
}

// Lease represents a claim lease on a notification.
type Lease struct {
	LeaseID   string
	ExpiresAt time.Time
	ActorID   string
}

// Attempt is one append-only row in delivery_attempts.
type Attempt struct {
	ID             string
	NotificationID string
	AttemptSeq     int64
	EventKind      EventKind
	ClaimedAt      *time.Time
	OutcomeClass   string
	ResultKind     string
	HTTPStatus     *int
	ErrorCode      string
	Reason         string
	ActorID        string
	LeaseID        string
	LeaseExpiresAt *time.Time
	RecordedAt     time.Time
}

// DeliveryResult is the worker-provided outcome of an attempt.
type DeliveryResult struct {
	ResultKind   ResultKind
	OutcomeClass OutcomeClass
	HTTPStatus   int    // required for http_response
	ErrorCode    string // required for transport_failure; optional for http_response
	Reason       string // required for die variants
}

// TransitionRequest is the canonical state-transition command.
type TransitionRequest struct {
	NotificationID      string
	ExpectedState       State
	ExpectedVersion     int64
	LeaseID             string
	RequestedTransition Transition
	DeliveryResult      *DeliveryResult
	NextAttemptAt       *time.Time // required for retry
	Justification       string     // required for replay
}

// ClaimFilter selects an eligible pending notification for claim.
type ClaimFilter struct {
	VendorID       string
	NotificationID string
}

// LeaseClaim is the result of a successful claim.
type LeaseClaim struct {
	NotificationID         string
	IngressIdempotencyKey  string
	LeaseID                string
	LeaseExpiresAt         time.Time
	Version                int64
	Payload                []byte
	VendorID               string
	AttemptCount           int
	DeliveryCycleStartedAt time.Time
	CreatedAt              time.Time
}

// IntakeResult is the result of a successful or idempotent accept.
type IntakeResult struct {
	NotificationID   string
	IdempotentReplay bool
	AcceptedAt       time.Time
}

// TransitionResult is the result of a successful state transition.
type TransitionResult struct {
	NotificationID         string
	State                  State
	Version                int64
	AttemptCount           int
	DeliveryCycleStartedAt time.Time
	ReplayCount            int
}

// RecoveredLease is the result of a single lease recovery.
type RecoveredLease struct {
	NotificationID string
	Version        int64
	AttemptCount   int
}

// OutboxProjection is the BL-06 aggregate over an effective scope.
type OutboxProjection struct {
	PendingCount            int
	InFlightCount           int
	DeliveredCount          int
	DeadCount               int
	OldestPendingAgeSeconds float64
}

// DeadPage is a snapshot-bounded page of dead notifications.
type DeadPage struct {
	Items      []DeadNotification
	NextCursor string
}

// DeadNotification is a sanitized dead-row summary.
type DeadNotification struct {
	NotificationID string
	VendorID       string
	State          State
	Version        int64
	AttemptCount   int
	ReplayCount    int
	DeadAt         time.Time
	DeadReason     string
}

// AttemptPage is a stable page of attempt history.
type AttemptPage struct {
	Items      []Attempt
	NextCursor string
}

// ComputeFingerprint computes a stable, normalized request fingerprint from a
// ValidatedIntake. The algorithm is intentionally opaque to callers: the
// Store alone computes and compares this value.
func ComputeFingerprint(in ValidatedIntake) []byte {
	// Canonical: vendor_id\0caller_id\0idempotency_key\0payload
	h := sha256.New()
	_, _ = h.Write([]byte(in.VendorID))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(in.CallerID))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(in.IdempotencyKey))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write(in.Payload)
	return h.Sum(nil)
}

// FingerprintHex returns a hex-encoded fingerprint for test/debug use.
func FingerprintHex(fp []byte) string { return hex.EncodeToString(fp) }

// ValidateIntake checks the internal ValidatedIntake fields.
func ValidateIntake(in ValidatedIntake) error {
	if in.CallerID == "" || in.VendorID == "" || in.Payload == nil || in.IdempotencyKey == "" {
		return Rejection{Category: RejectionInvalidIntake, Reason: "missing required field"}
	}
	if len(in.Payload) > PayloadMaxBytes {
		return Rejection{Category: RejectionPayloadTooLarge, Reason: fmt.Sprintf("payload exceeds %d bytes", PayloadMaxBytes)}
	}
	if err := ValidateIdempotencyKey(in.IdempotencyKey); err != nil {
		return err
	}
	return nil
}

// ValidateIdempotencyKey validates the public Idempotency-Key syntax without
// requiring the rest of an intake. Ingress uses it before doing vendor work.
func ValidateIdempotencyKey(key string) error {
	if len(key) > IdempotencyKeyMaxLen || !idempotencyKeyRegex.MatchString(key) {
		return Rejection{Category: RejectionInvalidIdempotencyKey, Reason: "invalid idempotency key format"}
	}
	return nil
}

// ErrNoEligibleNotification is returned when claim scanning finds no row.
var ErrNoEligibleNotification = errors.New("no eligible notification")

// Repository is the abstract interface implemented by the PostgreSQL adapter.
type Repository interface {
	// Intake persists a new notification or returns an existing one.
	Intake(ctx context.Context, in ValidatedIntake) (IntakeResult, error)

	// ClaimNext selects the oldest eligible pending notification and issues a lease.
	ClaimNext(ctx context.Context, actor ActorContext, filter *ClaimFilter, leaseTTL time.Duration) (LeaseClaim, error)

	// Transition applies a state-machine transition under OCC + lease validation.
	Transition(ctx context.Context, actor ActorContext, req TransitionRequest) (TransitionResult, error)

	// RecoverExpiredLeases sweeps expired in-flight leases back to pending.
	RecoverExpiredLeases(ctx context.Context, actor ActorContext, batchLimit int) ([]RecoveredLease, error)

	// Get returns a notification summary for an authorized actor.
	Get(ctx context.Context, actor ActorContext, id NotificationID) (Notification, error)

	// QueryOutbox returns the BL-06 aggregate projection.
	QueryOutbox(ctx context.Context, actor ActorContext, vendorFilter []string) (OutboxProjection, error)

	// ListDead returns a snapshot-bounded page of dead notifications.
	ListDead(ctx context.Context, actor ActorContext, vendorFilter []string, limit int, cursor string) (DeadPage, error)

	// ListAttemptHistory returns a stable page of attempt history.
	ListAttemptHistory(ctx context.Context, actor ActorContext, id NotificationID, limit int, cursor string) (AttemptPage, error)
}
