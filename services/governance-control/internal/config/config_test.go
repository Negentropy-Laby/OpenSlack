package config

import "testing"

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

func TestLoadEnvironmentRejectsUnknownOrDuplicateGovernanceConfiguration(t *testing.T) {
	for _, environment := range [][]string{
		{"DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "GOVERNANCE_UNKNOWN=1"},
		{"DATABASE_URL=" + testDatabaseURL, "DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
		{"DATABASE_URL=" + testDatabaseURL, "GOVERNANCE_HTTP_BIND=0.0.0.0:8080", "GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
	} {
		if _, err := LoadEnvironment(environment); err == nil {
			t.Fatalf("accepted environment %v", environment)
		}
	}
}
