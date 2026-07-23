package delivery

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"rc_wsman/internal/notificationstore"
	"rc_wsman/internal/vendorregistry"
)

// Reason constants for policy terminations and actual-result dies.
const (
	ReasonAttemptLimit          = "attempt_limit"
	ReasonDeadlineExceeded      = "deadline_exceeded"
	ReasonVendorUnavailable     = "vendor_unavailable"
	ReasonDestinationRejected   = "destination_rejected"
	ReasonCredentialUnavailable = "credential_unavailable"
	ReasonRequestUnbuildable    = "request_unbuildable"

	ReasonNonRetryableHTTPStatus = "non_retryable_http_status"
	ReasonVendorUnreachable      = "vendor_unreachable"
	ReasonVendorRejected         = "vendor_rejected"
	ReasonVendorProtocolError    = "vendor_protocol_error"

	ErrorCodeDNSFailure            = "dns_failure"
	ErrorCodeConnectionFailure     = "connection_failure"
	ErrorCodeTLSFailure            = "tls_failure"
	ErrorCodeTimeout               = "timeout"
	ErrorCodePreflightTimeout      = "preflight_timeout"
	ErrorCodeRegistryAccessFailure = "registry_access_failure"
)

var retryableJSONAckCodes = map[string]struct{}{
	"fatal_error":         {},
	"internal_error":      {},
	"ratelimited":         {},
	"request_timeout":     {},
	"service_unavailable": {},
}

// AttemptContext captures the per-attempt mutable state. It is discarded after
// the attempt and never persisted.
type AttemptContext struct {
	NotificationID         string
	IngressIdempotencyKey  string
	LeaseID                string
	Version                int64
	VendorID               string
	Payload                []byte
	AttemptCount           int
	DeliveryCycleStartedAt time.Time
	CreatedAt              time.Time
	LeaseExpiresAt         time.Time
	ConfigVersion          int64
	ResolvedIP             netip.Addr
	RequestStartedAt       time.Time
}

// Outcome is the normalized result of a delivery attempt.
type Outcome struct {
	ResultKind    notificationstore.ResultKind
	OutcomeClass  notificationstore.OutcomeClass
	HTTPStatus    int
	ErrorCode     string
	Reason        string
	RetryAfter    *time.Duration // parsed retryable-HTTP Retry-After hint, not a scheduled time
	ConfigVersion *int64
}

// HealthSignalError asks the worker lifecycle to emit a sanitized health event.
// It may represent either an infrastructure failure that left the lease for
// recovery or a committed policy/retry result whose internal-authority anomaly
// still needs operator visibility.
type HealthSignalError struct {
	Code string
	Err  error
}

func (e *HealthSignalError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("delivery health signal %s: %v", e.Code, e.Err)
	}
	return "delivery health signal: " + e.Code
}

func (e *HealthSignalError) Unwrap() error { return e.Err }

func newHealthSignal(code string, err error) error {
	return &HealthSignalError{Code: code, Err: err}
}

// IsRetryable reports whether the outcome is a retryable failure.
func (o Outcome) IsRetryable() bool {
	return o.OutcomeClass == notificationstore.OutcomeClassRetryableFailure
}

// ToDeliveryResult converts an Outcome to the notificationstore DeliveryResult.
func (o Outcome) ToDeliveryResult() notificationstore.DeliveryResult {
	return notificationstore.DeliveryResult{
		ResultKind:    o.ResultKind,
		OutcomeClass:  o.OutcomeClass,
		HTTPStatus:    o.HTTPStatus,
		ErrorCode:     o.ErrorCode,
		Reason:        o.Reason,
		ConfigVersion: o.ConfigVersion,
	}
}

// Classifier maps HTTP responses, transport errors, and policy failures to a
// closed Outcome. It never logs or returns payload/secret/response body data.
func Classify(httpStatus int, transportErr error, retryAfter *time.Duration) Outcome {
	if transportErr != nil {
		return classifyTransportError(transportErr)
	}
	return classifyHTTPStatus(httpStatus, retryAfter)
}

// ClassifyResponse applies the immutable endpoint response policy to a bounded
// transport response. It never returns or persists raw acknowledgement bytes.
func ClassifyResponse(responsePolicy string, response TransportResponse, retryAfter *time.Duration) Outcome {
	switch responsePolicy {
	case vendorregistry.ResponsePolicyHTTPStatusV1:
		return classifyHTTPStatus(response.StatusCode, retryAfter)
	case vendorregistry.ResponsePolicyJSONAckV1:
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return classifyHTTPStatus(response.StatusCode, retryAfter)
		}
		if response.AckBodyOverflow {
			return vendorProtocolErrorOutcome(response.StatusCode)
		}
		ok, code, err := parseJSONAck(response.AckBody)
		if err != nil {
			return vendorProtocolErrorOutcome(response.StatusCode)
		}
		if ok {
			return Outcome{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassSuccess, HTTPStatus: response.StatusCode}
		}
		if _, retryable := retryableJSONAckCodes[code]; retryable {
			return Outcome{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassRetryableFailure, HTTPStatus: response.StatusCode, ErrorCode: code, RetryAfter: retryAfter}
		}
		return Outcome{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassPermanentFailure, HTTPStatus: response.StatusCode, Reason: ReasonVendorRejected}
	default:
		return PolicyTerminationOutcome(ReasonRequestUnbuildable)
	}
}

func vendorProtocolErrorOutcome(status int) Outcome {
	return Outcome{ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassPermanentFailure, HTTPStatus: status, Reason: ReasonVendorProtocolError}
}

func parseJSONAck(body []byte) (bool, string, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return false, "", errors.New("ack is not an object")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return false, "", errors.New("ack key invalid")
		}
		key, ok := keyToken.(string)
		if !ok {
			return false, "", errors.New("ack key type invalid")
		}
		if _, duplicate := fields[key]; duplicate {
			return false, "", errors.New("ack contains duplicate field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return false, "", errors.New("ack value invalid")
		}
		fields[key] = value
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return false, "", errors.New("ack object unterminated")
	}
	if decoder.More() {
		return false, "", errors.New("ack contains trailing value")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return false, "", errors.New("ack contains trailing value")
	} else if !errors.Is(err, io.EOF) {
		return false, "", errors.New("ack trailing data invalid")
	}
	okRaw, exists := fields["ok"]
	if !exists {
		return false, "", errors.New("ack missing ok")
	}
	var acknowledged bool
	if err := json.Unmarshal(okRaw, &acknowledged); err != nil {
		return false, "", errors.New("ack ok type invalid")
	}
	if acknowledged {
		return true, "", nil
	}
	code := ""
	if errorRaw, exists := fields["error"]; exists {
		if err := json.Unmarshal(errorRaw, &code); err != nil {
			return false, "", errors.New("ack error type invalid")
		}
	}
	if code == "" {
		return false, "", errors.New("negative ack missing error")
	}
	return false, code, nil
}

func classifyTransportError(err error) Outcome {
	var pe *PolicyError
	if errors.As(err, &pe) {
		return Outcome{
			ResultKind:   notificationstore.ResultKindPolicyTermination,
			OutcomeClass: notificationstore.OutcomeClassPermanentFailure,
			Reason:       pe.Reason,
		}
	}
	code := mapTransportErrorCode(err)
	return Outcome{
		ResultKind:   notificationstore.ResultKindTransportFailure,
		OutcomeClass: notificationstore.OutcomeClassRetryableFailure,
		ErrorCode:    code,
	}
}

func mapTransportErrorCode(err error) string {
	var ne net.Error
	if errors.As(err, &ne) {
		if ne.Timeout() {
			return ErrorCodeTimeout
		}
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "dns") || strings.Contains(msg, "resolve") || strings.Contains(msg, "no such host"):
		return ErrorCodeDNSFailure
	case strings.Contains(msg, "tls") || strings.Contains(msg, "x509"):
		return ErrorCodeTLSFailure
	case strings.Contains(msg, "connection refused"), strings.Contains(msg, "no route to host"), strings.Contains(msg, "network is unreachable"):
		return ErrorCodeConnectionFailure
	case strings.Contains(msg, "timeout"):
		return ErrorCodeTimeout
	default:
		return ErrorCodeConnectionFailure
	}
}

func classifyHTTPStatus(status int, retryAfter *time.Duration) Outcome {
	switch {
	case status >= 200 && status < 300:
		return Outcome{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassSuccess,
			HTTPStatus:   status,
		}
	case status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500 && status < 600:
		out := Outcome{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassRetryableFailure,
			HTTPStatus:   status,
		}
		if retryAfter != nil {
			out.RetryAfter = retryAfter
		}
		return out
	case status >= 100 && status < 200:
		return Outcome{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassPermanentFailure,
			HTTPStatus:   status,
			Reason:       ReasonNonRetryableHTTPStatus,
		}
	case status >= 300 && status < 400:
		return Outcome{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassPermanentFailure,
			HTTPStatus:   status,
			Reason:       ReasonNonRetryableHTTPStatus,
		}
	case status >= 400 && status < 500:
		return Outcome{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassPermanentFailure,
			HTTPStatus:   status,
			Reason:       ReasonNonRetryableHTTPStatus,
		}
	default:
		return Outcome{
			ResultKind:   notificationstore.ResultKindHTTPResponse,
			OutcomeClass: notificationstore.OutcomeClassPermanentFailure,
			HTTPStatus:   status,
			Reason:       ReasonNonRetryableHTTPStatus,
		}
	}
}

// ParseRetryAfter parses a Retry-After header value into a duration. It returns
// nil for missing/invalid values so the caller falls back to jitter.
func ParseRetryAfter(raw string, now time.Time) *time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n >= 0 {
		const maxDurationSeconds = int64(^uint64(0)>>1) / int64(time.Second)
		if n > maxDurationSeconds {
			return nil
		}
		d := time.Duration(n) * time.Second
		return &d
	}
	if t, err := http.ParseTime(raw); err == nil {
		d := t.Sub(now)
		if d < 0 {
			d = 0
		}
		return &d
	}
	return nil
}

// PolicyError is a policy-termination failure that should not be retried.
// It carries a stable reason from the delivery CDD reason set.
type PolicyError struct {
	Reason string
}

func (e *PolicyError) Error() string {
	return fmt.Sprintf("policy termination: %s", e.Reason)
}

// NewPolicyError creates a PolicyError with a stable reason.
func NewPolicyError(reason string) *PolicyError {
	return &PolicyError{Reason: reason}
}

// PolicyTerminationOutcome returns a policy-termination Outcome for the given reason.
func PolicyTerminationOutcome(reason string) Outcome {
	return Outcome{
		ResultKind:   notificationstore.ResultKindPolicyTermination,
		OutcomeClass: notificationstore.OutcomeClassPermanentFailure,
		Reason:       reason,
	}
}

// ApplyB01Cutoff converts a retryable outcome to an atomic die outcome when the
// attempt completed at or after the cycle send cutoff. It preserves the original
// ResultKind, HTTPStatus, and ErrorCode while changing the class to permanent
// failure and clearing the next attempt time.
func ApplyB01Cutoff(o Outcome, completedAt, cutoff time.Time) Outcome {
	if !o.IsRetryable() || completedAt.Before(cutoff) {
		return o
	}
	return Outcome{
		ResultKind:   o.ResultKind,
		OutcomeClass: notificationstore.OutcomeClassPermanentFailure,
		HTTPStatus:   o.HTTPStatus,
		ErrorCode:    o.ErrorCode,
		Reason:       ReasonDeadlineExceeded,
	}
}

// IsPublic reports whether addr is a public (routable) unicast address.
// It rejects loopback, link-local, multicast, private, and unspecified addresses.
func IsPublic(addr netip.Addr) bool {
	if !addr.IsValid() || addr.Is4In6() || !addr.IsGlobalUnicast() {
		return false
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("::ffff:0:0/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("5f00::/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

// IsMetadataEndpoint reports whether hostname is a cloud metadata endpoint.
func IsMetadataEndpoint(hostname string) bool {
	h := strings.ToLower(strings.TrimSpace(hostname))
	return h == "169.254.169.254" || strings.HasSuffix(h, ".metadata.internal")
}
