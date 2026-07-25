package delivery

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"rc_wsman/internal/notificationstore"
	"rc_wsman/internal/vendorregistry"
)

// Runner orchestrates a single delivery attempt from claim to result commit.
// It is stateless and safe for concurrent use by multiple workers.
type Runner struct {
	cfg         Config
	store       notificationstore.Repository
	vr          VendorSnapshotReader
	credentials CredentialResolver
	dns         Resolver
	transport   HTTPTransport
	policy      *AddressPolicy
	clock       Clock
	rng         RNG
}

// VendorSnapshotReader is the minimal boundary the runner needs from the Vendor
// Registry.
type VendorSnapshotReader interface {
	Snapshot(ctx context.Context, actor vendorregistry.ActorContext, vendorID string, specificVersion *int64) (any, error)
}

// NewRunner builds a delivery runner. It validates the configuration and fails
// closed on misconfiguration.
func NewRunner(
	cfg Config,
	store notificationstore.Repository,
	vr VendorSnapshotReader,
	credentials CredentialResolver,
	dns Resolver,
	transport HTTPTransport,
	policy *AddressPolicy,
	clock Clock,
	rng RNG,
) (*Runner, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if store == nil || vr == nil || credentials == nil || dns == nil || transport == nil || policy == nil || clock == nil || rng == nil {
		return nil, fmt.Errorf("delivery runner: missing dependency")
	}
	return &Runner{
		cfg:         cfg,
		store:       store,
		vr:          vr,
		credentials: credentials,
		dns:         dns,
		transport:   transport,
		policy:      policy,
		clock:       clock,
		rng:         rng,
	}, nil
}

// RunOnce performs one full attempt. It returns (claimed, error). claimed is
// true when a notification was claimed and processed (successfully or not).
// Errors indicate an unexpected failure that the caller should report as a
// health event; the notification itself is left for lease recovery if needed.
func (r *Runner) RunOnce(ctx context.Context, storeCtx notificationstore.ActorContext) (bool, error) {
	claim, err := r.store.ClaimNext(ctx, storeCtx, nil, r.cfg.LeaseTTL)
	if err != nil {
		if err == notificationstore.ErrNoEligibleNotification {
			return false, nil
		}
		return false, newHealthSignal("store_claim_failure", err)
	}

	cycleSendCutoff := claim.DeliveryCycleStartedAt.Add(r.cfg.MaxAge).Add(-r.cfg.HTTPHardTimeout).Add(-r.cfg.ResultCommitMargin)
	now := r.clock.Now()

	if !now.Before(cycleSendCutoff) {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonDeadlineExceeded, nil)
	}
	if claim.AttemptCount >= r.cfg.MaxAttempts {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonAttemptLimit, nil)
	}

	vrCtx := vendorregistry.ActorContext{
		Kind:    vendorregistry.ActorKindDelivery,
		ActorID: storeCtx.ActorID,
		VendorScope: vendorregistry.VendorScope{
			Kind:      "vendor_ids",
			VendorIDs: []string{claim.VendorID},
		},
		Capabilities: []string{
			vendorregistry.CapabilitySnapshotLatest,
			vendorregistry.CapabilityReadCredentialLocator,
		},
	}

	rawSnapshot, err := r.vr.Snapshot(ctx, vrCtx, claim.VendorID, nil)
	if err != nil {
		if vendorregistry.IsReadError(err, vendorregistry.ReadErrVendorInactiveOrUnknown) {
			return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonVendorUnavailable, nil)
		}
		if vendorregistry.IsReadError(err, vendorregistry.ReadErrInvalidCommand) {
			transitionErr := r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonRequestUnbuildable, nil)
			if transitionErr != nil {
				return true, transitionErr
			}
			return true, newHealthSignal("registry_invalid_command", nil)
		}
		transitionErr := r.transitionRetry(ctx, storeCtx, claim, cycleSendCutoff, ErrorCodeRegistryAccessFailure, nil)
		if transitionErr != nil {
			return true, transitionErr
		}
		return true, newHealthSignal("registry_access_failure", err)
	}

	snapshot, ok := rawSnapshot.(vendorregistry.DeliveryConfigSnapshot)
	if !ok {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonRequestUnbuildable, nil)
	}
	configVersion := snapshot.ConfigVersion
	configVersionEvidence := &configVersion
	if snapshot.ResponsePolicy != vendorregistry.ResponsePolicyHTTPStatusV1 && snapshot.ResponsePolicy != vendorregistry.ResponsePolicyJSONAckV1 {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonRequestUnbuildable, configVersionEvidence)
	}

	var cred Credential
	switch snapshot.AuthStrategy {
	case "bearer":
		if snapshot.CredentialRef == nil {
			return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonCredentialUnavailable, configVersionEvidence)
		}
		cred, err = r.credentials.Resolve(ctx, *snapshot.CredentialRef)
		if err != nil {
			if _, ok := err.(*PolicyError); ok {
				return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonCredentialUnavailable, configVersionEvidence)
			}
			transitionErr := r.transitionRetry(ctx, storeCtx, claim, cycleSendCutoff, ErrorCodeRegistryAccessFailure, configVersionEvidence)
			if transitionErr != nil {
				return true, transitionErr
			}
			return true, newHealthSignal("credential_provider_failure", err)
		}
	case "none":
		if snapshot.ConfigSchemaVersion != 2 || snapshot.CredentialRef != nil {
			return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonRequestUnbuildable, configVersionEvidence)
		}
	default:
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonRequestUnbuildable, configVersionEvidence)
	}

	addrs, err := r.resolveAddresses(ctx, snapshot.Hostname)
	if err != nil {
		return true, r.transitionRetry(ctx, storeCtx, claim, cycleSendCutoff, ErrorCodeDNSFailure, configVersionEvidence)
	}

	exception, err := ToCIDRException(snapshot.CIDRException)
	if err != nil {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonRequestUnbuildable, configVersionEvidence)
	}

	resolvedIP, err := r.policy.Evaluate(snapshot.Hostname, snapshot.Port, addrs, exception)
	if err != nil {
		if _, ok := err.(*PolicyError); ok {
			return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonDestinationRejected, configVersionEvidence)
		}
		return true, r.transitionRetry(ctx, storeCtx, claim, cycleSendCutoff, ErrorCodeDNSFailure, configVersionEvidence)
	}

	attempt := AttemptContext{
		NotificationID:         claim.NotificationID,
		IngressIdempotencyKey:  claim.IngressIdempotencyKey,
		LeaseID:                claim.LeaseID,
		Version:                claim.Version,
		VendorID:               claim.VendorID,
		Payload:                claim.Payload,
		AttemptCount:           claim.AttemptCount,
		DeliveryCycleStartedAt: claim.DeliveryCycleStartedAt,
		CreatedAt:              claim.CreatedAt,
		LeaseExpiresAt:         claim.LeaseExpiresAt,
		ConfigVersion:          snapshot.ConfigVersion,
		ResolvedIP:             resolvedIP,
	}
	req, err := BuildRequest(attempt.NotificationID, attempt.IngressIdempotencyKey, attempt.Payload, snapshot, cred, attempt.ResolvedIP)
	if err != nil {
		if pe, ok := err.(*PolicyError); ok {
			reason := notificationstore.ReasonRequestUnbuildable
			if pe.Reason == ReasonCredentialUnavailable {
				reason = notificationstore.ReasonCredentialUnavailable
			}
			return true, r.transitionDie(ctx, storeCtx, claim, reason, configVersionEvidence)
		}
		return true, r.transitionRetry(ctx, storeCtx, claim, cycleSendCutoff, ErrorCodeRegistryAccessFailure, configVersionEvidence)
	}

	now = r.clock.Now()
	if !now.Before(cycleSendCutoff) {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonDeadlineExceeded, configVersionEvidence)
	}
	preflightCutoff := claim.LeaseExpiresAt.Add(-r.cfg.HTTPHardTimeout).Add(-r.cfg.ResultCommitMargin)
	if !now.Before(preflightCutoff) {
		return true, r.transitionRetry(ctx, storeCtx, claim, cycleSendCutoff, ErrorCodePreflightTimeout, configVersionEvidence)
	}

	httpReq, err := req.HTTPRequest()
	if err != nil {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonRequestUnbuildable, configVersionEvidence)
	}

	// Re-resolve immediately before connect. Any address-set drift or newly
	// forbidden address is treated as DNS rebinding and no request is sent.
	rechecked, err := r.resolveAddresses(ctx, snapshot.Hostname)
	if err != nil {
		return true, r.transitionRetry(ctx, storeCtx, claim, cycleSendCutoff, ErrorCodeDNSFailure, configVersionEvidence)
	}
	if !sameAddressSet(addrs, rechecked) {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonDestinationRejected, configVersionEvidence)
	}
	if _, err := r.policy.Evaluate(snapshot.Hostname, snapshot.Port, rechecked, exception); err != nil {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonDestinationRejected, configVersionEvidence)
	}
	// DNS is an external dependency and may consume the remaining send/lease
	// budget. Re-check both cutoffs after the second resolution so an unchanged
	// address set cannot be sent after its authorization window has expired.
	now = r.clock.Now()
	if !now.Before(cycleSendCutoff) {
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonDeadlineExceeded, configVersionEvidence)
	}
	if !now.Before(preflightCutoff) {
		return true, r.transitionRetry(ctx, storeCtx, claim, cycleSendCutoff, ErrorCodePreflightTimeout, configVersionEvidence)
	}

	// Once the request has been sent, process shutdown stops new claims but lets
	// this bounded attempt and its result commit finish.
	attemptCtx, cancelAttempt := context.WithTimeout(context.WithoutCancel(ctx), r.cfg.HTTPHardTimeout)
	resp, err := r.transport.Do(attemptCtx, httpReq, resolvedIP, r.cfg.HTTPHardTimeout, snapshot.ResponsePolicy)
	cancelAttempt()
	now = r.clock.Now()

	var outcome Outcome
	if err != nil {
		outcome = Classify(0, err, nil)
	} else {
		retryAfter := ParseRetryAfter(resp.Header.Get("Retry-After"), now)
		outcome = ClassifyResponse(snapshot.ResponsePolicy, resp, retryAfter)
	}

	outcome = ApplyB01Cutoff(outcome, now, cycleSendCutoff)
	commitCtx, cancelCommit := context.WithTimeout(context.WithoutCancel(ctx), r.cfg.ResultCommitMargin)
	defer cancelCommit()

	switch outcome.OutcomeClass {
	case notificationstore.OutcomeClassSuccess:
		return true, r.transitionSucceed(commitCtx, storeCtx, claim, outcome, configVersionEvidence)
	case notificationstore.OutcomeClassRetryableFailure:
		nextAt := NextAttemptTime(now, cycleSendCutoff, claim.AttemptCount, outcome.RetryAfter, r.cfg.RetryBaseDelay, r.cfg.RetryDelayCap, r.cfg.RetryAfterCap, r.rng)
		if nextAt == nil {
			outcome.OutcomeClass = notificationstore.OutcomeClassPermanentFailure
			outcome.Reason = notificationstore.ReasonDeadlineExceeded
			return true, r.transition(commitCtx, storeCtx, claim, notificationstore.TransitionDie, outcome, nil, configVersionEvidence)
		}
		return true, r.transitionRetryAt(commitCtx, storeCtx, claim, outcome, *nextAt, configVersionEvidence)
	case notificationstore.OutcomeClassPermanentFailure:
		return true, r.transition(commitCtx, storeCtx, claim, notificationstore.TransitionDie, outcome, nil, configVersionEvidence)
	default:
		return true, r.transitionDie(ctx, storeCtx, claim, notificationstore.ReasonRequestUnbuildable, configVersionEvidence)
	}
}

func (r *Runner) resolveAddresses(ctx context.Context, hostname string) ([]netip.Addr, error) {
	return r.dns.ResolveAll(ctx, hostname)
}

func sameAddressSet(a, b []netip.Addr) bool {
	if len(a) != len(b) {
		return false
	}
	counts := make(map[netip.Addr]int, len(a))
	for _, addr := range a {
		counts[addr]++
	}
	for _, addr := range b {
		if counts[addr] == 0 {
			return false
		}
		counts[addr]--
	}
	return true
}

func (r *Runner) transitionSucceed(ctx context.Context, actor notificationstore.ActorContext, claim notificationstore.LeaseClaim, outcome Outcome, configVersion *int64) error {
	return r.transition(ctx, actor, claim, notificationstore.TransitionSucceed, outcome, nil, configVersion)
}

func (r *Runner) transitionRetry(ctx context.Context, actor notificationstore.ActorContext, claim notificationstore.LeaseClaim, cycleSendCutoff time.Time, errorCode string, configVersion *int64) error {
	outcome := Outcome{
		ResultKind:   notificationstore.ResultKindTransportFailure,
		OutcomeClass: notificationstore.OutcomeClassRetryableFailure,
		ErrorCode:    errorCode,
	}
	nextAt := NextAttemptTime(r.clock.Now(), cycleSendCutoff, claim.AttemptCount, nil, r.cfg.RetryBaseDelay, r.cfg.RetryDelayCap, r.cfg.RetryAfterCap, r.rng)
	if nextAt == nil {
		outcome.OutcomeClass = notificationstore.OutcomeClassPermanentFailure
		outcome.Reason = notificationstore.ReasonDeadlineExceeded
		return r.transition(ctx, actor, claim, notificationstore.TransitionDie, outcome, nil, configVersion)
	}
	return r.transition(ctx, actor, claim, notificationstore.TransitionRetry, outcome, nextAt, configVersion)
}

func (r *Runner) transitionRetryAt(ctx context.Context, actor notificationstore.ActorContext, claim notificationstore.LeaseClaim, outcome Outcome, nextAt time.Time, configVersion *int64) error {
	return r.transition(ctx, actor, claim, notificationstore.TransitionRetry, outcome, &nextAt, configVersion)
}

func (r *Runner) transitionDie(ctx context.Context, actor notificationstore.ActorContext, claim notificationstore.LeaseClaim, reason string, configVersion *int64) error {
	outcome := Outcome{
		ResultKind:   notificationstore.ResultKindPolicyTermination,
		OutcomeClass: notificationstore.OutcomeClassPermanentFailure,
		Reason:       reason,
	}
	return r.transition(ctx, actor, claim, notificationstore.TransitionDie, outcome, nil, configVersion)
}

func (r *Runner) transition(ctx context.Context, actor notificationstore.ActorContext, claim notificationstore.LeaseClaim, transition notificationstore.Transition, outcome Outcome, nextAt *time.Time, configVersion *int64) error {
	outcome.ConfigVersion = configVersion
	dr := outcome.ToDeliveryResult()
	req := notificationstore.TransitionRequest{
		NotificationID:      claim.NotificationID,
		ExpectedState:       notificationstore.StateInFlight,
		ExpectedVersion:     claim.Version,
		LeaseID:             claim.LeaseID,
		RequestedTransition: transition,
		DeliveryResult:      &dr,
		NextAttemptAt:       nextAt,
	}
	_, err := r.store.Transition(ctx, actor, req)
	if err != nil {
		if notificationstore.IsRejection(err, notificationstore.RejectionExpiredLease) ||
			notificationstore.IsRejection(err, notificationstore.RejectionStaleVersion) ||
			notificationstore.IsRejection(err, notificationstore.RejectionInvalidLease) {
			return nil
		}
		return newHealthSignal("store_result_commit_failure", err)
	}
	return nil
}

// IsCredentialError reports whether a policy error is credential-related.
func IsCredentialError(err error) bool {
	var pe *PolicyError
	if errors.As(err, &pe) {
		return pe.Reason == ReasonCredentialUnavailable
	}
	return false
}

// OutcomeHTTPResponse returns a minimal successful outcome for a status code.
func OutcomeHTTPResponse(status int) Outcome {
	return Classify(status, nil, nil)
}
