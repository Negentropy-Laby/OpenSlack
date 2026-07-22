package vendorregistry

import (
	"context"
	"testing"
)

func TestLoadConfigFromEnvironmentRequiresCredentialPolicy(t *testing.T) {
	values := map[string]string{}
	getenv := func(key string) string { return values[key] }
	if _, err := LoadConfigFromEnvironment(getenv); err == nil {
		t.Fatal("missing credential policy was accepted")
	}
	values["CREDENTIAL_REF_SCHEME_ALLOWLIST"] = "env"
	values["CREDENTIAL_PROFILE_VALIDATOR"] = "bearer-env-v1"
	if _, err := LoadConfigFromEnvironment(getenv); err != nil {
		t.Fatalf("valid credential policy: %v", err)
	}
	values["CREDENTIAL_PROFILE_VALIDATOR"] = "unknown-profile"
	if _, err := LoadConfigFromEnvironment(getenv); err == nil {
		t.Fatal("unknown credential validator was accepted")
	}
}

func TestConfigGenerationPublicationIsAtomicAndPreflightsActiveEndpoints(t *testing.T) {
	repo := newFakeRepo()
	input := validRegisterInput().Body["initial_config"]
	var endpoint EndpointConfigInput
	if err := decodeStrict(input, &endpoint); err != nil {
		t.Fatal(err)
	}
	version, err := ValidateEndpointConfig(DefaultConfig(), endpoint)
	if err != nil {
		t.Fatal(err)
	}
	version.VendorID = "vendor-a"
	version.ConfigVersion = 1
	repo.vendors["vendor-a"] = VendorRecord{VendorID: "vendor-a", Lifecycle: LifecycleActive, CurrentConfigVersion: 1}
	repo.versions["vendor-a"] = map[int64]EndpointVersion{1: version}
	service, err := NewValidatedService(context.Background(), repo, DefaultConfig(), nil)
	if err != nil {
		t.Fatal(err)
	}

	invalid := DefaultConfig()
	invalid.CredentialProfileValidator = ""
	if err := service.PublishConfig(context.Background(), invalid); err == nil || service.ConfigGeneration() != 1 {
		t.Fatalf("invalid generation published: generation=%d err=%v", service.ConfigGeneration(), err)
	}

	tightened := DefaultConfig()
	tightened.EndpointMethodAllowlist = map[string]struct{}{"PUT": {}}
	if err := service.PublishConfig(context.Background(), tightened); err == nil || service.ConfigGeneration() != 1 {
		t.Fatalf("active endpoint tightening published: generation=%d err=%v", service.ConfigGeneration(), err)
	}

	expanded := DefaultConfig()
	expanded.EndpointMethodAllowlist["PUT"] = struct{}{}
	if err := service.PublishConfig(context.Background(), expanded); err != nil || service.ConfigGeneration() != 2 {
		t.Fatalf("valid generation not published: generation=%d err=%v", service.ConfigGeneration(), err)
	}
}
