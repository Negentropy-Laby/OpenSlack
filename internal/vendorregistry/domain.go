// Package vendorregistry is the single authority for vendor existence, lifecycle
// and endpoint configuration. It owns vendors, endpoint_versions,
// admin_command_receipts and admin_audit_events.
package vendorregistry

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Lifecycle values.
const (
	LifecycleDraft    = "draft"
	LifecycleActive   = "active"
	LifecycleDisabled = "disabled"
)

// Response policies define how Delivery interprets a vendor response. Schema
// v1 is permanently bound to HTTP status semantics; schema v2 may opt into a
// bounded JSON acknowledgement policy.
const (
	ResponsePolicyHTTPStatusV1 = "http_status_v1"
	ResponsePolicyJSONAckV1    = "json_ack_v1"
)

// Actor kinds.
const (
	ActorKindIngress  = "ingress"
	ActorKindDelivery = "delivery"
	ActorKindOperator = "operator"
	ActorKindAuditor  = "auditor"
	ActorKindSystem   = "system"
)

// Capability values.
const (
	CapabilityReadActive            = "vendor:read-active"
	CapabilitySnapshotLatest        = "vendor:snapshot-latest"
	CapabilityReadCredentialLocator = "vendor:read-credential-locator"
	CapabilityReadHistory           = "vendor:read-history"
	CapabilityRead                  = "vendor:read"
	CapabilityReadAudit             = "vendor:read-audit"
	CapabilityRegister              = "vendor:register"
	CapabilityUpdate                = "vendor:update"
	CapabilityActivate              = "vendor:activate"
	CapabilityDisable               = "vendor:disable"
	CapabilityRotateCredentialRef   = "vendor:rotate-credential-ref"
)

// Operation names.
const (
	OpRegister            = "register"
	OpUpdateVersion       = "update_version"
	OpActivate            = "activate"
	OpDisable             = "disable"
	OpRotateCredentialRef = "rotate_credential_ref"
)

// Admin command error codes.
const (
	ErrInvalidActorContext           = "INVALID_ACTOR_CONTEXT"
	ErrInvalidCommand                = "INVALID_COMMAND"
	ErrInvalidEndpointPolicy         = "INVALID_ENDPOINT_POLICY"
	ErrInvalidCredentialRef          = "INVALID_CREDENTIAL_REF"
	ErrForbidden                     = "FORBIDDEN"
	ErrVendorNotFound                = "VENDOR_NOT_FOUND"
	ErrVendorIDUnavailable           = "VENDOR_ID_UNAVAILABLE"
	ErrExpectedVersionMismatch       = "EXPECTED_VERSION_MISMATCH"
	ErrInvalidTransition             = "INVALID_TRANSITION"
	ErrVendorDisabledUpdateForbidden = "VENDOR_DISABLED_UPDATE_FORBIDDEN"
	ErrIdempotencyConflict           = "IDEMPOTENCY_CONFLICT"
	ErrCommitRolledBack              = "COMMIT_ROLLED_BACK"
	ErrCommitOutcomeUnknown          = "COMMIT_OUTCOME_UNKNOWN"
)

// Read error codes.
const (
	ReadErrInvalidActorContext     = "INVALID_ACTOR_CONTEXT"
	ReadErrInvalidCommand          = "INVALID_COMMAND"
	ReadErrInvalidCursor           = "INVALID_CURSOR"
	ReadErrInvalidPageLimit        = "INVALID_PAGE_LIMIT"
	ReadErrForbidden               = "FORBIDDEN"
	ReadErrForbiddenScopeFilter    = "FORBIDDEN_SCOPE_FILTER"
	ReadErrVendorNotFound          = "VENDOR_NOT_FOUND"
	ReadErrVendorInactiveOrUnknown = "VENDOR_INACTIVE_OR_UNKNOWN"
	ReadErrVersionNotFound         = "VERSION_NOT_FOUND"
)

// Default configuration limits.
const (
	DefaultListPageDefault = 50
	DefaultListPageMax     = 200
	DefaultMaxBodyBytes    = 262144
)

var (
	vendorIDRegex         = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
	owningScopeRegex      = regexp.MustCompile(`^[a-z0-9._-]{1,128}$`)
	idempotencyKeyRegex   = regexp.MustCompile(`^[A-Za-z0-9._-]{1,255}$`)
	headerNameRegex       = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$")
	bodyFieldRegex        = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
	credentialHandleRegex = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)
	disableReasonRegex    = regexp.MustCompile(`^.+$`)
	methods               = map[string]struct{}{"POST": {}, "PUT": {}, "PATCH": {}}
	authStrategies        = map[string]struct{}{"bearer": {}}
	transportKinds        = map[string]struct{}{"https_public": {}, "https_private": {}}
)

// ActorContext is the attenuated identity passed into Vendor Registry.
type ActorContext struct {
	Kind         string
	ActorID      string
	VendorScope  VendorScope
	Capabilities []string
}

// HasCapability reports whether the actor has the given capability.
func (a ActorContext) HasCapability(c string) bool {
	for _, have := range a.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// VendorScope describes the actor's vendor authorization.
type VendorScope struct {
	Kind         string
	VendorIDs    []string
	OwningScopes []string
}

// IsEmpty reports whether the scope is empty.
func (s VendorScope) IsEmpty() bool { return s.Kind == "" }

// CoversVendorID reports whether vendorIDs scope includes id.
func (s VendorScope) CoversVendorID(id string) bool {
	if s.Kind != "vendor_ids" {
		return false
	}
	for _, v := range s.VendorIDs {
		if v == id {
			return true
		}
	}
	return false
}

// CoversOwningScope reports whether owning_scopes scope includes scope.
func (s VendorScope) CoversOwningScope(scope string) bool {
	if s.Kind != "owning_scopes" {
		return false
	}
	for _, o := range s.OwningScopes {
		if o == scope {
			return true
		}
	}
	return false
}

// AdminCommandError is a closed domain error for write operations.
type AdminCommandError struct {
	Code string
	Err  error
}

func (e AdminCommandError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Code, e.Err)
	}
	return e.Code
}

// ReadError is a closed domain error for read operations.
type ReadError struct {
	Code string
	Err  error
}

func (e ReadError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Code, e.Err)
	}
	return e.Code
}

// IsAdminCommandError reports whether err is an AdminCommandError with code.
func IsAdminCommandError(err error, code string) bool {
	var e AdminCommandError
	if errors.As(err, &e) {
		return e.Code == code
	}
	return false
}

// IsReadError reports whether err is a ReadError with code.
func IsReadError(err error, code string) bool {
	var e ReadError
	if errors.As(err, &e) {
		return e.Code == code
	}
	return false
}

// VendorRecord is the mutable aggregate root.
type VendorRecord struct {
	VendorID             string
	OwningScope          string
	Lifecycle            string
	RecordRevision       int64
	CurrentConfigVersion int64
	CreatedAt            time.Time
	ActivatedAt          *time.Time
	DisabledAt           *time.Time
	DisabledReason       string
}

// EndpointVersion is the append-only immutable configuration.
type EndpointVersion struct {
	VendorID                   string
	ConfigVersion              int64
	ConfigSchemaVersion        int64
	CanonicalURL               string
	Method                     string
	Hostname                   string
	Port                       int
	TransportKind              string
	CIDRException              *CIDRException
	TransportAuthHeaders       []HeaderRule
	OutboundIdempotencyMapping OutboundIdempotencyMapping
	EndpointPolicy             EndpointPolicy
	AuthStrategy               string
	ResponsePolicy             string
	CredentialRef              *CredentialRef
	CreatedByActor             string
	CreatedAt                  time.Time
}

// CIDRException is the private network exception tuple.
type CIDRException struct {
	Hostname string
	Port     int
	CIDR     string
}

// HeaderRule is a transport auth header rule.
type HeaderRule struct {
	Kind            string
	Name            string
	Value           string
	CredentialField string
}

// OutboundIdempotencyMapping is the outbound idempotency mode.
type OutboundIdempotencyMapping struct {
	Mode        string
	Source      string `json:"source,omitempty"`
	HeaderName  string
	HeaderNames []string `json:"header_names,omitempty"`
	FieldName   string
}

// EndpointPolicy is the per-vendor policy.
type EndpointPolicy struct {
	AllowedRequestHeaderNames   []string
	ForbiddenRequestHeaderNames []string
	MaxRequestBodyBytes         int64
	CIDRException               *CIDRException `json:"cidr_exception,omitempty"`
}

// CredentialRef is the opaque credential reference.
type CredentialRef struct {
	Scheme           string
	OpaqueHandle     string
	ReferenceVersion string
}

// CredentialDescriptor is the non-sensitive credential projection.
type CredentialDescriptor struct {
	Scheme           string `json:"scheme"`
	ReferenceVersion string `json:"reference_version,omitempty"`
}

// AdminCommandReceipt is the immutable idempotency receipt.
type AdminCommandReceipt struct {
	ReceiptID          string
	ActorID            string
	IdempotencyKey     string
	CommandFingerprint []byte
	Operation          string
	VendorID           string
	SafeResult         AdminResult
	RecordedAt         time.Time
}

// AdminResult is the sanitized success result.
type AdminResult struct {
	Operation            string `json:"operation"`
	VendorID             string `json:"vendor_id"`
	Lifecycle            string `json:"lifecycle"`
	RecordRevision       int64  `json:"record_revision"`
	CurrentConfigVersion int64  `json:"current_config_version"`
}

// AdminAuditEvent is the sanitized audit trail.
type AdminAuditEvent struct {
	EventID                      string
	AuditSeq                     int64
	VendorID                     string
	OwningScope                  string
	ActorID                      string
	AuthorizationBasis           string
	Operation                    string
	Outcome                      string
	ExpectedRecordRevisionBefore *int64
	RecordRevisionAfter          *int64
	SanitizedRequestDigest       string
	ReceiptID                    string
	RejectReason                 string
	OccurredAt                   time.Time
}

// DeliveryConfigSnapshot is the full snapshot for Delivery.
type DeliveryConfigSnapshot struct {
	ProjectionSchema           string
	VendorID                   string
	ConfigVersion              int64
	ConfigSchemaVersion        int64
	CanonicalURL               string
	Method                     string
	Hostname                   string
	Port                       int
	TransportKind              string
	CIDRException              *CIDRException
	TransportAuthHeaders       []HeaderRule
	OutboundIdempotencyMapping OutboundIdempotencyMapping
	EndpointPolicy             EndpointPolicy
	AuthStrategy               string
	ResponsePolicy             string
	CredentialRef              *CredentialRef
}

// HistoricalConfigSnapshot is the history read without opaque credential locator.
type HistoricalConfigSnapshot struct {
	ProjectionSchema           string
	VendorID                   string
	ConfigVersion              int64
	ConfigSchemaVersion        int64
	CanonicalURL               string
	Method                     string
	Hostname                   string
	Port                       int
	TransportKind              string
	CIDRException              *CIDRException
	TransportAuthHeaders       []HeaderRule
	OutboundIdempotencyMapping OutboundIdempotencyMapping
	EndpointPolicy             EndpointPolicy
	AuthStrategy               string
	ResponsePolicy             string
	CredentialDescriptor       *CredentialDescriptor
}

// VendorListItem is a list projection.
type VendorListItem struct {
	VendorID             string    `json:"vendor_id"`
	Lifecycle            string    `json:"lifecycle"`
	OwningScope          string    `json:"owning_scope"`
	RecordRevision       int64     `json:"record_revision"`
	CurrentConfigVersion int64     `json:"current_config_version"`
	CreatedAt            time.Time `json:"created_at"`
}

// EndpointVersionListItem is a historical endpoint projection.
type EndpointVersionListItem struct {
	VendorID             string                `json:"vendor_id"`
	ConfigVersion        int64                 `json:"config_version"`
	ConfigSchemaVersion  int64                 `json:"config_schema_version"`
	CanonicalURL         string                `json:"canonical_url"`
	Method               string                `json:"method"`
	TransportKind        string                `json:"transport_kind"`
	AuthStrategy         string                `json:"auth_strategy"`
	CredentialDescriptor *CredentialDescriptor `json:"credential_descriptor,omitempty"`
	CreatedAt            time.Time             `json:"created_at"`
	CreatedByActor       string                `json:"created_by_actor"`
}

// AdminAuditListItem is an audit list projection.
type AdminAuditListItem struct {
	EventID                      string    `json:"event_id"`
	AuditSeq                     int64     `json:"audit_seq"`
	VendorID                     string    `json:"vendor_id"`
	ActorID                      string    `json:"actor_id"`
	AuthorizationBasis           string    `json:"authorization_basis"`
	Operation                    string    `json:"operation"`
	Outcome                      string    `json:"outcome"`
	ExpectedRecordRevisionBefore *int64    `json:"expected_record_revision_before,omitempty"`
	RecordRevisionAfter          *int64    `json:"record_revision_after,omitempty"`
	SanitizedRequestDigest       string    `json:"sanitized_request_digest"`
	ReceiptID                    string    `json:"receipt_id,omitempty"`
	RejectReason                 string    `json:"reject_reason,omitempty"`
	OccurredAt                   time.Time `json:"occurred_at"`
}

// VendorStateSummary is a privileged summary projection.
type VendorStateSummary struct {
	VendorID             string     `json:"vendor_id"`
	Lifecycle            string     `json:"lifecycle"`
	OwningScope          string     `json:"owning_scope"`
	RecordRevision       int64      `json:"record_revision"`
	CurrentConfigVersion int64      `json:"current_config_version"`
	ConfigVersionCount   int64      `json:"config_version_count"`
	AuditEventCount      int64      `json:"audit_event_count"`
	CreatedAt            time.Time  `json:"created_at"`
	ActivatedAt          *time.Time `json:"activated_at,omitempty"`
	DisabledAt           *time.Time `json:"disabled_at,omitempty"`
	DisabledReason       string     `json:"disabled_reason,omitempty"`
}

// Page models a cursor-bounded page.
type Page[T any] struct {
	Items          []T
	NextCursor     string
	SnapshotMaxSeq *int64
}

// Config holds the configured allowlists and validators.
type Config struct {
	EndpointPortAllowlist          map[int]struct{}
	EndpointMethodAllowlist        map[string]struct{}
	CredentialRefSchemeAllowlist   map[string]struct{}
	CredentialProfileValidator     string
	StaticHeaderNameAllowlist      map[string]struct{}
	ForbiddenCIDRExceptionRanges   []string
	MinCIDRExceptionPrefixLengthV4 int
	MinCIDRExceptionPrefixLengthV6 int
	DefaultMaxRequestBodyBytes     int64
	ListPageDefault                int
	ListPageMax                    int
}

// DefaultConfig returns a sensible MVP default configuration.
func DefaultConfig() Config {
	return Config{
		EndpointPortAllowlist:        map[int]struct{}{443: {}},
		EndpointMethodAllowlist:      map[string]struct{}{"POST": {}},
		CredentialRefSchemeAllowlist: map[string]struct{}{"env": {}},
		CredentialProfileValidator:   "bearer-env-v1",
		StaticHeaderNameAllowlist:    map[string]struct{}{"accept": {}, "content-type": {}, "user-agent": {}},
		ForbiddenCIDRExceptionRanges: []string{
			"0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "192.0.0.0/24",
			"192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
			"224.0.0.0/4", "240.0.0.0/4", "::/128", "::1/128", "100::/64",
			"2001:2::/48", "2001:db8::/32", "fe80::/10", "ff00::/8",
		},
		MinCIDRExceptionPrefixLengthV4: 8,
		MinCIDRExceptionPrefixLengthV6: 48,
		DefaultMaxRequestBodyBytes:     262144,
		ListPageDefault:                50,
		ListPageMax:                    200,
	}
}

// Validate checks one immutable Vendor Registry configuration generation. The
// composition root calls it before serving traffic; endpoint validation calls
// it again so tests and alternate compositions also fail closed.
func (c Config) Validate() error {
	if len(c.EndpointPortAllowlist) == 0 || len(c.EndpointMethodAllowlist) == 0 || len(c.CredentialRefSchemeAllowlist) == 0 || c.CredentialProfileValidator == "" || len(c.StaticHeaderNameAllowlist) == 0 {
		return errors.New("required allowlist is empty")
	}
	if c.CredentialProfileValidator != "bearer-env-v1" {
		return errors.New("unsupported credential profile validator")
	}
	for port := range c.EndpointPortAllowlist {
		if port < 1 || port > 65535 {
			return fmt.Errorf("invalid endpoint port %d", port)
		}
	}
	for method := range c.EndpointMethodAllowlist {
		if _, ok := methods[method]; !ok {
			return fmt.Errorf("invalid endpoint method %q", method)
		}
	}
	for scheme := range c.CredentialRefSchemeAllowlist {
		if strings.TrimSpace(scheme) == "" {
			return errors.New("credential scheme is empty")
		}
	}
	for name := range c.StaticHeaderNameAllowlist {
		if name != strings.ToLower(name) || !headerNameRegex.MatchString(name) || isAuthenticationHeader(name) {
			return fmt.Errorf("invalid static header allowlist member %q", name)
		}
	}
	if c.MinCIDRExceptionPrefixLengthV4 < 0 || c.MinCIDRExceptionPrefixLengthV4 > 32 || c.MinCIDRExceptionPrefixLengthV6 < 0 || c.MinCIDRExceptionPrefixLengthV6 > 128 {
		return errors.New("CIDR exception prefix configuration invalid")
	}
	for _, cidr := range c.ForbiddenCIDRExceptionRanges {
		ip, network, err := net.ParseCIDR(cidr)
		if err != nil || !ip.Equal(ip.Mask(network.Mask)) {
			return fmt.Errorf("invalid forbidden CIDR %q", cidr)
		}
	}
	if c.DefaultMaxRequestBodyBytes < 1 || c.DefaultMaxRequestBodyBytes > DefaultMaxBodyBytes {
		return errors.New("default body budget invalid")
	}
	if c.ListPageDefault < 1 || c.ListPageMax < c.ListPageDefault || c.ListPageMax > 200 {
		return errors.New("list page configuration invalid")
	}
	return nil
}

func isAuthenticationHeader(name string) bool {
	switch strings.ToLower(name) {
	case "authorization", "proxy-authorization", "cookie", "set-cookie":
		return true
	default:
		return false
	}
}

// Repository is the abstract persistence interface for Vendor Registry.
type Repository interface {
	// RegisterVendor creates a new vendor with an initial endpoint version.
	RegisterVendor(ctx context.Context, vendor VendorRecord, version EndpointVersion, receipt AdminCommandReceipt, audit AdminAuditEvent) error

	// UpdateVersion appends a new endpoint version and updates the vendor pointer.
	UpdateVersion(ctx context.Context, vendorID string, expectedRevision int64, version EndpointVersion, receipt AdminCommandReceipt, audit AdminAuditEvent) error

	// Activate transitions draft to active.
	Activate(ctx context.Context, vendorID string, expectedRevision int64, receipt AdminCommandReceipt, audit AdminAuditEvent) error

	// Disable transitions to disabled.
	Disable(ctx context.Context, vendorID string, expectedRevision int64, reason string, receipt AdminCommandReceipt, audit AdminAuditEvent) error

	// RotateCredentialRef appends a new endpoint version with a new credential ref.
	RotateCredentialRef(ctx context.Context, vendorID string, expectedRevision int64, version EndpointVersion, receipt AdminCommandReceipt, audit AdminAuditEvent) error

	// GetVendor returns the vendor record.
	GetVendor(ctx context.Context, vendorID string) (VendorRecord, error)

	// GetEndpointVersion returns a specific endpoint version.
	GetEndpointVersion(ctx context.Context, vendorID string, configVersion int64) (EndpointVersion, error)

	// FindReceipt returns an existing receipt by actor+idempotency key.
	FindReceipt(ctx context.Context, actorID, idempotencyKey string) (AdminCommandReceipt, error)

	// ListVendors returns an authorized vendor page.
	ListVendors(ctx context.Context, filter ScopeFilter, cursor string, limit int) (Page[VendorListItem], error)

	// ListEndpointVersions returns a historical version page.
	ListEndpointVersions(ctx context.Context, vendorID string, cursor string, limit int) (Page[EndpointVersionListItem], int64, error)

	// ListAdminAuditEvents returns an audit page.
	ListAdminAuditEvents(ctx context.Context, filter ScopeFilter, cursor string, limit int) (Page[AdminAuditListItem], error)

	// DescribeVendorState returns a summary.
	DescribeVendorState(ctx context.Context, vendorID string) (VendorStateSummary, error)

	// InsertAuditEvent persists a rejected audit event.
	InsertAuditEvent(ctx context.Context, audit AdminAuditEvent) error

	// CountEndpointVersions returns the total number of endpoint versions.
	CountEndpointVersions(ctx context.Context, vendorID string) (int64, error)

	// CountAuditEvents returns the total number of audit events.
	CountAuditEvents(ctx context.Context, vendorID string) (int64, error)

	// ListActiveEndpointVersions supports fail-closed configuration generation
	// preflight. It returns only each active vendor's current immutable version.
	ListActiveEndpointVersions(ctx context.Context) ([]EndpointVersion, error)
}

// ScopeFilter is a client-supplied attenuation of the actor scope.
type ScopeFilter struct {
	Kind         string
	VendorIDs    []string
	OwningScopes []string
}

// ValidateAdminCommand performs schema-level validation of an AdminCommand.
func ValidateAdminCommand(op, vendorID string, expectedRevision int64, idempotencyKey string, body map[string]any) error {
	allowedBodyKeys := map[string][]string{
		OpRegister:            {"owning_scope", "initial_config"},
		OpUpdateVersion:       {"replacement_policy"},
		OpActivate:            {},
		OpDisable:             {"reason"},
		OpRotateCredentialRef: {"new_credential_ref"},
	}
	allowed, validOperation := allowedBodyKeys[op]
	if !validOperation {
		return AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("unknown operation")}
	}
	if !vendorIDRegex.MatchString(vendorID) {
		return AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("vendor_id invalid")}
	}
	if !idempotencyKeyRegex.MatchString(idempotencyKey) {
		return AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("idempotency_key invalid")}
	}
	if op == OpRegister && expectedRevision != 0 {
		return AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("register requires expected_record_revision=0")}
	}
	if op != OpRegister && expectedRevision < 1 {
		return AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("expected_record_revision must be >=1")}
	}
	if len(body) != len(allowed) {
		return AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("body does not match closed operation schema")}
	}
	for _, key := range allowed {
		if _, ok := body[key]; !ok {
			return AdminCommandError{Code: "INVALID_COMMAND", Err: fmt.Errorf("missing body field %s", key)}
		}
	}
	for key := range body {
		found := false
		for _, allowedKey := range allowed {
			if key == allowedKey {
				found = true
				break
			}
		}
		if !found {
			return AdminCommandError{Code: "INVALID_COMMAND", Err: fmt.Errorf("unknown body field %s", key)}
		}
	}
	return nil
}

// ComputeFingerprint returns a stable HMAC-SHA-256 fingerprint of the command.
func ComputeFingerprint(secret []byte, op, vendorID string, expectedRevision int64, body map[string]any) []byte {
	canonical, _ := json.Marshal(body)
	h := hmac.New(sha256.New, secret)
	_, _ = h.Write([]byte(fmt.Sprintf("%s|%s|%d|%s", op, vendorID, expectedRevision, canonical)))
	return h.Sum(nil)
}

// VerifyFingerprint compares command fingerprints in constant time.
func VerifyFingerprint(a, b []byte) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

// NormalizeURL parses and validates an endpoint URL.
func NormalizeURL(raw string) (canonicalURL, hostname string, port int, err error) {
	if len(raw) == 0 || len(raw) > 2048 {
		return "", "", 0, errors.New("url length invalid")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", 0, err
	}
	if u.Scheme != "https" {
		return "", "", 0, errors.New("scheme must be https")
	}
	if u.User != nil {
		return "", "", 0, errors.New("url must not contain userinfo")
	}
	if u.Fragment != "" {
		return "", "", 0, errors.New("url must not contain fragment")
	}
	if strings.Contains(u.Host, "\x00") || strings.Contains(u.Path, "\x00") || strings.Contains(raw, "\r") || strings.Contains(raw, "\n") {
		return "", "", 0, errors.New("url contains illegal characters")
	}
	hostname = strings.ToLower(u.Hostname())
	if hostname == "" || hostname == "*" || strings.HasPrefix(hostname, "*.") || net.ParseIP(hostname) != nil {
		return "", "", 0, errors.New("hostname must be an ASCII FQDN")
	}
	if !isASCII(hostname) || !validFQDN(hostname) {
		return "", "", 0, errors.New("hostname must be ASCII")
	}
	portStr := u.Port()
	if portStr == "" {
		port = 443
	} else {
		port, err = strconv.Atoi(portStr)
		if err != nil || port < 1 || port > 65535 {
			return "", "", 0, errors.New("port invalid")
		}
	}
	u.Host = hostname
	if portStr != "" {
		u.Host = net.JoinHostPort(hostname, portStr)
	}
	canonicalURL = u.String()
	return canonicalURL, hostname, port, nil
}

func validFQDN(hostname string) bool {
	if len(hostname) > 253 || strings.HasSuffix(hostname, ".") || !strings.Contains(hostname, ".") {
		return false
	}
	for _, label := range strings.Split(hostname, ".") {
		if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range []byte(label) {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return false
			}
		}
	}
	return true
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] > 127 {
			return false
		}
	}
	return true
}

// ValidateEndpointConfig validates a full endpoint configuration.
func ValidateEndpointConfig(cfg Config, ep EndpointConfigInput) (EndpointVersion, error) {
	version := EndpointVersion{}
	if ep.TransportAuthHeaders == nil || ep.EndpointPolicy.AllowedRequestHeaderNames == nil || ep.EndpointPolicy.ForbiddenRequestHeaderNames == nil {
		return version, AdminCommandError{Code: "INVALID_COMMAND", Err: errors.New("missing required endpoint configuration field")}
	}
	if err := cfg.Validate(); err != nil {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("endpoint validator configuration invalid: %w", err)}
	}
	canonicalURL, hostname, port, err := NormalizeURL(ep.EndpointTarget.URL)
	if err != nil {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: err}
	}
	if _, ok := cfg.EndpointPortAllowlist[port]; !ok {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("port %d not allowed", port)}
	}
	if _, ok := cfg.EndpointMethodAllowlist[ep.Method]; !ok {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("method %s not allowed", ep.Method)}
	}
	if _, ok := authStrategies[ep.AuthStrategy]; !ok {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("auth strategy %s not allowed", ep.AuthStrategy)}
	}
	transportKind := "https_public"
	var cidrException *CIDRException
	if ep.EndpointTarget.PrivateNetworkException != nil {
		exc := ep.EndpointTarget.PrivateNetworkException
		if exc.Hostname != hostname || exc.Port != port {
			return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: errors.New("private network exception authority mismatch")}
		}
		if _, ok := cfg.EndpointPortAllowlist[exc.Port]; !ok {
			return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("exception port %d not allowed", exc.Port)}
		}
		if err := validateCIDR(exc.CIDR, cfg); err != nil {
			return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: err}
		}
		transportKind = "https_private"
		cidrException = &CIDRException{Hostname: exc.Hostname, Port: exc.Port, CIDR: exc.CIDR}
	}

	allowed, err := validateHeaderSet(*ep.EndpointPolicy.AllowedRequestHeaderNames)
	if err != nil {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("allowed headers: %w", err)}
	}
	forbidden, err := validateHeaderSet(*ep.EndpointPolicy.ForbiddenRequestHeaderNames)
	if err != nil {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("forbidden headers: %w", err)}
	}
	if len(intersect(allowed, forbidden)) > 0 {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: errors.New("allowed and forbidden header sets intersect")}
	}
	if ep.EndpointPolicy.MaxRequestBodyBytes < 1 || ep.EndpointPolicy.MaxRequestBodyBytes > 262144 {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: errors.New("max_request_body_bytes out of range")}
	}

	seen := make(map[string]struct{})
	var headers []HeaderRule
	if len(*ep.TransportAuthHeaders) > 32 {
		return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: errors.New("too many transport auth headers")}
	}
	for _, h := range *ep.TransportAuthHeaders {
		name := strings.ToLower(h.Name)
		if !headerNameRegex.MatchString(name) || !isASCII(name) {
			return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("header name invalid: %s", h.Name)}
		}
		if _, ok := seen[name]; ok {
			return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("duplicate header name: %s", name)}
		}
		seen[name] = struct{}{}
		if _, ok := allowed[name]; !ok {
			return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("header %s not in allowed set", name)}
		}
		if _, ok := forbidden[name]; ok {
			return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("header %s is forbidden", name)}
		}
		switch h.Kind {
		case "literal":
			if h.CredentialField != "" {
				return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: errors.New("literal header must not contain credential_field")}
			}
			if _, ok := cfg.StaticHeaderNameAllowlist[name]; !ok {
				return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("literal header %s not allowed", name)}
			}
			if !validHeaderValue(h.Value) || len(h.Value) > 1024 {
				return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("literal header value invalid: %s", h.Name)}
			}
		case "credential_field":
			if h.Value != "" {
				return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: errors.New("credential_field header must not contain literal value")}
			}
			selector := strings.ToLower(h.CredentialField)
			if selector != "token" && selector != "bearertoken" {
				return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("credential_field invalid: %s", h.CredentialField)}
			}
		default:
			return version, AdminCommandError{Code: "INVALID_ENDPOINT_POLICY", Err: fmt.Errorf("header kind invalid: %s", h.Kind)}
		}
		headers = append(headers, HeaderRule{Kind: h.Kind, Name: name, Value: h.Value, CredentialField: h.CredentialField})
	}

	mapping, err := validateIdempotencyMapping(ep.OutboundIdempotencyMapping, allowed, forbidden, seen)
	if err != nil {
		return version, AdminCommandError{Code: "INVALID_COMMAND", Err: err}
	}
	if _, ok := cfg.CredentialRefSchemeAllowlist[ep.CredentialRef.Scheme]; !ok {
		return version, AdminCommandError{Code: "INVALID_CREDENTIAL_REF", Err: fmt.Errorf("credential scheme %s not allowed", ep.CredentialRef.Scheme)}
	}
	if ep.CredentialRef.Scheme == "env" {
		if !credentialHandleRegex.MatchString(ep.CredentialRef.OpaqueHandle) {
			return version, AdminCommandError{Code: "INVALID_CREDENTIAL_REF", Err: errors.New("opaque_handle invalid")}
		}
	}
	version = EndpointVersion{
		CanonicalURL:               canonicalURL,
		Hostname:                   hostname,
		Port:                       port,
		Method:                     ep.Method,
		TransportKind:              transportKind,
		CIDRException:              cidrException,
		TransportAuthHeaders:       headers,
		OutboundIdempotencyMapping: mapping,
		EndpointPolicy: EndpointPolicy{
			AllowedRequestHeaderNames:   keys(allowed),
			ForbiddenRequestHeaderNames: keys(forbidden),
			MaxRequestBodyBytes:         ep.EndpointPolicy.MaxRequestBodyBytes,
			CIDRException:               cidrException,
		},
		AuthStrategy:  ep.AuthStrategy,
		CredentialRef: &CredentialRef{Scheme: ep.CredentialRef.Scheme, OpaqueHandle: ep.CredentialRef.OpaqueHandle, ReferenceVersion: ep.CredentialRef.ReferenceVersion},
	}
	return version, nil
}

func validateIdempotencyMapping(m OutboundIdempotencyMapping, allowed, forbidden map[string]struct{}, seen map[string]struct{}) (OutboundIdempotencyMapping, error) {
	if m.Source != "" || len(m.HeaderNames) != 0 {
		return OutboundIdempotencyMapping{}, errors.New("schema v1 mapping must not contain source or header_names")
	}
	switch m.Mode {
	case "none":
		if m.HeaderName != "" || m.FieldName != "" {
			return OutboundIdempotencyMapping{}, errors.New("none mapping must not contain header_name or field_name")
		}
		return OutboundIdempotencyMapping{Mode: "none"}, nil
	case "header":
		if m.FieldName != "" {
			return OutboundIdempotencyMapping{}, errors.New("header mapping must not contain field_name")
		}
		name := strings.ToLower(m.HeaderName)
		if !headerNameRegex.MatchString(name) || !isASCII(name) {
			return OutboundIdempotencyMapping{}, fmt.Errorf("idempotency header name invalid: %s", m.HeaderName)
		}
		if _, ok := seen[name]; ok {
			return OutboundIdempotencyMapping{}, fmt.Errorf("idempotency header name conflicts: %s", name)
		}
		if _, ok := allowed[name]; !ok {
			return OutboundIdempotencyMapping{}, fmt.Errorf("idempotency header %s not in allowed set", name)
		}
		if _, ok := forbidden[name]; ok {
			return OutboundIdempotencyMapping{}, fmt.Errorf("idempotency header %s is forbidden", name)
		}
		return OutboundIdempotencyMapping{Mode: "header", HeaderName: name}, nil
	case "body_field":
		if m.HeaderName != "" {
			return OutboundIdempotencyMapping{}, errors.New("body_field mapping must not contain header_name")
		}
		if !bodyFieldRegex.MatchString(m.FieldName) {
			return OutboundIdempotencyMapping{}, fmt.Errorf("idempotency body field invalid: %s", m.FieldName)
		}
		return OutboundIdempotencyMapping{Mode: "body_field", FieldName: m.FieldName}, nil
	default:
		return OutboundIdempotencyMapping{}, fmt.Errorf("idempotency mapping mode invalid: %s", m.Mode)
	}
}

func validateCIDR(cidr string, cfg Config) error {
	ip, ipNet, err := net.ParseCIDR(cidr)
	if err != nil {
		return err
	}
	if ipNet.IP == nil {
		return errors.New("invalid cidr")
	}
	if !ip.Equal(ip.Mask(ipNet.Mask)) {
		return errors.New("cidr must be canonical network address")
	}
	prefixLen, _ := ipNet.Mask.Size()
	if ipNet.IP.To4() != nil {
		if prefixLen < cfg.MinCIDRExceptionPrefixLengthV4 {
			return fmt.Errorf("ipv4 cidr prefix length %d below minimum", prefixLen)
		}
	} else {
		if prefixLen < cfg.MinCIDRExceptionPrefixLengthV6 {
			return fmt.Errorf("ipv6 cidr prefix length %d below minimum", prefixLen)
		}
	}
	for _, forbidden := range cfg.ForbiddenCIDRExceptionRanges {
		_, forbiddenNet, err := net.ParseCIDR(forbidden)
		if err != nil {
			continue
		}
		if forbiddenNet.Contains(ipNet.IP) || ipNet.Contains(forbiddenNet.IP) {
			return fmt.Errorf("cidr intersects forbidden range %s", forbidden)
		}
	}
	return nil
}

func validateHeaderSet(values []string) (map[string]struct{}, error) {
	if len(values) > 32 {
		return nil, errors.New("header set exceeds 32 entries")
	}
	out := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value != strings.ToLower(value) || !isASCII(value) || !headerNameRegex.MatchString(value) {
			return nil, fmt.Errorf("invalid lowercase ASCII header name %q", value)
		}
		if _, duplicate := out[value]; duplicate {
			return nil, fmt.Errorf("duplicate header name %q", value)
		}
		out[value] = struct{}{}
	}
	return out, nil
}

func validHeaderValue(value string) bool {
	for _, c := range []byte(value) {
		if c == 0 || c == '\r' || c == '\n' || c == 0x7f || (c < 0x20 && c != '\t') {
			return false
		}
	}
	return true
}

func intersect(a, b map[string]struct{}) []string {
	var out []string
	for k := range a {
		if _, ok := b[k]; ok {
			out = append(out, k)
		}
	}
	return out
}

func keys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// EndpointConfigInput is the wire/config input for an endpoint version.
type EndpointConfigInput struct {
	EndpointTarget             EndpointTargetInput        `json:"endpoint_target"`
	Method                     string                     `json:"method"`
	TransportAuthHeaders       *[]HeaderRuleInput         `json:"transport_auth_headers"`
	OutboundIdempotencyMapping OutboundIdempotencyMapping `json:"outbound_idempotency_mapping"`
	EndpointPolicy             EndpointPolicyInput        `json:"endpoint_policy"`
	AuthStrategy               string                     `json:"auth_strategy"`
	CredentialRef              CredentialRefInput         `json:"credential_ref"`
}

// EndpointTargetInput is the endpoint URL input.
type EndpointTargetInput struct {
	URL                     string                        `json:"url"`
	PrivateNetworkException *PrivateNetworkExceptionInput `json:"private_network_exception,omitempty"`
}

// PrivateNetworkExceptionInput is the CIDR exception input.
type PrivateNetworkExceptionInput struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
	CIDR     string `json:"cidr"`
}

// HeaderRuleInput is the wire header rule input.
type HeaderRuleInput struct {
	Kind            string `json:"kind"`
	Name            string `json:"name"`
	Value           string `json:"value,omitempty"`
	CredentialField string `json:"credential_field,omitempty"`
}

// EndpointPolicyInput is the wire endpoint policy input.
type EndpointPolicyInput struct {
	AllowedRequestHeaderNames   *[]string `json:"allowed_request_header_names"`
	ForbiddenRequestHeaderNames *[]string `json:"forbidden_request_header_names"`
	MaxRequestBodyBytes         int64     `json:"max_request_body_bytes"`
}

// CredentialRefInput is the wire credential reference input.
type CredentialRefInput struct {
	Scheme           string `json:"scheme"`
	OpaqueHandle     string `json:"opaque_handle"`
	ReferenceVersion string `json:"reference_version,omitempty"`
}

// SanitizedRequestDigest returns a stable non-secret digest string for audit.
func SanitizedRequestDigest(op, vendorID string, expectedRevision int64) string {
	h := sha256.New()
	_, _ = h.Write([]byte(fmt.Sprintf("%s|%s|%d", op, vendorID, expectedRevision)))
	return fmt.Sprintf("%x", h.Sum(nil))[:16]
}

// context import alias.
var _ = context.Background
