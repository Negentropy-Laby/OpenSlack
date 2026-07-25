package delivery

import (
	"bytes"
	"net/netip"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry"
)

func requestSnapshot() vendorregistry.DeliveryConfigSnapshot {
	return vendorregistry.DeliveryConfigSnapshot{
		ConfigSchemaVersion: 1,
		CanonicalURL:        "https://vendor.example/hook", Method: "POST", Hostname: "vendor.example", Port: 443,
		TransportAuthHeaders:       []vendorregistry.HeaderRule{{Kind: "literal", Name: "content-type", Value: "application/json"}},
		OutboundIdempotencyMapping: vendorregistry.OutboundIdempotencyMapping{Mode: "body_field", FieldName: "notification_id"},
		EndpointPolicy:             vendorregistry.EndpointPolicy{AllowedRequestHeaderNames: []string{"content-type"}, MaxRequestBodyBytes: 4096}, AuthStrategy: "bearer",
		TransportKind: "https_public", CredentialRef: &vendorregistry.CredentialRef{Scheme: "env", OpaqueHandle: "TOKEN"},
	}
}

func TestBuildRequestBearerAndBodyField(t *testing.T) {
	built, err := BuildRequest("n-1", "ingress-1", []byte(`{"hello":"world"}`), requestSnapshot(), Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
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
		if _, err := BuildRequest("n-1", "ingress-1", payload, requestSnapshot(), Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8")); err == nil {
			t.Fatalf("accepted payload %s", payload)
		}
	}
	s := requestSnapshot()
	s.TransportAuthHeaders[0].Value = "text/plain"
	if _, err := BuildRequest("n-1", "ingress-1", []byte(`{"a":1}`), s, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8")); err == nil {
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
		if _, err := BuildRequest("n-1", "ingress-1", []byte(`{"a":1}`), s, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8")); err == nil {
			t.Fatal("accepted invalid snapshot")
		}
	}
}

func TestBuildRequestMappingModesPreserveOrExtendBodyDeterministically(t *testing.T) {
	payload := []byte("raw-body\x00bytes")
	none := requestSnapshot()
	none.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{Mode: "none"}
	built, err := BuildRequest("n-stable", "ingress-stable", payload, none, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil || string(built.Body) != string(payload) {
		t.Fatalf("none mapping body=%q err=%v", built.Body, err)
	}

	header := requestSnapshot()
	header.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{Mode: "header", HeaderName: "x-idempotency-key"}
	header.EndpointPolicy.AllowedRequestHeaderNames = []string{"content-type", "x-idempotency-key"}
	built, err = BuildRequest("n-stable", "ingress-stable", payload, header, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil || string(built.Body) != string(payload) || built.Header.Get("X-Idempotency-Key") != "n-stable" {
		t.Fatalf("header mapping body=%q header=%q err=%v", built.Body, built.Header.Get("X-Idempotency-Key"), err)
	}

	bodyField := requestSnapshot()
	built1, err := BuildRequest("n-stable", "ingress-stable", []byte(`{"a":1}`), bodyField, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil {
		t.Fatal(err)
	}
	built2, err := BuildRequest("n-stable", "ingress-stable", []byte(`{"a":1}`), bodyField, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil || string(built1.Body) != string(built2.Body) || strings.Count(string(built1.Body), "notification_id") != 1 {
		t.Fatalf("body-field mapping body1=%s body2=%s err=%v", built1.Body, built2.Body, err)
	}
}

func TestBuildRequestSchemaV2IngressHeadersPreserveExactBody(t *testing.T) {
	payload := []byte("raw-body\x00not-json\n")
	snapshot := requestSnapshot()
	snapshot.ConfigSchemaVersion = 2
	snapshot.AuthStrategy = "none"
	snapshot.CredentialRef = nil
	snapshot.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{
		Mode:        "headers",
		Source:      "ingress_idempotency_key",
		HeaderNames: []string{"idempotency-key", "x-openslack-idempotency-key"},
	}
	snapshot.EndpointPolicy.AllowedRequestHeaderNames = []string{
		"content-type", "idempotency-key", "x-openslack-idempotency-key",
	}

	built, err := BuildRequest("notification-1", "ingress-1", payload, snapshot, Credential{}, netip.MustParseAddr("8.8.8.8"))
	if err != nil {
		t.Fatalf("build schema v2 request: %v", err)
	}
	if !bytes.Equal(built.Body, payload) {
		t.Fatalf("schema v2 body changed: got %q want %q", built.Body, payload)
	}
	if got := built.Header.Get("Idempotency-Key"); got != "ingress-1" {
		t.Fatalf("Idempotency-Key=%q", got)
	}
	if got := built.Header.Get("X-OpenSlack-Idempotency-Key"); got != "ingress-1" {
		t.Fatalf("X-OpenSlack-Idempotency-Key=%q", got)
	}
	if got := built.Header.Get("Authorization"); got != "" {
		t.Fatalf("auth none emitted Authorization=%q", got)
	}
}

func TestBuildRequestSchemaV2NotificationIDSource(t *testing.T) {
	snapshot := requestSnapshot()
	snapshot.ConfigSchemaVersion = 2
	snapshot.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{
		Mode: "headers", Source: "notification_id", HeaderNames: []string{"x-idempotency-key"},
	}
	snapshot.EndpointPolicy.AllowedRequestHeaderNames = []string{"content-type", "x-idempotency-key"}
	built, err := BuildRequest("notification-1", "ingress-1", []byte("exact"), snapshot, Credential{BearerToken: "secret"}, netip.MustParseAddr("8.8.8.8"))
	if err != nil {
		t.Fatal(err)
	}
	if got := built.Header.Get("X-Idempotency-Key"); got != "notification-1" {
		t.Fatalf("X-Idempotency-Key=%q", got)
	}
}

func TestBuildRequestRejectsInvalidSchemaV2Mappings(t *testing.T) {
	base := func() vendorregistry.DeliveryConfigSnapshot {
		snapshot := requestSnapshot()
		snapshot.ConfigSchemaVersion = 2
		snapshot.AuthStrategy = "none"
		snapshot.CredentialRef = nil
		snapshot.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{
			Mode: "headers", Source: "ingress_idempotency_key", HeaderNames: []string{"idempotency-key"},
		}
		snapshot.EndpointPolicy.AllowedRequestHeaderNames = []string{"content-type", "idempotency-key", "x-two", "x-three", "x-four", "x-five"}
		return snapshot
	}
	cases := map[string]func(*vendorregistry.DeliveryConfigSnapshot, *Credential, *string){
		"legacy header mode": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{Mode: "header", HeaderName: "idempotency-key"}
		},
		"body rewrite": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{Mode: "body_field", FieldName: "id"}
		},
		"uppercase header": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.OutboundIdempotencyMapping.HeaderNames = []string{"Idempotency-Key"}
		},
		"duplicate header": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.OutboundIdempotencyMapping.HeaderNames = []string{"idempotency-key", "idempotency-key"}
		},
		"no headers": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.OutboundIdempotencyMapping.HeaderNames = nil
		},
		"too many headers": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.OutboundIdempotencyMapping.HeaderNames = []string{"idempotency-key", "x-two", "x-three", "x-four", "x-five"}
		},
		"unknown source": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.OutboundIdempotencyMapping.Source = "payload"
		},
		"none with source": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.OutboundIdempotencyMapping = vendorregistry.OutboundIdempotencyMapping{Mode: "none", Source: "notification_id"}
		},
		"empty ingress source": func(_ *vendorregistry.DeliveryConfigSnapshot, _ *Credential, ingress *string) { *ingress = "" },
		"header not allowlisted": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.EndpointPolicy.AllowedRequestHeaderNames = []string{"content-type"}
		},
		"credential with none auth": func(s *vendorregistry.DeliveryConfigSnapshot, _ *Credential, _ *string) {
			s.CredentialRef = &vendorregistry.CredentialRef{Scheme: "env", OpaqueHandle: "TOKEN"}
		},
		"credential material with none auth": func(_ *vendorregistry.DeliveryConfigSnapshot, cred *Credential, _ *string) {
			cred.BearerToken = "secret"
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			snapshot := base()
			cred := Credential{}
			ingress := "ingress-1"
			mutate(&snapshot, &cred, &ingress)
			if _, err := BuildRequest("notification-1", ingress, []byte("exact"), snapshot, cred, netip.MustParseAddr("8.8.8.8")); err == nil {
				t.Fatal("accepted invalid schema v2 request")
			}
		})
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
		if _, err := BuildRequest("n-1", "ingress-1", []byte(`{"a":1}`), s, cred, netip.MustParseAddr("8.8.8.8")); err == nil {
			t.Fatal("accepted unsafe request mapping")
		}
	}
	if _, err := BuildRequest("n-1", "ingress-1", []byte(`{"a":1}`), requestSnapshot(), Credential{BearerToken: "secret"}, netip.Addr{}); err == nil {
		t.Fatal("accepted invalid pinned address")
	}
}
