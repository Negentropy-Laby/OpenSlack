package vendorregistry

import (
	"strings"
	"testing"
)

func slicePointer[T any](values []T) *[]T {
	return &values
}

func validEndpointInput() EndpointConfigInput {
	return EndpointConfigInput{
		EndpointTarget: EndpointTargetInput{URL: "https://example.com/webhook"},
		Method:         "POST",
		TransportAuthHeaders: slicePointer([]HeaderRuleInput{
			{Kind: "literal", Name: "content-type", Value: "application/json"},
		}),
		OutboundIdempotencyMapping: OutboundIdempotencyMapping{Mode: "none"},
		EndpointPolicy: EndpointPolicyInput{
			AllowedRequestHeaderNames:   slicePointer([]string{"content-type"}),
			ForbiddenRequestHeaderNames: slicePointer([]string{}),
			MaxRequestBodyBytes:         65536,
		},
		AuthStrategy:  "bearer",
		CredentialRef: &CredentialRefInput{Scheme: "env", OpaqueHandle: "VENDOR_A_TOKEN", ReferenceVersion: "v1"},
	}
}

func TestNormalizeURL_HTTPSOnly(t *testing.T) {
	canonical, hostname, port, err := NormalizeURL("https://example.com/webhook")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if hostname != "example.com" {
		t.Fatalf("hostname = %s, want example.com", hostname)
	}
	if port != 443 {
		t.Fatalf("port = %d, want 443", port)
	}
	if canonical != "https://example.com/webhook" {
		t.Fatalf("canonical = %s, want https://example.com/webhook", canonical)
	}
}

func TestNormalizeURL_RejectsHTTP(t *testing.T) {
	_, _, _, err := NormalizeURL("http://example.com/webhook")
	if err == nil {
		t.Fatal("expected http to be rejected")
	}
}

func TestNormalizeURL_RejectsUserinfo(t *testing.T) {
	_, _, _, err := NormalizeURL("https://user:pass@example.com/webhook")
	if err == nil {
		t.Fatal("expected userinfo to be rejected")
	}
}

func TestNormalizeURL_CanonicalizesHostAndRejectsInvalidFQDN(t *testing.T) {
	canonical, hostname, _, err := NormalizeURL("https://API.Example.COM/webhook")
	if err != nil || canonical != "https://api.example.com/webhook" || hostname != "api.example.com" {
		t.Fatalf("canonicalization = %q %q %v", canonical, hostname, err)
	}
	for _, raw := range []string{
		"https://localhost/webhook",
		"https://-bad.example/webhook",
		"https://bad-.example/webhook",
		"https://127.0.0.1/webhook",
		"https://*.example.com/webhook",
		"https://example.com/webhook#fragment",
	} {
		if _, _, _, err := NormalizeURL(raw); err == nil {
			t.Fatalf("accepted invalid endpoint %q", raw)
		}
	}
}

func TestValidateEndpointConfig_Valid(t *testing.T) {
	cfg := DefaultConfig()
	input := EndpointConfigInput{
		EndpointTarget: EndpointTargetInput{
			URL: "https://example.com/webhook",
		},
		Method: "POST",
		TransportAuthHeaders: slicePointer([]HeaderRuleInput{
			{Kind: "literal", Name: "content-type", Value: "application/json"},
		}),
		OutboundIdempotencyMapping: OutboundIdempotencyMapping{Mode: "none"},
		EndpointPolicy: EndpointPolicyInput{
			AllowedRequestHeaderNames:   slicePointer([]string{"content-type"}),
			ForbiddenRequestHeaderNames: slicePointer([]string{}),
			MaxRequestBodyBytes:         65536,
		},
		AuthStrategy:  "bearer",
		CredentialRef: &CredentialRefInput{Scheme: "env", OpaqueHandle: "VENDOR_A_TOKEN", ReferenceVersion: "v1"},
	}
	version, err := ValidateEndpointConfig(cfg, input)
	if err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	if version.Hostname != "example.com" {
		t.Fatalf("hostname = %s, want example.com", version.Hostname)
	}
	if version.TransportKind != "https_public" {
		t.Fatalf("transport kind = %s, want https_public", version.TransportKind)
	}
	if version.CredentialRef.OpaqueHandle != "VENDOR_A_TOKEN" {
		t.Fatalf("credential handle lost")
	}
	if version.ConfigSchemaVersion != ConfigSchemaVersionV1 || version.ResponsePolicy != ResponsePolicyHTTPStatusV1 {
		t.Fatalf("legacy defaults changed: schema=%d response=%q", version.ConfigSchemaVersion, version.ResponsePolicy)
	}
}

func TestValidateEndpointConfig_SchemaV2FrozenMatrix(t *testing.T) {
	bearer := validEndpointInput()
	bearer.ConfigSchemaVersion = ConfigSchemaVersionV2
	bearer.ResponsePolicy = ResponsePolicyJSONAckV1
	version, err := ValidateEndpointConfig(DefaultConfig(), bearer)
	if err != nil || version.ConfigSchemaVersion != 2 || version.ResponsePolicy != ResponsePolicyJSONAckV1 || version.CredentialRef == nil {
		t.Fatalf("valid v2 bearer rejected or drifted: version=%+v err=%v", version, err)
	}

	none := validEndpointInput()
	none.ConfigSchemaVersion = ConfigSchemaVersionV2
	none.ResponsePolicy = ResponsePolicyHTTPStatusV1
	none.AuthStrategy = "none"
	none.CredentialRef = nil
	none.OutboundIdempotencyMapping = OutboundIdempotencyMapping{
		Mode: "headers", Source: "ingress_idempotency_key", HeaderNames: []string{"idempotency-key", "x-openslack-idempotency-key"},
	}
	none.EndpointPolicy.AllowedRequestHeaderNames = slicePointer([]string{"content-type", "idempotency-key", "x-openslack-idempotency-key"})
	version, err = ValidateEndpointConfig(DefaultConfig(), none)
	if err != nil || version.AuthStrategy != "none" || version.CredentialRef != nil || len(version.OutboundIdempotencyMapping.HeaderNames) != 2 {
		t.Fatalf("valid v2 none rejected or drifted: version=%+v err=%v", version, err)
	}

	tests := []struct {
		name   string
		mutate func(*EndpointConfigInput)
	}{
		{name: "partial discriminator", mutate: func(v *EndpointConfigInput) { v.ResponsePolicy = "" }},
		{name: "explicit v1 is not v2 arm", mutate: func(v *EndpointConfigInput) { v.ConfigSchemaVersion = 1 }},
		{name: "credential with none", mutate: func(v *EndpointConfigInput) {
			v.CredentialRef = &CredentialRefInput{Scheme: "env", OpaqueHandle: "TOKEN"}
		}},
		{name: "credential header with none", mutate: func(v *EndpointConfigInput) {
			v.TransportAuthHeaders = slicePointer([]HeaderRuleInput{{Kind: "credential_field", Name: "authorization", CredentialField: "token"}})
			v.EndpointPolicy.AllowedRequestHeaderNames = slicePointer([]string{"authorization", "idempotency-key", "x-openslack-idempotency-key"})
		}},
		{name: "body rewrite", mutate: func(v *EndpointConfigInput) {
			v.OutboundIdempotencyMapping = OutboundIdempotencyMapping{Mode: "body_field", FieldName: "id"}
		}},
		{name: "uppercase mapping header", mutate: func(v *EndpointConfigInput) { v.OutboundIdempotencyMapping.HeaderNames[0] = "Idempotency-Key" }},
		{name: "duplicate mapping header", mutate: func(v *EndpointConfigInput) { v.OutboundIdempotencyMapping.HeaderNames[1] = "idempotency-key" }},
		{name: "too many mapping headers", mutate: func(v *EndpointConfigInput) {
			v.OutboundIdempotencyMapping.HeaderNames = []string{"x-one", "x-two", "x-three", "x-four", "x-five"}
		}},
		{name: "invalid mapping source", mutate: func(v *EndpointConfigInput) { v.OutboundIdempotencyMapping.Source = "payload" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidate := none
			candidate.OutboundIdempotencyMapping.HeaderNames = append([]string(nil), none.OutboundIdempotencyMapping.HeaderNames...)
			tt.mutate(&candidate)
			if _, err := ValidateEndpointConfig(DefaultConfig(), candidate); err == nil {
				t.Fatal("invalid v2 endpoint accepted")
			}
		})
	}
}

func TestValidateEndpointConfig_RejectsOmittedRequiredCollections(t *testing.T) {
	for name, omit := range map[string]func(*EndpointConfigInput){
		"transport_auth_headers": func(input *EndpointConfigInput) { input.TransportAuthHeaders = nil },
		"allowed_request_header_names": func(input *EndpointConfigInput) {
			input.EndpointPolicy.AllowedRequestHeaderNames = nil
		},
		"forbidden_request_header_names": func(input *EndpointConfigInput) {
			input.EndpointPolicy.ForbiddenRequestHeaderNames = nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			input := validEndpointInput()
			omit(&input)
			if _, err := ValidateEndpointConfig(DefaultConfig(), input); !IsAdminCommandError(err, ErrInvalidCommand) {
				t.Fatalf("got %v, want %s", err, ErrInvalidCommand)
			}
		})
	}
}

func TestValidateEndpointConfig_MVPRejectsNonBearer(t *testing.T) {
	for _, strategy := range []string{"hmac", "mTLS", "aws_sig_v4", "custom"} {
		headers := []HeaderRuleInput{}
		allowed := []string{}
		forbidden := []string{}
		input := EndpointConfigInput{
			EndpointTarget:             EndpointTargetInput{URL: "https://example.com/webhook"},
			Method:                     "POST",
			TransportAuthHeaders:       &headers,
			OutboundIdempotencyMapping: OutboundIdempotencyMapping{Mode: "none"},
			EndpointPolicy: EndpointPolicyInput{
				AllowedRequestHeaderNames: &allowed, ForbiddenRequestHeaderNames: &forbidden, MaxRequestBodyBytes: 65536,
			},
			AuthStrategy:  strategy,
			CredentialRef: &CredentialRefInput{Scheme: "env", OpaqueHandle: "TOKEN"},
		}
		if _, err := ValidateEndpointConfig(DefaultConfig(), input); !IsAdminCommandError(err, "INVALID_ENDPOINT_POLICY") {
			t.Fatalf("strategy %s: got %v", strategy, err)
		}
	}
}

func TestVendorRegistryConfigFailsClosed(t *testing.T) {
	for name, mutate := range map[string]func(*Config){
		"missing credential schemes": func(c *Config) { c.CredentialRefSchemeAllowlist = nil },
		"unknown method":             func(c *Config) { c.EndpointMethodAllowlist = map[string]struct{}{"DELETE": {}} },
		"authentication literal":     func(c *Config) { c.StaticHeaderNameAllowlist["authorization"] = struct{}{} },
		"invalid CIDR":               func(c *Config) { c.ForbiddenCIDRExceptionRanges = []string{"not-a-cidr"} },
		"invalid page limits":        func(c *Config) { c.ListPageDefault = 201 },
	} {
		t.Run(name, func(t *testing.T) {
			cfg := DefaultConfig()
			mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestValidateEndpointConfig_RejectsDisallowedPort(t *testing.T) {
	cfg := DefaultConfig()
	input := EndpointConfigInput{
		EndpointTarget:             EndpointTargetInput{URL: "https://example.com:8080/webhook"},
		Method:                     "POST",
		TransportAuthHeaders:       slicePointer([]HeaderRuleInput{}),
		OutboundIdempotencyMapping: OutboundIdempotencyMapping{Mode: "none"},
		EndpointPolicy: EndpointPolicyInput{
			AllowedRequestHeaderNames:   slicePointer([]string{}),
			ForbiddenRequestHeaderNames: slicePointer([]string{}),
			MaxRequestBodyBytes:         65536,
		},
		AuthStrategy:  "bearer",
		CredentialRef: &CredentialRefInput{Scheme: "env", OpaqueHandle: "TOKEN"},
	}
	if _, err := ValidateEndpointConfig(cfg, input); err == nil {
		t.Fatal("expected disallowed port to be rejected")
	}
}

func TestValidateEndpointConfig_RejectsForbiddenHeader(t *testing.T) {
	cfg := DefaultConfig()
	input := EndpointConfigInput{
		EndpointTarget: EndpointTargetInput{URL: "https://example.com/webhook"},
		Method:         "POST",
		TransportAuthHeaders: slicePointer([]HeaderRuleInput{
			{Kind: "literal", Name: "x-secret", Value: "shh"},
		}),
		OutboundIdempotencyMapping: OutboundIdempotencyMapping{Mode: "none"},
		EndpointPolicy: EndpointPolicyInput{
			AllowedRequestHeaderNames:   slicePointer([]string{"content-type"}),
			ForbiddenRequestHeaderNames: slicePointer([]string{}),
			MaxRequestBodyBytes:         65536,
		},
		AuthStrategy:  "bearer",
		CredentialRef: &CredentialRefInput{Scheme: "env", OpaqueHandle: "TOKEN"},
	}
	if _, err := ValidateEndpointConfig(cfg, input); err == nil {
		t.Fatal("expected header not in allowed set to be rejected")
	}
}

func TestValidateEndpointConfig_PrivateCIDRIsCanonicalAndBoundToAuthority(t *testing.T) {
	input := validEndpointInput()
	input.EndpointTarget.URL = "https://internal.example.com/webhook"
	input.EndpointTarget.PrivateNetworkException = &PrivateNetworkExceptionInput{
		Hostname: "internal.example.com", Port: 443, CIDR: "10.20.0.0/16",
	}
	version, err := ValidateEndpointConfig(DefaultConfig(), input)
	if err != nil || version.TransportKind != "https_private" {
		t.Fatalf("valid private exception: version=%+v err=%v", version, err)
	}

	for _, mutate := range []func(*EndpointConfigInput){
		func(v *EndpointConfigInput) { v.EndpointTarget.PrivateNetworkException.CIDR = "10.20.0.5/16" },
		func(v *EndpointConfigInput) { v.EndpointTarget.PrivateNetworkException.CIDR = "127.0.0.0/24" },
		func(v *EndpointConfigInput) { v.EndpointTarget.PrivateNetworkException.Hostname = "other.example.com" },
	} {
		candidate := input
		exceptionCopy := *input.EndpointTarget.PrivateNetworkException
		candidate.EndpointTarget.PrivateNetworkException = &exceptionCopy
		mutate(&candidate)
		if _, err := ValidateEndpointConfig(DefaultConfig(), candidate); !IsAdminCommandError(err, ErrInvalidEndpointPolicy) {
			t.Fatalf("invalid private exception returned %v", err)
		}
	}
}

func TestValidateEndpointConfig_RejectsHeaderAndMappingUnionDrift(t *testing.T) {
	tests := []struct {
		name string
		edit func(*EndpointConfigInput)
		code string
	}{
		{"uppercase allowed header", func(v *EndpointConfigInput) {
			v.EndpointPolicy.AllowedRequestHeaderNames = slicePointer([]string{"Content-Type"})
		}, ErrInvalidEndpointPolicy},
		{"duplicate allowed header", func(v *EndpointConfigInput) {
			v.EndpointPolicy.AllowedRequestHeaderNames = slicePointer([]string{"content-type", "content-type"})
		}, ErrInvalidEndpointPolicy},
		{"control in literal", func(v *EndpointConfigInput) { (*v.TransportAuthHeaders)[0].Value = "json\r\ninjected" }, ErrInvalidEndpointPolicy},
		{"literal with selector", func(v *EndpointConfigInput) { (*v.TransportAuthHeaders)[0].CredentialField = "token" }, ErrInvalidEndpointPolicy},
		{"credential with literal", func(v *EndpointConfigInput) {
			(*v.TransportAuthHeaders)[0] = HeaderRuleInput{Kind: "credential_field", Name: "content-type", CredentialField: "token", Value: "bad"}
		}, ErrInvalidEndpointPolicy},
		{"unsupported selector", func(v *EndpointConfigInput) {
			(*v.TransportAuthHeaders)[0] = HeaderRuleInput{Kind: "credential_field", Name: "content-type", CredentialField: "password"}
		}, ErrInvalidEndpointPolicy},
		{"none with header", func(v *EndpointConfigInput) { v.OutboundIdempotencyMapping.HeaderName = "x-idempotency-key" }, ErrInvalidCommand},
		{"v2 source on v1 input", func(v *EndpointConfigInput) { v.OutboundIdempotencyMapping.Source = "notification_id" }, ErrInvalidCommand},
		{"v2 headers on v1 input", func(v *EndpointConfigInput) { v.OutboundIdempotencyMapping.HeaderNames = []string{"x-idempotency-key"} }, ErrInvalidCommand},
		{"header with body field", func(v *EndpointConfigInput) {
			v.EndpointPolicy.AllowedRequestHeaderNames = slicePointer([]string{"content-type", "x-idempotency-key"})
			v.OutboundIdempotencyMapping = OutboundIdempotencyMapping{Mode: "header", HeaderName: "x-idempotency-key", FieldName: "id"}
		}, ErrInvalidCommand},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := validEndpointInput()
			headersCopy := append([]HeaderRuleInput(nil), (*input.TransportAuthHeaders)...)
			input.TransportAuthHeaders = &headersCopy
			tt.edit(&input)
			if _, err := ValidateEndpointConfig(DefaultConfig(), input); !IsAdminCommandError(err, tt.code) {
				t.Fatalf("got %v, want %s", err, tt.code)
			}
		})
	}

	input := validEndpointInput()
	input.TransportAuthHeaders = slicePointer(make([]HeaderRuleInput, 33))
	if _, err := ValidateEndpointConfig(DefaultConfig(), input); !IsAdminCommandError(err, ErrInvalidEndpointPolicy) {
		t.Fatalf("33 headers: %v", err)
	}
	input = validEndpointInput()
	input.EndpointPolicy.AllowedRequestHeaderNames = slicePointer(make([]string, 33))
	for i := range *input.EndpointPolicy.AllowedRequestHeaderNames {
		(*input.EndpointPolicy.AllowedRequestHeaderNames)[i] = "x-" + strings.Repeat("a", i+1)
	}
	if _, err := ValidateEndpointConfig(DefaultConfig(), input); !IsAdminCommandError(err, ErrInvalidEndpointPolicy) {
		t.Fatalf("33 allowed headers: %v", err)
	}
}

func TestValidateAdminCommand_ClosedOperationBodies(t *testing.T) {
	cases := []struct {
		op       string
		revision int64
		body     map[string]any
	}{
		{OpRegister, 0, map[string]any{"owning_scope": "team-a", "initial_config": map[string]any{}}},
		{OpUpdateVersion, 1, map[string]any{"replacement_policy": map[string]any{}}},
		{OpActivate, 1, map[string]any{}},
		{OpDisable, 1, map[string]any{"reason": "maintenance"}},
		{OpRotateCredentialRef, 1, map[string]any{"new_credential_ref": map[string]any{}}},
	}
	for _, tc := range cases {
		if err := ValidateAdminCommand(tc.op, "vendor-a", tc.revision, "idem-1", tc.body); err != nil {
			t.Fatalf("valid %s: %v", tc.op, err)
		}
		tc.body["unexpected"] = true
		if err := ValidateAdminCommand(tc.op, "vendor-a", tc.revision, "idem-1", tc.body); !IsAdminCommandError(err, ErrInvalidCommand) {
			t.Fatalf("%s unknown body field: %v", tc.op, err)
		}
	}
	if err := ValidateAdminCommand("unknown", "vendor-a", 1, "idem-1", map[string]any{}); !IsAdminCommandError(err, ErrInvalidCommand) {
		t.Fatalf("unknown operation: %v", err)
	}
}

func TestComputeFingerprint_Deterministic(t *testing.T) {
	secret := []byte("secret")
	body := map[string]any{"url": "https://example.com"}
	fp1 := ComputeFingerprint(secret, "register", "vendor-a", 0, body)
	fp2 := ComputeFingerprint(secret, "register", "vendor-a", 0, body)
	if string(fp1) != string(fp2) {
		t.Fatal("fingerprint should be deterministic")
	}
}

func TestComputeFingerprint_DifferentInputsDiffer(t *testing.T) {
	secret := []byte("secret")
	fp1 := ComputeFingerprint(secret, "register", "vendor-a", 0, map[string]any{"a": 1})
	fp2 := ComputeFingerprint(secret, "register", "vendor-b", 0, map[string]any{"a": 1})
	if string(fp1) == string(fp2) {
		t.Fatal("different vendor ids should produce different fingerprints")
	}
}

func TestSanitizedRequestDigest_Deterministic(t *testing.T) {
	d1 := SanitizedRequestDigest("register", "vendor-a", 0)
	d2 := SanitizedRequestDigest("register", "vendor-a", 0)
	if d1 != d2 {
		t.Fatal("sanitized digest should be deterministic")
	}
}

func TestValidateAdminCommand_RegisterExpectedRevision(t *testing.T) {
	if err := ValidateAdminCommand("register", "vendor-a", 1, "idem-1", map[string]any{"x": 1}); err == nil {
		t.Fatal("register with expected_revision != 0 should be rejected")
	}
}

func TestValidateAdminCommand_NonRegisterExpectedRevision(t *testing.T) {
	if err := ValidateAdminCommand("update_version", "vendor-a", 0, "idem-1", map[string]any{"x": 1}); err == nil {
		t.Fatal("non-register with expected_revision < 1 should be rejected")
	}
}

func TestVendorScope_CoversVendorID(t *testing.T) {
	s := VendorScope{Kind: "vendor_ids", VendorIDs: []string{"vendor-a"}}
	if !s.CoversVendorID("vendor-a") {
		t.Fatal("expected vendor-a to be covered")
	}
	if s.CoversVendorID("vendor-b") {
		t.Fatal("expected vendor-b not to be covered")
	}
}

func TestVendorScope_CoversOwningScope(t *testing.T) {
	s := VendorScope{Kind: "owning_scopes", OwningScopes: []string{"team-a"}}
	if !s.CoversOwningScope("team-a") {
		t.Fatal("expected team-a to be covered")
	}
	if s.CoversOwningScope("team-b") {
		t.Fatal("expected team-b not to be covered")
	}
}
