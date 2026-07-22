// Package calleraccess defines the Caller Access trust boundary: API-key Bearer
// authentication, server-derived principal projections, scope attenuation and
// per-principal rate limiting.
//
// The package is database-agnostic; PostgreSQL details live in the postgres
// sub-package. Secrets (raw API keys, pepper values) never leave this boundary
// in logs, metrics, audit or responses (CTRL-016).
package calleraccess

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Rejection categories returned by Caller Access. They are stable values that
// the HTTP composition layer maps to public status codes.
const (
	RejectionUnauthenticated         = "unauthenticated"
	RejectionForbidden               = "forbidden"
	RejectionRateLimited             = "rate-limited"
	RejectionInvalidActorContext     = "invalid-actor-context"
	RejectionInvalidKeyFormat        = "invalid-key-format"
	RejectionActiveKeyLimit          = "active-key-limit"
	RejectionInvalidScope            = "invalid-scope"
	RejectionAuthorityUnavailable    = "authority-unavailable"
	RejectionPrincipalNotFound       = "principal-not-found"
	RejectionInvalidManagedPrincipal = "invalid-managed-principal"
	RejectionCommitRolledBack        = "commit-rolled-back"
	RejectionCommitOutcomeUnknown    = "commit-outcome-unknown"
)

// Principal kind values.
const (
	KindCaller   = "caller"
	KindOperator = "operator"
)

// Capability values used by Caller Access and attenuated downstream contexts.
const (
	CapabilitySubmitNotification = "submit_notification"
	CapabilityReadNotifications  = "read_notifications"
	CapabilityReplayPreview      = "replay_preview"
	CapabilityReplayExecute      = "replay_execute"
	CapabilityReplayBatch        = "replay_batch"
	CapabilityManageAccessKeys   = "manage_access_keys"
)

// Default configuration limits from the CDD.
const (
	DefaultMaxActiveKeysPerPrincipal     = 2
	DefaultCallerRatePerMinute           = 60
	DefaultOperatorReadRatePerMinute     = 60
	DefaultOperatorMutationRatePerMinute = 10
	DefaultRateLimitRetryAfterMax        = 60 * time.Second

	KeyIDLen     = 32 // bytes of randomness for key_id part
	KeySecretLen = 32 // bytes of randomness for secret part
)

var (
	keyIDRegex       = regexp.MustCompile(`^[A-Za-z0-9_-]{20,128}$`)
	idempotencyRegex = regexp.MustCompile(`^[A-Za-z0-9._-]{1,255}$`)
	principalIDRegex = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	scopeRegex       = regexp.MustCompile(`^[a-z0-9._-]{1,128}$`)
	vendorIDRegex    = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
)

// Rejection is a typed domain rejection.
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

// PrincipalRecord is the authoritative record for a principal.
type PrincipalRecord struct {
	PrincipalID           string
	Kind                  string
	Status                string
	VendorScope           []string
	OwningScope           string
	Capabilities          []string
	ManagedPrincipalScope []string
	Revision              int64
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

// IsActive reports whether the principal is active.
func (p PrincipalRecord) IsActive() bool { return p.Status == "active" }

// HasCapability reports whether the principal has the given capability.
func (p PrincipalRecord) HasCapability(c string) bool {
	for _, have := range p.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// CoversVendor reports whether the principal's vendor scope includes vendorID.
func (p PrincipalRecord) CoversVendor(vendorID string) bool {
	for _, v := range p.VendorScope {
		if v == vendorID {
			return true
		}
	}
	return false
}

// CoversManagedPrincipal reports whether the principal's managed scope includes
// the target principal. For operators, ManagedPrincipalScope is the set of
// principal IDs or owning scopes they may administer.
func (p PrincipalRecord) CoversManagedPrincipal(target PrincipalRecord) bool {
	if p.Kind != KindOperator || !p.HasCapability(CapabilityManageAccessKeys) {
		return false
	}
	for _, s := range p.ManagedPrincipalScope {
		if s == target.PrincipalID || s == target.OwningScope {
			return true
		}
	}
	return false
}

// AccessKeyRecord is the stored verifier for an API key.
type AccessKeyRecord struct {
	KeyID       string
	PrincipalID string
	SecretHash  []byte
	PepperID    string
	Status      string
	CreatedAt   time.Time
	ExpiresAt   *time.Time
	RevokedAt   *time.Time
}

// IsActive reports whether the key is active.
func (k AccessKeyRecord) IsActive() bool { return k.Status == "active" }

// CallerPrincipal is a server-derived projection for an authenticated caller.
type CallerPrincipal struct {
	PrincipalID  string // same as caller_id
	KeyID        string
	VendorScope  []string
	Capabilities []string
}

// HasCapability reports whether the caller has the given capability.
func (cp CallerPrincipal) HasCapability(c string) bool {
	for _, have := range cp.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// CoversVendor reports whether the caller's vendor scope includes vendorID.
func (cp CallerPrincipal) CoversVendor(vendorID string) bool {
	for _, v := range cp.VendorScope {
		if v == vendorID {
			return true
		}
	}
	return false
}

// OperatorPrincipal is a server-derived projection for an authenticated operator.
type OperatorPrincipal struct {
	PrincipalID           string // same as actor_id
	KeyID                 string
	VendorScope           []string
	OwningScope           string
	Capabilities          []string
	ManagedPrincipalScope []string
}

// HasCapability reports whether the operator has the given capability.
func (op OperatorPrincipal) HasCapability(c string) bool {
	for _, have := range op.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// AttenuatedContext is the narrow context passed to downstream modules.
// It never carries the full principal or raw key material.
type AttenuatedContext struct {
	Kind         string
	ActorID      string
	VendorScope  []string
	OwningScope  string
	Capabilities []string
}

// NewIngressContext attenuates a caller principal to the ingress context used
// by Vendor Registry and Notification Store.
func (cp CallerPrincipal) NewIngressContext() AttenuatedContext {
	return AttenuatedContext{
		Kind:         "ingress",
		ActorID:      cp.PrincipalID,
		VendorScope:  cp.VendorScope,
		Capabilities: []string{"vendor:read-active"},
	}
}

// NewStoreReadContext attenuates an operator principal to a Store read context.
func (op OperatorPrincipal) NewStoreReadContext(vendorFilter []string) (AttenuatedContext, bool) {
	scope, ok := attenuateScope(op.VendorScope, vendorFilter)
	if !ok {
		return AttenuatedContext{}, false
	}
	return AttenuatedContext{
		Kind:         "operator",
		ActorID:      op.PrincipalID,
		VendorScope:  scope,
		Capabilities: []string{"read_notifications"},
	}, true
}

// NewStoreReplayContext attenuates an operator principal to a Store replay context.
func (op OperatorPrincipal) NewStoreReplayContext() AttenuatedContext {
	return AttenuatedContext{
		Kind:         "operator",
		ActorID:      op.PrincipalID,
		VendorScope:  op.VendorScope,
		Capabilities: []string{"replay"},
	}
}

// NewVRAdminContext attenuates an operator principal to a Vendor Registry admin context.
func (op OperatorPrincipal) NewVRAdminContext() AttenuatedContext {
	return AttenuatedContext{
		Kind:        "operator",
		ActorID:     op.PrincipalID,
		VendorScope: op.VendorScope,
		OwningScope: op.OwningScope,
		Capabilities: filterCapabilities(op.Capabilities, []string{
			"vendor:register", "vendor:update", "vendor:activate", "vendor:disable",
			"vendor:rotate-credential-ref", "vendor:read", "vendor:read-history",
			"vendor:read-audit", "vendor:read-active", "vendor:snapshot-latest",
			"vendor:read-credential-locator",
		}),
	}
}

// Pepper provides the HMAC key generation for a pepper generation.
type Pepper interface {
	PepperID() string
	PepperValue() []byte
}

// PepperSet is the runtime loaded pepper generations.
type PepperSet interface {
	Active() Pepper
	Previous() Pepper
	Has(id string) bool
}

// Authenticator is the boundary service that authenticates raw API keys and
// performs authorization checks. It does not persist key lifecycle changes;
// that is the responsibility of the Repository.
type Authenticator struct {
	repo        Repository
	peppers     PepperSet
	rateLimiter *RateLimiter
}

// NewAuthenticator builds an Authenticator with the given repository and peppers.
func NewAuthenticator(repo Repository, peppers PepperSet) *Authenticator {
	return &Authenticator{
		repo:        repo,
		peppers:     peppers,
		rateLimiter: NewRateLimiter(DefaultCallerRatePerMinute, DefaultOperatorReadRatePerMinute, DefaultOperatorMutationRatePerMinute),
	}
}

// SetRateLimiter replaces the default rate limiter (used for tests/config).
func (a *Authenticator) SetRateLimiter(rl *RateLimiter) {
	a.rateLimiter = rl
}

// AuthenticateCaller parses a Bearer token, verifies the HMAC digest and returns
// a server-derived CallerPrincipal. The raw key never leaves this function.
func (a *Authenticator) AuthenticateCaller(ctx context.Context, bearer string) (CallerPrincipal, error) {
	keyID, secret, err := parseBearerKey(bearer)
	if err != nil {
		return CallerPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: err.Error()}
	}

	record, err := a.repo.GetKey(ctx, keyID)
	if err != nil {
		if IsRejection(err, RejectionAuthorityUnavailable) {
			return CallerPrincipal{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "key lookup failed"}
		}
		return CallerPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: "unknown or revoked key"}
	}

	if record.Status != "active" {
		return CallerPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: "unknown or revoked key"}
	}

	pepper := a.peppersForRecord(record)
	if pepper == nil {
		return CallerPrincipal{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "pepper generation unavailable"}
	}

	if !verifyKey(keyID, secret, record.SecretHash, pepper) {
		return CallerPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: "key digest mismatch"}
	}

	principal, err := a.repo.GetPrincipal(ctx, record.PrincipalID)
	if err != nil {
		return CallerPrincipal{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "principal lookup failed"}
	}
	if !principal.IsActive() || principal.Kind != KindCaller {
		return CallerPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: "principal inactive or wrong kind"}
	}

	return CallerPrincipal{
		PrincipalID:  principal.PrincipalID,
		KeyID:        record.KeyID,
		VendorScope:  principal.VendorScope,
		Capabilities: principal.Capabilities,
	}, nil
}

// AuthenticateOperator parses a Bearer token and returns an OperatorPrincipal.
func (a *Authenticator) AuthenticateOperator(ctx context.Context, bearer string) (OperatorPrincipal, error) {
	keyID, secret, err := parseBearerKey(bearer)
	if err != nil {
		return OperatorPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: err.Error()}
	}

	record, err := a.repo.GetKey(ctx, keyID)
	if err != nil {
		if IsRejection(err, RejectionAuthorityUnavailable) {
			return OperatorPrincipal{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "key lookup failed"}
		}
		return OperatorPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: "unknown or revoked key"}
	}

	if record.Status != "active" {
		return OperatorPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: "unknown or revoked key"}
	}

	pepper := a.peppersForRecord(record)
	if pepper == nil {
		return OperatorPrincipal{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "pepper generation unavailable"}
	}

	if !verifyKey(keyID, secret, record.SecretHash, pepper) {
		return OperatorPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: "key digest mismatch"}
	}

	principal, err := a.repo.GetPrincipal(ctx, record.PrincipalID)
	if err != nil {
		return OperatorPrincipal{}, Rejection{Category: RejectionAuthorityUnavailable, Reason: "principal lookup failed"}
	}
	if !principal.IsActive() || principal.Kind != KindOperator {
		return OperatorPrincipal{}, Rejection{Category: RejectionUnauthenticated, Reason: "principal inactive or wrong kind"}
	}

	return OperatorPrincipal{
		PrincipalID:           principal.PrincipalID,
		KeyID:                 record.KeyID,
		VendorScope:           principal.VendorScope,
		OwningScope:           principal.OwningScope,
		Capabilities:          principal.Capabilities,
		ManagedPrincipalScope: principal.ManagedPrincipalScope,
	}, nil
}

// AuthorizeVendor verifies that a caller principal may reference vendorID.
// It does not query the Vendor Registry; scope rejection returns the same shape
// as an inactive vendor (404 VendorUnavailable at the HTTP layer).
func (cp CallerPrincipal) AuthorizeVendor(vendorID string) error {
	if !vendorIDRegex.MatchString(vendorID) {
		return Rejection{Category: RejectionInvalidScope, Reason: "vendor_id format invalid"}
	}
	if !cp.CoversVendor(vendorID) {
		return Rejection{Category: RejectionInvalidScope, Reason: "vendor not in scope"}
	}
	return nil
}

// AuthorizeOperatorAction verifies that an operator principal may perform action.
func (op OperatorPrincipal) AuthorizeOperatorAction(action string) error {
	var required string
	switch action {
	case "read_notifications":
		required = CapabilityReadNotifications
	case "replay_preview":
		required = CapabilityReplayPreview
	case "replay_execute":
		required = CapabilityReplayExecute
	case "replay_batch":
		required = CapabilityReplayBatch
	case "manage_access_keys":
		required = CapabilityManageAccessKeys
	default:
		return Rejection{Category: RejectionForbidden, Reason: "unknown operator action"}
	}
	if !op.HasCapability(required) {
		return Rejection{Category: RejectionForbidden, Reason: "missing capability"}
	}
	return nil
}

// ApplyRateLimit checks the principal's operation bucket. For B3 the bucket is
// keyed by principal_id + operation class.
func (a *Authenticator) ApplyRateLimit(principalID string, opClass string) (RetryAfter time.Duration, err error) {
	if a.rateLimiter == nil {
		return 0, nil
	}
	allowed, retryAfter := a.rateLimiter.Allow(principalID, opClass)
	if !allowed {
		return retryAfter, Rejection{Category: RejectionRateLimited, Reason: fmt.Sprintf("retry after %s", retryAfter)}
	}
	return 0, nil
}

// peppersForRecord selects the pepper generation for the stored key.
func (a *Authenticator) peppersForRecord(record AccessKeyRecord) Pepper {
	if a.peppers.Active().PepperID() == record.PepperID {
		return a.peppers.Active()
	}
	if prev := a.peppers.Previous(); prev != nil && prev.PepperID() == record.PepperID {
		return prev
	}
	return nil
}

// parseBearerKey splits an Authorization: Bearer key_id.secret value.
func parseBearerKey(bearer string) (keyID, secret string, err error) {
	const prefix = "Bearer "
	if !strings.HasPrefix(bearer, prefix) {
		return "", "", errors.New("missing Bearer prefix")
	}
	bearer = strings.TrimSpace(bearer[len(prefix):])
	if bearer == "" {
		return "", "", errors.New("empty token")
	}
	parts := strings.SplitN(bearer, ".", 2)
	if len(parts) != 2 {
		return "", "", errors.New("token must be key_id.secret")
	}
	keyID, secret = parts[0], parts[1]
	if !keyIDRegex.MatchString(keyID) {
		return "", "", errors.New("key_id format invalid")
	}
	if len(secret) < 16 {
		return "", "", errors.New("secret too short")
	}
	return keyID, secret, nil
}

// digestKey returns the HMAC-SHA-256 digest of the full key under the pepper.
func digestKey(keyID, secret string, pepper Pepper) []byte {
	fullKey := keyID + "." + secret
	h := hmac.New(sha256.New, pepper.PepperValue())
	_, _ = h.Write([]byte(fullKey))
	return h.Sum(nil)
}

// verifyKey performs constant-time comparison of the provided key_id and secret digest.
func verifyKey(keyID, secret string, storedHash []byte, pepper Pepper) bool {
	if len(storedHash) == 0 {
		return false
	}
	computed := digestKey(keyID, secret, pepper)
	return subtle.ConstantTimeCompare(computed, storedHash) == 1
}

// keyIDFromHash is no longer used; the public key_id is always supplied by the
// caller via Authorization header parsing.

// GenerateKey creates a new raw API key and its digest under the active pepper.
// The raw key is returned once; only the digest is persisted.
func GenerateKey(pepper Pepper) (keyID, secret string, hash []byte, err error) {
	kid, err := randomBase64URL(KeyIDLen)
	if err != nil {
		return "", "", nil, err
	}
	s, err := randomBase64URL(KeySecretLen)
	if err != nil {
		return "", "", nil, err
	}
	return kid, s, digestKey(kid, s, pepper), nil
}

// attenuateScope returns the intersection of actor scope and an explicit filter.
func attenuateScope(scope []string, filter []string) ([]string, bool) {
	if len(filter) == 0 {
		return scope, true
	}
	allowed := make(map[string]struct{}, len(scope))
	for _, s := range scope {
		allowed[s] = struct{}{}
	}
	out := make([]string, 0, len(filter))
	for _, s := range filter {
		if _, ok := allowed[s]; !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

func filterCapabilities(have []string, allowlist []string) []string {
	m := make(map[string]struct{}, len(allowlist))
	for _, a := range allowlist {
		m[a] = struct{}{}
	}
	out := make([]string, 0, len(have))
	for _, c := range have {
		if _, ok := m[c]; ok {
			out = append(out, c)
		}
	}
	return out
}

// ValidatePrincipal validates a principal record for creation.
func ValidatePrincipal(p PrincipalRecord) error {
	if !principalIDRegex.MatchString(p.PrincipalID) {
		return Rejection{Category: RejectionInvalidActorContext, Reason: "principal_id format invalid"}
	}
	if p.Kind != KindCaller && p.Kind != KindOperator {
		return Rejection{Category: RejectionInvalidActorContext, Reason: "kind invalid"}
	}
	if len(p.VendorScope) == 0 || len(p.VendorScope) > 32 {
		return Rejection{Category: RejectionInvalidActorContext, Reason: "vendor_scope size invalid"}
	}
	for _, v := range p.VendorScope {
		if !vendorIDRegex.MatchString(v) {
			return Rejection{Category: RejectionInvalidActorContext, Reason: "vendor_scope member invalid"}
		}
	}
	if len(p.Capabilities) == 0 {
		return Rejection{Category: RejectionInvalidActorContext, Reason: "capabilities empty"}
	}
	if p.Kind == KindOperator {
		if len(p.ManagedPrincipalScope) == 0 || len(p.ManagedPrincipalScope) > 32 {
			return Rejection{Category: RejectionInvalidActorContext, Reason: "managed_principal_scope required for operator"}
		}
		for _, s := range p.ManagedPrincipalScope {
			if !scopeRegex.MatchString(s) {
				return Rejection{Category: RejectionInvalidActorContext, Reason: "managed_principal_scope member invalid"}
			}
		}
	}
	return nil
}

// KeyIssueResult is returned when a new key is issued.
type KeyIssueResult struct {
	KeyID       string
	RawKey      string // key_id.secret, shown only once
	PrincipalID string
	Status      string
	CreatedAt   time.Time
}

// KeyRevokeResult is returned when a key is revoked.
type KeyRevokeResult struct {
	KeyID       string
	PrincipalID string
	Status      string
	RevokedAt   time.Time
}

// Repository is the abstract persistence interface for Caller Access.
type Repository interface {
	// GetPrincipal returns a principal by id.
	GetPrincipal(ctx context.Context, principalID string) (PrincipalRecord, error)

	// GetKey returns an access key by public key_id.
	GetKey(ctx context.Context, keyID string) (AccessKeyRecord, error)

	// IssueKey creates a new active key with the given keyID, principal and hash.
	// The raw secret is known only to the caller; only the HMAC digest is persisted.
	IssueKey(ctx context.Context, keyID, principalID string, hash []byte, pepperID string) (KeyIssueResult, error)

	// RevokeKey marks a key as revoked.
	RevokeKey(ctx context.Context, keyID string) (KeyRevokeResult, error)

	// ListActiveKeys returns active keys for a principal.
	ListActiveKeys(ctx context.Context, principalID string) ([]AccessKeyRecord, error)

	// CountNonRevokedKeysForPepper returns the number of non-revoked keys with the pepper.
	CountNonRevokedKeysForPepper(ctx context.Context, pepperID string) (int64, error)

	// ListNonRevokedPepperIDs returns distinct pepper generations still needed
	// to authenticate a non-revoked key.
	ListNonRevokedPepperIDs(ctx context.Context) ([]string, error)

	// BulkRevokePepper revokes all keys with the given pepper_id in one transaction.
	BulkRevokePepper(ctx context.Context, pepperID string) (int64, error)

	// CreatePrincipal persists a new principal.
	CreatePrincipal(ctx context.Context, p PrincipalRecord) error
}

// pepperSet is a concrete PepperSet holding active and optional previous peppers.
type pepperSet struct {
	active   Pepper
	previous Pepper
}

// NewPepperSet builds a PepperSet from the active and optional previous pepper.
func NewPepperSet(active, previous Pepper) PepperSet {
	return &pepperSet{active: active, previous: previous}
}

func (ps *pepperSet) Active() Pepper   { return ps.active }
func (ps *pepperSet) Previous() Pepper { return ps.previous }
func (ps *pepperSet) Has(id string) bool {
	if ps.active != nil && ps.active.PepperID() == id {
		return true
	}
	if ps.previous != nil && ps.previous.PepperID() == id {
		return true
	}
	return false
}

// context import alias to avoid "imported and not used" in domain-only files.
var _ = context.Background
