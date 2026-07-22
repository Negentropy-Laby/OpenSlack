package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"

	"rc_wsman/internal/vendorregistry"
)

// Credential is the in-memory credential material resolved by a
// CredentialResolver. It is never persisted or logged.
type Credential struct {
	BearerToken string
}

// CredentialResolver resolves a CredentialRef into an in-memory Credential.
// Permanent resolution failures (unknown env var, unsupported scheme) return a
// policy-termination error. Transient failures return a transport error.
type CredentialResolver interface {
	Resolve(ctx context.Context, ref vendorregistry.CredentialRef) (Credential, error)
}

// EnvCredentialResolver resolves env://NAME credentials. It is fail-closed: only
// names on the allowlist may be read, and the value must be non-empty.
type EnvCredentialResolver struct {
	Allowlist []string
}

// NewEnvCredentialResolver builds a resolver from an allowlist of environment
// variable names.
func NewEnvCredentialResolver(allowlist []string) *EnvCredentialResolver {
	return &EnvCredentialResolver{Allowlist: allowlist}
}

func (r *EnvCredentialResolver) allowed(name string) bool {
	for _, a := range r.Allowlist {
		if a == name {
			return true
		}
	}
	return false
}

// Resolve reads an env:// credential from the process environment.
func (r *EnvCredentialResolver) Resolve(ctx context.Context, ref vendorregistry.CredentialRef) (Credential, error) {
	if ref.Scheme != "env" {
		return Credential{}, NewPolicyError(ReasonCredentialUnavailable)
	}
	if !r.allowed(ref.OpaqueHandle) {
		return Credential{}, NewPolicyError(ReasonCredentialUnavailable)
	}
	v := os.Getenv(ref.OpaqueHandle)
	if v == "" {
		return Credential{}, NewPolicyError(ReasonCredentialUnavailable)
	}
	return Credential{BearerToken: v}, nil
}

// BuiltRequest is the result of request construction.
type BuiltRequest struct {
	Method       string
	URL          *url.URL
	Header       http.Header
	Body         []byte
	ResolvedIP   netip.Addr
	AuthStrategy string
}

// BuildRequest constructs an outbound HTTP request from the delivery snapshot,
// credential, payload, and notification id. It applies transport auth headers,
// idempotency mapping, and bearer auth, then validates the body budget.
func BuildRequest(
	notificationID string,
	ingressIdempotencyKey string,
	payload []byte,
	snapshot vendorregistry.DeliveryConfigSnapshot,
	cred Credential,
	resolvedIP netip.Addr,
) (*BuiltRequest, error) {
	canonicalURL, canonicalHostname, canonicalPort, err := vendorregistry.NormalizeURL(snapshot.CanonicalURL)
	if err != nil || canonicalURL != snapshot.CanonicalURL || canonicalHostname != snapshot.Hostname || canonicalPort != snapshot.Port {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	u, err := url.Parse(snapshot.CanonicalURL)
	if err != nil {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}

	if u.Scheme != "https" || u.User != nil || u.Fragment != "" || !strings.EqualFold(u.Hostname(), snapshot.Hostname) {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	if snapshot.Method != http.MethodPost {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	if !resolvedIP.IsValid() || resolvedIP.Is4In6() {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	if snapshot.EndpointPolicy.MaxRequestBodyBytes < 1 || snapshot.EndpointPolicy.MaxRequestBodyBytes > vendorregistry.DefaultMaxBodyBytes {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	switch snapshot.TransportKind {
	case "https_public":
		if snapshot.CIDRException != nil {
			return nil, NewPolicyError(ReasonRequestUnbuildable)
		}
	case "https_private":
		if snapshot.CIDRException == nil || !strings.EqualFold(snapshot.CIDRException.Hostname, snapshot.Hostname) || snapshot.CIDRException.Port != snapshot.Port {
			return nil, NewPolicyError(ReasonRequestUnbuildable)
		}
	default:
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	port := 443
	if u.Port() != "" {
		port, err = strconv.Atoi(u.Port())
		if err != nil {
			return nil, NewPolicyError(ReasonRequestUnbuildable)
		}
	}
	if port != snapshot.Port {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}
	header := http.Header{}
	seenHeaders := make(map[string]struct{})
	body := append([]byte(nil), payload...)

	// Apply transport auth headers first.
	for _, rule := range snapshot.TransportAuthHeaders {
		name := strings.ToLower(rule.Name)
		if !safeSnapshotHeader(name) || !headerAllowedByPolicy(name, snapshot.EndpointPolicy) {
			return nil, NewPolicyError(ReasonRequestUnbuildable)
		}
		if _, duplicate := seenHeaders[name]; duplicate {
			return nil, NewPolicyError(ReasonRequestUnbuildable)
		}
		seenHeaders[name] = struct{}{}
		switch rule.Kind {
		case "literal":
			if !safeSnapshotHeaderValue(rule.Value) {
				return nil, NewPolicyError(ReasonRequestUnbuildable)
			}
			header.Set(rule.Name, rule.Value)
		case "credential_field":
			if snapshot.AuthStrategy == "none" {
				return nil, NewPolicyError(ReasonRequestUnbuildable)
			}
			value, err := resolveCredentialField(cred, rule.CredentialField)
			if err != nil {
				return nil, err
			}
			if !safeSnapshotHeaderValue(value) {
				return nil, NewPolicyError(ReasonCredentialUnavailable)
			}
			header.Set(rule.Name, value)
		default:
			return nil, NewPolicyError(ReasonRequestUnbuildable)
		}
	}

	if err := applyIdempotencyMapping(snapshot, notificationID, ingressIdempotencyKey, header, seenHeaders, &body); err != nil {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}

	// Apply auth strategy.
	switch snapshot.AuthStrategy {
	case "bearer":
		if (snapshot.ConfigSchemaVersion != 1 && snapshot.ConfigSchemaVersion != 2) || snapshot.CredentialRef == nil {
			return nil, NewPolicyError(ReasonRequestUnbuildable)
		}
		if header.Get("authorization") != "" {
			return nil, NewPolicyError(ReasonRequestUnbuildable)
		}
		if cred.BearerToken == "" || !safeSnapshotHeaderValue(cred.BearerToken) {
			return nil, NewPolicyError(ReasonCredentialUnavailable)
		}
		header.Set("authorization", "Bearer "+cred.BearerToken)
	case "none":
		if snapshot.ConfigSchemaVersion != 2 || snapshot.CredentialRef != nil || cred != (Credential{}) {
			return nil, NewPolicyError(ReasonRequestUnbuildable)
		}
	default:
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}

	// Body budget.
	if int64(len(body)) > snapshot.EndpointPolicy.MaxRequestBodyBytes {
		return nil, NewPolicyError(ReasonRequestUnbuildable)
	}

	return &BuiltRequest{
		Method:       snapshot.Method,
		URL:          u,
		Header:       header,
		Body:         body,
		ResolvedIP:   resolvedIP,
		AuthStrategy: snapshot.AuthStrategy,
	}, nil
}

func applyIdempotencyMapping(
	snapshot vendorregistry.DeliveryConfigSnapshot,
	notificationID string,
	ingressIdempotencyKey string,
	header http.Header,
	seenHeaders map[string]struct{},
	body *[]byte,
) error {
	mapping := snapshot.OutboundIdempotencyMapping
	switch snapshot.ConfigSchemaVersion {
	case 1:
		if mapping.Source != "" || len(mapping.HeaderNames) != 0 {
			return errors.New("schema v1 mapping contains schema v2 fields")
		}
		switch mapping.Mode {
		case "none":
			if mapping.HeaderName != "" || mapping.FieldName != "" {
				return errors.New("none mapping contains fields")
			}
			return nil
		case "header":
			if mapping.FieldName != "" {
				return errors.New("header mapping contains body field")
			}
			return setIdempotencyHeader(mapping.HeaderName, notificationID, snapshot.EndpointPolicy, header, seenHeaders, false)
		case "body_field":
			if mapping.HeaderName != "" || mapping.FieldName == "" {
				return errors.New("body field mapping is invalid")
			}
			mediaType, _, err := mime.ParseMediaType(header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" {
				return errors.New("body field mapping requires JSON")
			}
			payloadMap, err := decodeJSONObject(*body)
			if err != nil {
				return err
			}
			if _, ok := payloadMap[mapping.FieldName]; ok {
				return errors.New("body field already exists")
			}
			encodedID, _ := json.Marshal(notificationID)
			payloadMap[mapping.FieldName] = encodedID
			newBody, err := json.Marshal(payloadMap)
			if err != nil {
				return err
			}
			*body = newBody
			return nil
		default:
			return errors.New("invalid schema v1 mapping mode")
		}
	case 2:
		if mapping.HeaderName != "" || mapping.FieldName != "" {
			return errors.New("schema v2 mapping contains schema v1 fields")
		}
		switch mapping.Mode {
		case "none":
			if mapping.Source != "" || len(mapping.HeaderNames) != 0 {
				return errors.New("none mapping contains fields")
			}
			return nil
		case "headers":
			if len(mapping.HeaderNames) < 1 || len(mapping.HeaderNames) > 4 {
				return errors.New("schema v2 header count outside bounds")
			}
			var value string
			switch mapping.Source {
			case "notification_id":
				value = notificationID
			case "ingress_idempotency_key":
				value = ingressIdempotencyKey
			default:
				return errors.New("invalid schema v2 idempotency source")
			}
			if value == "" {
				return errors.New("idempotency source value is empty")
			}
			for _, name := range mapping.HeaderNames {
				if err := setIdempotencyHeader(name, value, snapshot.EndpointPolicy, header, seenHeaders, true); err != nil {
					return err
				}
			}
			return nil
		default:
			return errors.New("invalid schema v2 mapping mode")
		}
	default:
		return errors.New("unsupported endpoint config schema version")
	}
}

func setIdempotencyHeader(name, value string, policy vendorregistry.EndpointPolicy, header http.Header, seenHeaders map[string]struct{}, requireLowercase bool) error {
	if !safeSnapshotHeaderValue(value) {
		return errors.New("idempotency value is unsafe")
	}
	if requireLowercase && name != strings.ToLower(name) {
		return errors.New("schema v2 header name must be lowercase")
	}
	name = strings.ToLower(name)
	if !safeSnapshotHeader(name) || !headerAllowedByPolicy(name, policy) {
		return errors.New("idempotency header is not allowed")
	}
	if _, duplicate := seenHeaders[name]; duplicate {
		return errors.New("duplicate idempotency header")
	}
	seenHeaders[name] = struct{}{}
	header.Set(name, value)
	return nil
}

func safeSnapshotHeader(name string) bool {
	if name == "" || strings.TrimSpace(name) != name || !isHTTPToken(name) {
		return false
	}
	switch http.CanonicalHeaderKey(name) {
	case "Host", "Content-Length", "Transfer-Encoding", "Connection", "Proxy-Authorization", "Proxy-Connection", "Trailer", "Upgrade":
		return false
	default:
		return true
	}
}

func safeSnapshotHeaderValue(value string) bool {
	for _, c := range []byte(value) {
		if c == 0 || c == '\r' || c == '\n' || c == 0x7f || (c < 0x20 && c != '\t') {
			return false
		}
	}
	return true
}

func isHTTPToken(value string) bool {
	if value == "" {
		return false
	}
	for _, c := range []byte(value) {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			continue
		}
		switch c {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
			continue
		default:
			return false
		}
	}
	return true
}

func headerAllowedByPolicy(name string, policy vendorregistry.EndpointPolicy) bool {
	allowed := false
	for _, candidate := range policy.AllowedRequestHeaderNames {
		if strings.EqualFold(candidate, name) {
			allowed = true
			break
		}
	}
	if !allowed {
		return false
	}
	for _, candidate := range policy.ForbiddenRequestHeaderNames {
		if strings.EqualFold(candidate, name) {
			return false
		}
	}
	return true
}

func resolveCredentialField(cred Credential, field string) (string, error) {
	switch strings.ToLower(field) {
	case "token", "bearertoken":
		if cred.BearerToken == "" {
			return "", NewPolicyError(ReasonCredentialUnavailable)
		}
		return cred.BearerToken, nil
	default:
		return "", NewPolicyError(ReasonRequestUnbuildable)
	}
}

func decodeJSONObject(payload []byte) (map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(payload))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, errors.New("payload is not a JSON object")
	}
	out := make(map[string]json.RawMessage)
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("invalid object key")
		}
		if _, duplicate := out[key]; duplicate {
			return nil, errors.New("duplicate object key")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		out[key] = raw
	}
	if tok, err = dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, errors.New("unterminated JSON object")
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing JSON value")
	}
	return out, nil
}

// HTTPRequest converts a BuiltRequest into an http.Request. The body is never
// nil so Content-Length is computed correctly.
func (b *BuiltRequest) HTTPRequest() (*http.Request, error) {
	req, err := http.NewRequest(b.Method, b.URL.String(), bytes.NewReader(b.Body))
	if err != nil {
		return nil, err
	}
	req.Header = b.Header
	req.Host = b.URL.Host
	return req, nil
}
