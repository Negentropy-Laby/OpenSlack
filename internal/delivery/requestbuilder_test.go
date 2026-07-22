package delivery

import (
	"net/netip"
	"strings"
	"testing"

	"rc_wsman/internal/vendorregistry"
)

func requestSnapshot() vendorregistry.DeliveryConfigSnapshot {
	return vendorregistry.DeliveryConfigSnapshot{
		CanonicalURL: "https://vendor.example/hook", Method: "POST", Hostname: "vendor.example", Port: 443,
		TransportAuthHeaders:       []vendorregistry.HeaderRule{{Kind: "literal", Name: "content-type", Value: "application/json"}},
		OutboundIdempotencyMapping: vendorregistry.OutboundIdempotencyMapping{Mode: "body_field", FieldName: "notification_id"},
		EndpointPolicy:             vendorregistry.EndpointPolicy{AllowedRequestHeaderNames: []string{"content-type"}, MaxRequestBodyBytes: 4096}, AuthStrategy: "bearer",
		TransportKind: "https_public",
	}
}

func TestBuildRequestBearerAndBodyField(t *testing.T) {
	built, err := BuildRequest("n-1", []byte(`{"hello":"world"}`), requestSnapshot(), Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if built.Header.Get("Authorization") != "Bearer secret" {
		t.Fatal("missing bearer header")
	}
	if built.Header.Get("Host") != "" {
		t.Fatal("Host must not be a regular header")
	}
	if !strings.Contains(string(built.Body), `"notification_id":"n-1"`) {
		t.Fatalf("body: %s", built.Body)
	}
	req, err := built.HTTPRequest()
	if err != nil {
		t.Fatal(err)
	}
	if req.Host != "vendor.example" {
		t.Fatalf("host = %q", req.Host)
	}
}

func TestBuildRequestRejectsNonObjectDuplicateAndWrongContentType(t *testing.T) {
	for _, payload := range [][]byte{[]byte(`[]`), []byte(`"scalar"`), []byte(`{"a":1,"a":2}`)} {
		if _, err := BuildRequest("n-1", payload, requestSnapshot(), Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8")); err == nil {
			t.Fatalf("accepted payload %s", payload)
		}
	}
	s := requestSnapshot()
	s.TransportAuthHeaders[0].Value = "text/plain"
	if _, err := BuildRequest("n-1", []byte(`{"a":1}`), s, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8")); err == nil {
		t.Fatal("accepted body_field without JSON content type")
	}
}

func TestBuildRequestRejectsAuthorityAndAuthDrift(t *testing.T) {
	for _, mutate := range []func(*vendorregistry.DeliveryConfigSnapshot){
		func(s *vendorregistry.DeliveryConfigSnapshot) { s.Hostname = "other.example" },
		func(s *vendorregistry.DeliveryConfigSnapshot) { s.CanonicalURL = "http://vendor.example/hook" },
		func(s *vendorregistry.DeliveryConfigSnapshot) { s.AuthStrategy = "hmac" },
		func(s *vendorregistry.DeliveryConfigSnapshot) { s.Method = "GET" },
		func(s *vendorregistry.DeliveryConfigSnapshot) { s.TransportKind = "" },
		func(s *vendorregistry.DeliveryConfigSnapshot) { s.EndpointPolicy.MaxRequestBodyBytes = 0 },
		func(s *vendorregistry.DeliveryConfigSnapshot) { s.TransportAuthHeaders[0].Kind = "unknown" },
		func(s *vendorregistry.DeliveryConfigSnapshot) { s.TransportAuthHeaders[0].Name = "Host" },
	} {
		s := requestSnapshot()
		mutate(&s)
		if _, err := BuildRequest("n-1", []byte(`{"a":1}`), s, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8")); err == nil {
			t.Fatal("accepted invalid snapshot")
		}
	}
}

func TestBuildRequestMappingModesPreserveOrExtendBodyDeterministically(t *testing.T) {
	payload := []byte("raw-body\x00bytes")
	none := requestSnapshot()
	none.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{Mode: "none"}
	built, err := BuildRequest("n-stable", payload, none, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil || string(built.Body) != string(payload) {
		t.Fatalf("none mapping body=%q err=%v", built.Body, err)
	}

	header := requestSnapshot()
	header.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{Mode: "header", HeaderName: "x-idempotency-key"}
	header.EndpointPolicy.AllowedRequestHeaderNames = []string{"content-type", "x-idempotency-key"}
	built, err = BuildRequest("n-stable", payload, header, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil || string(built.Body) != string(payload) || built.Header.Get("X-Idempotency-Key") != "n-stable" {
		t.Fatalf("header mapping body=%q header=%q err=%v", built.Body, built.Header.Get("X-Idempotency-Key"), err)
	}

	bodyField := requestSnapshot()
	built1, err := BuildRequest("n-stable", []byte(`{"a":1}`), bodyField, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil {
		t.Fatal(err)
	}
	built2, err := BuildRequest("n-stable", []byte(`{"a":1}`), bodyField, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil || string(built1.Body) != string(built2.Body) || strings.Count(string(built1.Body), "notification_id") != 1 {
		t.Fatalf("body-field mapping body1=%s body2=%s err=%v", built1.Body, built2.Body, err)
	}
}

func TestBuildRequestRejectsHeaderInjectionDuplicatesAndFinalBodyOverflow(t *testing.T) {
	for _, mutate := range []func(*vendorregistry.DeliveryConfigSnapshot, *Credential){
		func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential) {
			s.TransportAuthHeaders[0].Value = "application/json\r\nX-Evil: yes"
		},
		func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential) {
			s.TransportAuthHeaders[0].Name = "bad header"
		},
		func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential) {
			s.TransportAuthHeaders = append(s.TransportAuthHeaders, s.TransportAuthHeaders[0])
		},
		func(_ *vendorregistry.DeliveryConfigSnapshot, c *Credential) { c.BearerToken = "secret\r\nX-Evil: yes" },
		func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential) {
			s.EndpointPolicy.MaxRequestBodyBytes = int64(len(`{"a":1}`))
		},
	} {
		s := requestSnapshot()
		cred := Credential{BearerToken: "secret"}
		mutate(&s, &cred)
		if _, err := BuildRequest("n-1", []byte(`{"a":1}`), s, cred, netip.MustParseAddr("8.8.8.8")); err == nil {
			t.Fatal("accepted unsafe request mapping")
		}
	}
	if _, err := BuildRequest("n-1", []byte(`{"a":1}`), requestSnapshot(), Credential{BearerToken: "secret"}, netip.Addr{}); err == nil {
		t.Fatal("accepted invalid pinned address")
	}
}
