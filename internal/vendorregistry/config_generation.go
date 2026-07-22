package vendorregistry

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// LoadConfigFromEnvironment loads one complete configuration generation. The
// two credential-policy values deliberately have no implicit production
// default; their omission fails startup closed.
func LoadConfigFromEnvironment(getenv func(string) string) (Config, error) {
	cfg := DefaultConfig()
	schemesValue := strings.TrimSpace(getenv("CREDENTIAL_REF_SCHEME_ALLOWLIST"))
	validator := strings.TrimSpace(getenv("CREDENTIAL_PROFILE_VALIDATOR"))
	if schemesValue == "" || validator == "" {
		return Config{}, errors.New("CREDENTIAL_REF_SCHEME_ALLOWLIST and CREDENTIAL_PROFILE_VALIDATOR are required")
	}
	cfg.CredentialRefSchemeAllowlist = make(map[string]struct{})
	for _, value := range strings.Split(schemesValue, ",") {
		scheme := strings.TrimSpace(value)
		if scheme == "" {
			return Config{}, errors.New("credential reference scheme list contains an empty member")
		}
		cfg.CredentialRefSchemeAllowlist[scheme] = struct{}{}
	}
	cfg.CredentialProfileValidator = validator
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// ConfigGeneration returns the currently published immutable generation.
func (s *Service) ConfigGeneration() uint64 {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfgGeneration
}

func (s *Service) currentConfig() Config {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return cloneConfig(s.cfg)
}

// PublishConfig performs an all-or-nothing candidate validation and active
// data preflight before atomically switching the generation. On any failure the
// old generation remains active.
func (s *Service) PublishConfig(ctx context.Context, candidate Config) error {
	if err := s.preflightConfig(ctx, candidate); err != nil {
		return err
	}
	s.cfgMu.Lock()
	s.cfg = cloneConfig(candidate)
	s.cfgGeneration++
	s.cfgMu.Unlock()
	return nil
}

func (s *Service) preflightConfig(ctx context.Context, candidate Config) error {
	if err := candidate.Validate(); err != nil {
		return fmt.Errorf("invalid vendor registry config generation: %w", err)
	}
	active, err := s.repo.ListActiveEndpointVersions(ctx)
	if err != nil {
		return fmt.Errorf("active endpoint preflight unavailable: %w", err)
	}
	for _, version := range active {
		if _, err := ValidateEndpointConfig(candidate, endpointVersionInput(version)); err != nil {
			return fmt.Errorf("active endpoint violates candidate generation: %w", err)
		}
	}
	return nil
}

func endpointVersionInput(version EndpointVersion) EndpointConfigInput {
	headers := make([]HeaderRuleInput, 0, len(version.TransportAuthHeaders))
	for _, header := range version.TransportAuthHeaders {
		headers = append(headers, HeaderRuleInput{Kind: header.Kind, Name: header.Name, Value: header.Value, CredentialField: header.CredentialField})
	}
	var private *PrivateNetworkExceptionInput
	if version.CIDRException != nil {
		private = &PrivateNetworkExceptionInput{Hostname: version.CIDRException.Hostname, Port: version.CIDRException.Port, CIDR: version.CIDRException.CIDR}
	}
	allowedHeaders := append([]string(nil), version.EndpointPolicy.AllowedRequestHeaderNames...)
	forbiddenHeaders := append([]string(nil), version.EndpointPolicy.ForbiddenRequestHeaderNames...)
	return EndpointConfigInput{
		EndpointTarget: EndpointTargetInput{URL: version.CanonicalURL, PrivateNetworkException: private},
		Method:         version.Method, TransportAuthHeaders: &headers,
		OutboundIdempotencyMapping: version.OutboundIdempotencyMapping,
		EndpointPolicy: EndpointPolicyInput{
			AllowedRequestHeaderNames:   &allowedHeaders,
			ForbiddenRequestHeaderNames: &forbiddenHeaders,
			MaxRequestBodyBytes:         version.EndpointPolicy.MaxRequestBodyBytes,
		},
		AuthStrategy:  version.AuthStrategy,
		CredentialRef: CredentialRefInput{Scheme: version.CredentialRef.Scheme, OpaqueHandle: version.CredentialRef.OpaqueHandle, ReferenceVersion: version.CredentialRef.ReferenceVersion},
	}
}

func cloneConfig(cfg Config) Config {
	cloneSet := func(input map[string]struct{}) map[string]struct{} {
		output := make(map[string]struct{}, len(input))
		for value := range input {
			output[value] = struct{}{}
		}
		return output
	}
	cfg.EndpointPortAllowlist = func() map[int]struct{} {
		output := make(map[int]struct{}, len(cfg.EndpointPortAllowlist))
		for value := range cfg.EndpointPortAllowlist {
			output[value] = struct{}{}
		}
		return output
	}()
	cfg.EndpointMethodAllowlist = cloneSet(cfg.EndpointMethodAllowlist)
	cfg.CredentialRefSchemeAllowlist = cloneSet(cfg.CredentialRefSchemeAllowlist)
	cfg.StaticHeaderNameAllowlist = cloneSet(cfg.StaticHeaderNameAllowlist)
	cfg.ForbiddenCIDRExceptionRanges = append([]string(nil), cfg.ForbiddenCIDRExceptionRanges...)
	return cfg
}
