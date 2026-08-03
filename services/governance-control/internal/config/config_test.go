package config

import (
	"strconv"
	"strings"
	"testing"
)

const testDatabaseURL = "postgres://user:password@127.0.0.1:5432/governance_shadow?sslmode=disable"

func TestLoadEnvironmentAppliesClosedPrivateDefaults(t *testing.T) {
	configuration, err := LoadEnvironment([]string{
		"DATABASE_URL=" + testDatabaseURL,
		"GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	})
	if err != nil {
		t.Fatal(err)
	}
	if configuration.HTTPBind != "127.0.0.1:8080" || configuration.NetworkMode != NetworkLoopback ||
		configuration.MigrationSource != "/migrations" {
		t.Fatalf("configuration = %+v", configuration)
	}
}

func TestLoadEnvironmentEnablesOnlyExactLoopbackAuthorityBinding(t *testing.T) {
	configuration, err := LoadEnvironment([]string{
		"DATABASE_URL=" + testDatabaseURL,
		"GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"GOVERNANCE_AUTHORITY_MODE=local-qualification-v1",
		"GOVERNANCE_AUTHORITY_WORKSPACE_ID=workspace.demo",
		"GOVERNANCE_AUTHORITY_CALLER_ID=typescript:qoder-mcp",
		"GOVERNANCE_AUTHORITY_ROUTING_EPOCH=7",
		"GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS=true",
		"GOVERNANCE_AUTHORITY_DRAIN_EPOCHS=5,6",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !configuration.AuthorityEnabled || configuration.AuthorityWorkspaceID != "workspace.demo" ||
		configuration.AuthorityCallerID != "typescript:qoder-mcp" || configuration.AuthorityRoutingEpoch != 7 ||
		!configuration.AuthorityAcceptNewRecords || len(configuration.AuthorityDrainEpochs) != 2 {
		t.Fatalf("configuration = %+v", configuration)
	}
}

func TestLoadEnvironmentAllowsIsolatedInternalAuthorityQualification(t *testing.T) {
	configuration, err := LoadEnvironment([]string{
		"DATABASE_URL=" + testDatabaseURL,
		"GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"GOVERNANCE_NETWORK_MODE=internal", "GOVERNANCE_HTTP_BIND=:8080",
		"GOVERNANCE_AUTHORITY_MODE=local-qualification-v1",
		"GOVERNANCE_AUTHORITY_WORKSPACE_ID=workspace.demo",
		"GOVERNANCE_AUTHORITY_CALLER_ID=typescript:qoder-mcp",
		"GOVERNANCE_AUTHORITY_ROUTING_EPOCH=7",
	})
	if err != nil || !configuration.AuthorityEnabled || configuration.NetworkMode != NetworkInternal {
		t.Fatalf("configuration = %+v err=%v", configuration, err)
	}
}

func TestLoadEnvironmentRejectsUnknownOrDuplicateGovernanceConfiguration(t *testing.T) {
	for _, environment := range [][]string{
		{"DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "GOVERNANCE_UNKNOWN=1"},
		{"DATABASE_URL=" + testDatabaseURL, "DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
		{"DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_HTTP_BIND=0.0.0.0:8080", "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
		{"DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "GOVERNANCE_AUTHORITY_MODE=local-qualification-v1"},
		{"DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "GOVERNANCE_AUTHORITY_WORKSPACE_ID=workspace.demo"},
		{"DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "GOVERNANCE_AUTHORITY_MODE=local-qualification-v1", "GOVERNANCE_AUTHORITY_WORKSPACE_ID=workspace.demo", "GOVERNANCE_AUTHORITY_CALLER_ID=typescript:qoder-mcp", "GOVERNANCE_AUTHORITY_ROUTING_EPOCH=7", "GOVERNANCE_AUTHORITY_DRAIN_EPOCHS=7"},
		{"DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "GOVERNANCE_AUTHORITY_MODE=local-qualification-v1", "GOVERNANCE_AUTHORITY_WORKSPACE_ID=workspace.demo", "GOVERNANCE_AUTHORITY_CALLER_ID=typescript:qoder-mcp", "GOVERNANCE_AUTHORITY_ROUTING_EPOCH=7", "GOVERNANCE_AUTHORITY_DRAIN_EPOCHS=6,6"},
	} {
		if _, err := LoadEnvironment(environment); err == nil {
			t.Fatalf("accepted environment %v", environment)
		}
	}
}

func TestLoadEnvironmentBoundsAuthorityDrainEpochAllowlist(t *testing.T) {
	base := []string{
		"DATABASE_URL=" + testDatabaseURL,
		"GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"GOVERNANCE_AUTHORITY_MODE=local-qualification-v1",
		"GOVERNANCE_AUTHORITY_WORKSPACE_ID=workspace.demo",
		"GOVERNANCE_AUTHORITY_CALLER_ID=typescript:qoder-mcp",
		"GOVERNANCE_AUTHORITY_ROUTING_EPOCH=7",
	}
	drains := make([]string, MaxAuthorityDrainEpochs+1)
	for index := range drains {
		drains[index] = strconv.Itoa(1000 + index)
	}

	atLimit := append(append([]string(nil), base...), "GOVERNANCE_AUTHORITY_DRAIN_EPOCHS="+strings.Join(drains[:MaxAuthorityDrainEpochs], ","))
	configuration, err := LoadEnvironment(atLimit)
	if err != nil || len(configuration.AuthorityDrainEpochs) != MaxAuthorityDrainEpochs {
		t.Fatalf("at-limit authority drains = %d err=%v", len(configuration.AuthorityDrainEpochs), err)
	}

	overLimit := append(append([]string(nil), base...), "GOVERNANCE_AUTHORITY_DRAIN_EPOCHS="+strings.Join(drains, ","))
	if _, err := LoadEnvironment(overLimit); err == nil {
		t.Fatal("authority drain allowlist above the limit was accepted")
	}
}
