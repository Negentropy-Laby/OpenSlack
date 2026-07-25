package delivery

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry"
)

// Resolver resolves all addresses for a hostname.
type Resolver interface {
	ResolveAll(ctx context.Context, hostname string) ([]netip.Addr, error)
}

// HTTPTransport sends one request to a policy-approved pinned address.
type HTTPTransport interface {
	Do(ctx context.Context, req *http.Request, pinned netip.Addr, timeout time.Duration, responsePolicy string) (TransportResponse, error)
}

const maxJSONAckBodyBytes = 16 * 1024

// TransportResponse is the bounded, sanitized response surface exposed to the
// classifier. AckBody is populated only for json_ack_v1 2xx responses and is
// never persisted or logged.
type TransportResponse struct {
	StatusCode      int
	Header          http.Header
	AckBody         []byte
	AckBodyOverflow bool
}

// NetResolver is the production DNS resolver using net.Resolver.
type NetResolver struct{}

// ResolveAll queries A and AAAA records and returns all addresses. It returns
// a retryable transport error on failure.
func (NetResolver) ResolveAll(ctx context.Context, hostname string) ([]netip.Addr, error) {
	r := &net.Resolver{}
	ips, err := r.LookupIPAddr(ctx, hostname)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", NewTransportError(ErrorCodeDNSFailure), err)
	}
	addrs := make([]netip.Addr, 0, len(ips))
	for _, ip := range ips {
		if addr, ok := netip.AddrFromSlice(ip.IP); ok {
			addrs = append(addrs, addr)
		}
	}
	if len(addrs) == 0 {
		return nil, NewTransportError(ErrorCodeDNSFailure)
	}
	return addrs, nil
}

// TransportError is a retryable transport-layer failure.
type TransportError struct {
	Code string
}

func (e *TransportError) Error() string {
	return fmt.Sprintf("transport error: %s", e.Code)
}

// NewTransportError creates a transport error with the given code.
func NewTransportError(code string) *TransportError {
	return &TransportError{Code: code}
}

// IsTransportError reports whether err is a TransportError with the given code.
func IsTransportError(err error, code string) bool {
	var e *TransportError
	if errors.As(err, &e) {
		return e.Code == code
	}
	return false
}

// AddressPolicy decides whether a resolved address set is safe to connect to.
// It is deterministic and has no side effects.
type AddressPolicy struct {
	AllowedPorts   map[int]struct{}
	ForbiddenCIDRs []*net.IPNet
}

// CIDRException is a private-network exception for a specific hostname/port.
// It mirrors vendorregistry.CIDRException with a parsed net.IPNet.
type CIDRException struct {
	Hostname string
	Port     int
	Net      *net.IPNet
}

// NewAddressPolicy builds an address policy from config. It may return an error
// if a forbidden CIDR cannot be parsed.
func NewAddressPolicy(allowedPorts map[int]struct{}, forbiddenCIDRs []string) (*AddressPolicy, error) {
	p := &AddressPolicy{AllowedPorts: allowedPorts}
	for _, cidr := range forbiddenCIDRs {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			return nil, fmt.Errorf("invalid forbidden CIDR %q: %w", cidr, err)
		}
		p.ForbiddenCIDRs = append(p.ForbiddenCIDRs, ipNet)
	}
	return p, nil
}

// Evaluate checks whether the resolved addresses are allowed for the given
// hostname and port. It returns a selected pinned address (the first allowed
// address) or a policy-termination error.
//
// Invariants enforced:
//   - Metadata endpoints are rejected.
//   - The port must be in the allowed set.
//   - IPv4-mapped IPv6 addresses are rejected (IPv6 mapping rejection).
//   - If a CIDR exception is provided, every address must be inside it.
//   - Otherwise, every address must be public and not in any forbidden CIDR.
//   - If any address is rejected, the whole set is rejected (DL-10).
func (p *AddressPolicy) Evaluate(hostname string, port int, addrs []netip.Addr, exception *CIDRException) (netip.Addr, error) {
	if IsMetadataEndpoint(hostname) {
		return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
	}
	if _, ok := p.AllowedPorts[port]; !ok {
		return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
	}
	if len(addrs) == 0 {
		return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
	}
	if exception != nil && (!strings.EqualFold(exception.Hostname, hostname) || exception.Port != port) {
		return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
	}

	for _, addr := range addrs {
		if !addr.IsValid() {
			return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
		}
		if addr.Is4In6() {
			return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
		}
		if exception != nil {
			// A private exception may authorize only RFC1918/ULA space. It never
			// opens loopback, link-local, CGNAT, documentation, benchmark,
			// multicast, unspecified or other special-purpose ranges.
			if !addr.IsPrivate() {
				return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
			}
			ip := net.IP(addr.AsSlice())
			if !exception.Net.Contains(ip) {
				return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
			}
			continue
		}
		if !IsPublic(addr) {
			return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
		}
		for _, forbidden := range p.ForbiddenCIDRs {
			if forbidden.Contains(net.IP(addr.AsSlice())) {
				return netip.Addr{}, NewPolicyError(ReasonDestinationRejected)
			}
		}
	}

	return addrs[0], nil
}

// SafeTransport is an SSRF-safe HTTP transport. It pins every request to a
// pre-resolved IP address, disables proxying and redirects, and never re-resolves
// the hostname during dial (DNS rebinding protection).
type SafeTransport struct {
	base   *http.Transport
	dialer func(context.Context, string, string) (net.Conn, error)
}

// NewSafeTransport creates a SafeTransport with the given address policy.
func NewSafeTransport() *SafeTransport {
	var dialer net.Dialer
	return NewSafeTransportWithDialer(dialer.DialContext)
}

// NewSafeTransportWithDialer provides a deterministic dial seam for transport
// tests while production continues to use net.Dialer.
func NewSafeTransportWithDialer(dial func(context.Context, string, string) (net.Conn, error)) *SafeTransport {
	return newSafeTransport(dial, &tls.Config{MinVersion: tls.VersionTLS12})
}

func newSafeTransport(dial func(context.Context, string, string) (net.Conn, error), tlsConfig *tls.Config) *SafeTransport {
	base := &http.Transport{
		Proxy:                 nil, // CTRL-015: no proxy
		ForceAttemptHTTP2:     false,
		DisableKeepAlives:     true,
		MaxIdleConns:          0,
		IdleConnTimeout:       0,
		ExpectContinueTimeout: 0,
		TLSClientConfig:       tlsConfig,
	}
	st := &SafeTransport{base: base, dialer: dial}
	base.DialContext = st.dialContext
	base.DialTLSContext = st.dialTLSContext
	return st
}

type pinnedIPKey struct{}

// WithPinnedIP attaches a pre-resolved pinned IP address to the context. The
// SafeTransport uses this IP for dialing while preserving the original hostname
// for TLS SNI.
func WithPinnedIP(ctx context.Context, addr netip.Addr) context.Context {
	return context.WithValue(ctx, pinnedIPKey{}, addr)
}

func pinnedIPFromContext(ctx context.Context) (netip.Addr, bool) {
	v, ok := ctx.Value(pinnedIPKey{}).(netip.Addr)
	return v, ok
}

func (t *SafeTransport) dialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	pinned, ok := pinnedIPFromContext(ctx)
	if !ok {
		return nil, errors.New("safe transport: no pinned IP in context")
	}
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("safe transport: invalid dial addr %q: %w", addr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("safe transport: invalid port %q", portStr)
	}
	return t.dial(ctx, network, pinned, uint16(port))
}

func (t *SafeTransport) dialTLSContext(ctx context.Context, network, addr string) (net.Conn, error) {
	hostname, portString, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, NewTransportError(ErrorCodeTLSFailure)
	}
	port, err := strconv.Atoi(portString)
	if err != nil || port < 1 || port > 65535 {
		return nil, NewTransportError(ErrorCodeTLSFailure)
	}
	pinned, ok := pinnedIPFromContext(ctx)
	if !ok {
		return nil, NewTransportError(ErrorCodeConnectionFailure)
	}
	raw, err := t.dial(ctx, network, pinned, uint16(port))
	if err != nil {
		return nil, err
	}
	tlsConfig := t.base.TLSClientConfig.Clone()
	if tlsConfig.ServerName == "" {
		tlsConfig.ServerName = hostname
	}
	connection := tls.Client(raw, tlsConfig)
	if err := connection.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return nil, NewTransportError(ErrorCodeTimeout)
		}
		return nil, NewTransportError(ErrorCodeTLSFailure)
	}
	return connection, nil
}

func (t *SafeTransport) dial(ctx context.Context, network string, pinned netip.Addr, port uint16) (net.Conn, error) {
	addrPort := netip.AddrPortFrom(pinned, port)
	conn, err := t.dialer(ctx, network, addrPort.String())
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return nil, NewTransportError(ErrorCodeTimeout)
		}
		if isTLSFailure(err) {
			return nil, NewTransportError(ErrorCodeTLSFailure)
		}
		return nil, NewTransportError(ErrorCodeConnectionFailure)
	}
	return conn, nil
}

func isTLSFailure(err error) bool {
	var certificateVerification *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var hostnameError x509.HostnameError
	var certificateInvalid x509.CertificateInvalidError
	var recordHeader tls.RecordHeaderError
	var alert tls.AlertError
	if errors.As(err, &certificateVerification) ||
		errors.As(err, &unknownAuthority) ||
		errors.As(err, &hostnameError) ||
		errors.As(err, &certificateInvalid) ||
		errors.As(err, &recordHeader) ||
		errors.As(err, &alert) {
		return true
	}
	// net/http may flatten some TLS handshake alerts while wrapping them in a
	// url.Error. Restrict the fallback to standard-library TLS/x509 prefixes so
	// ordinary connection failures retain their own stable category.
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "tls:") || strings.Contains(message, "x509:")
}

// Do executes a request with the pinned IP address and a hard timeout. It does
// not follow redirects or use proxies. http_status_v1 never reads the response
// body; json_ack_v1 reads at most 16 KiB plus one overflow sentinel on 2xx.
func (t *SafeTransport) Do(ctx context.Context, req *http.Request, pinned netip.Addr, timeout time.Duration, responsePolicy string) (TransportResponse, error) {
	if responsePolicy != vendorregistry.ResponsePolicyHTTPStatusV1 && responsePolicy != vendorregistry.ResponsePolicyJSONAckV1 {
		return TransportResponse{}, NewPolicyError(ReasonRequestUnbuildable)
	}
	ctx = WithPinnedIP(ctx, pinned)
	req = req.Clone(ctx)

	client := &http.Client{
		Transport:     t.base,
		Timeout:       timeout,
		CheckRedirect: noRedirect,
	}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, http.ErrUseLastResponse) {
			return TransportResponse{}, NewPolicyError(ReasonDestinationRejected)
		}
		var transportError *TransportError
		if errors.As(err, &transportError) {
			return TransportResponse{}, transportError
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return TransportResponse{}, NewTransportError(ErrorCodeTimeout)
		}
		return TransportResponse{}, NewTransportError(ErrorCodeConnectionFailure)
	}
	if resp == nil {
		return TransportResponse{}, NewTransportError(ErrorCodeConnectionFailure)
	}
	result := TransportResponse{StatusCode: resp.StatusCode, Header: resp.Header.Clone()}
	if resp.Body == nil {
		return result, nil
	}
	defer resp.Body.Close()
	if responsePolicy != vendorregistry.ResponsePolicyJSONAckV1 || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return result, nil
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxJSONAckBodyBytes+1))
	if readErr != nil {
		var netErr net.Error
		if errors.As(readErr, &netErr) && netErr.Timeout() {
			return TransportResponse{}, NewTransportError(ErrorCodeTimeout)
		}
		return TransportResponse{}, NewTransportError(ErrorCodeConnectionFailure)
	}
	if len(body) > maxJSONAckBodyBytes {
		result.AckBody = append([]byte(nil), body[:maxJSONAckBodyBytes]...)
		result.AckBodyOverflow = true
	} else {
		result.AckBody = append([]byte(nil), body...)
	}
	return result, nil
}

func noRedirect(req *http.Request, via []*http.Request) error {
	return http.ErrUseLastResponse
}

// ToCIDRException converts a vendorregistry.CIDRException into a parsed
// transport CIDRException.
func ToCIDRException(exc *vendorregistry.CIDRException) (*CIDRException, error) {
	if exc == nil {
		return nil, nil
	}
	_, ipNet, err := net.ParseCIDR(exc.CIDR)
	if err != nil {
		return nil, err
	}
	return &CIDRException{Hostname: exc.Hostname, Port: exc.Port, Net: ipNet}, nil
}
