package config

import (
	"strings"
	"testing"
)

const testBuildSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const testCursorSecret = "0123456789abcdefFEDCBA9876543210"
const testPreviousCursorSecret = "previous-0123456789abcdef-76543210"

func validEnvironment() []string {
	return []string{
		"DATABASE_URL=postgres://graph:secret@127.0.0.1:5432/graph?sslmode=disable",
		"GRAPH_QUERY_CURSOR_SECRET=" + testCursorSecret,
		"GRAPH_QUERY_CURSOR_SECRET_PREVIOUS=" + testPreviousCursorSecret,
		"GRAPH_SERVICE_BUILD_SHA=" + testBuildSHA,
	}
}

func TestLoadEnvironmentUsesFailClosedLoopbackDefaults(t *testing.T) {
	cfg, err := LoadEnvironment(validEnvironment())
	if err != nil {
		t.Fatalf("LoadEnvironment() error = %v", err)
	}
	if cfg.HTTPBind != "127.0.0.1:8080" || cfg.NetworkMode != NetworkLoopback {
		t.Fatalf("unexpected network defaults: %#v", cfg)
	}
	if cfg.MigrationSource != "/migrations" {
		t.Fatalf("MigrationSource = %q", cfg.MigrationSource)
	}
	if string(cfg.QueryCursorSecret) != testCursorSecret {
		t.Fatal("cursor secret changed")
	}
	if string(cfg.PreviousQueryCursorSecret) != testPreviousCursorSecret {
		t.Fatal("previous cursor secret changed")
	}
}

func TestLoadEnvironmentAllowsNoPreviousCursorSecret(t *testing.T) {
	environment := []string{}
	for _, entry := range validEnvironment() {
		if !strings.HasPrefix(entry, "GRAPH_QUERY_CURSOR_SECRET_PREVIOUS=") {
			environment = append(environment, entry)
		}
	}
	cfg, err := LoadEnvironment(environment)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.PreviousQueryCursorSecret) != 0 {
		t.Fatal("unexpected previous cursor secret")
	}
}

func TestLoadEnvironmentBindsOptionalCanaryRoutingEpoch(t *testing.T) {
	environment := append(validEnvironment(), "GRAPH_CANARY_ROUTING_EPOCH=41")
	cfg, err := LoadEnvironment(environment)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CanaryRoutingEpoch == nil || *cfg.CanaryRoutingEpoch != 41 {
		t.Fatalf("CanaryRoutingEpoch = %#v", cfg.CanaryRoutingEpoch)
	}
	cfg, err = LoadEnvironment(validEnvironment())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CanaryRoutingEpoch != nil {
		t.Fatalf("unexpected default CanaryRoutingEpoch = %#v", cfg.CanaryRoutingEpoch)
	}
}

func TestLoadEnvironmentBindsReadAuthorityEpochAndTenantTogether(t *testing.T) {
	environment := append(validEnvironment(),
		"GRAPH_READ_AUTHORITY_ROUTING_EPOCH=42",
		"GRAPH_READ_AUTHORITY_TENANT_ID=workspace-1",
	)
	cfg, err := LoadEnvironment(environment)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ReadAuthorityRoutingEpoch == nil || *cfg.ReadAuthorityRoutingEpoch != 42 ||
		cfg.ReadAuthorityTenantID != "workspace-1" {
		t.Fatalf("authority binding = %#v", cfg)
	}
	for _, incomplete := range [][]string{
		append(validEnvironment(), "GRAPH_READ_AUTHORITY_ROUTING_EPOCH=42"),
		append(validEnvironment(), "GRAPH_READ_AUTHORITY_TENANT_ID=workspace-1"),
	} {
		if _, err := LoadEnvironment(incomplete); err == nil {
			t.Fatal("incomplete authority binding was accepted")
		}
	}
}

func TestLoadEnvironmentAllowsExplicitInternalContainerBind(t *testing.T) {
	environment := append(validEnvironment(),
		"GRAPH_NETWORK_MODE=internal",
		"GRAPH_HTTP_BIND=10.0.0.4:8080",
		"MIGRATION_SOURCE=/opt/openslack/migrations",
	)
	cfg, err := LoadEnvironment(environment)
	if err != nil {
		t.Fatalf("LoadEnvironment() error = %v", err)
	}
	if cfg.NetworkMode != NetworkInternal || cfg.HTTPBind != "10.0.0.4:8080" {
		t.Fatalf("unexpected internal bind: %#v", cfg)
	}
}

func TestResolveHTTPBindReplacesInternalWildcardBeforeListen(t *testing.T) {
	resolverCalls := 0
	resolved, err := resolveHTTPBind(":8080", NetworkInternal, func(bind string) (string, error) {
		resolverCalls++
		if bind != ":8080" {
			t.Fatalf("resolver bind = %q", bind)
		}
		return "10.0.0.4:8080", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved != "10.0.0.4:8080" || resolverCalls != 1 {
		t.Fatalf("resolved/calls = %q/%d", resolved, resolverCalls)
	}
}

func TestLoadEnvironmentRejectsUnknownGraphVariablesAndDuplicates(t *testing.T) {
	tests := []struct {
		name string
		env  []string
		want string
	}{
		{
			name: "unknown graph setting",
			env:  append(validEnvironment(), "GRAPH_ALLOW_PUBLIC=true"),
			want: "unknown Organization Graph environment variable GRAPH_ALLOW_PUBLIC",
		},
		{
			name: "duplicate",
			env:  append(validEnvironment(), "GRAPH_SERVICE_BUILD_SHA="+testBuildSHA),
			want: "duplicate environment variable GRAPH_SERVICE_BUILD_SHA",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := LoadEnvironment(test.env)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("LoadEnvironment() error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestLoadEnvironmentRejectsUnsafeBindings(t *testing.T) {
	tests := []struct {
		name string
		mode string
		bind string
	}{
		{name: "wildcard loopback", mode: "loopback", bind: ":8080"},
		{name: "private loopback", mode: "loopback", bind: "10.0.0.4:8080"},
		{name: "hostname loopback", mode: "loopback", bind: "localhost:8080"},
		{name: "public internal", mode: "internal", bind: "8.8.8.8:8080"},
		{name: "localhost internal", mode: "internal", bind: "localhost:8080"},
		{name: "hostname internal", mode: "internal", bind: "graph.internal:8080"},
		{name: "service port name", mode: "loopback", bind: "127.0.0.1:http"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			environment := append(validEnvironment(),
				"GRAPH_NETWORK_MODE="+test.mode,
				"GRAPH_HTTP_BIND="+test.bind,
			)
			if _, err := LoadEnvironment(environment); err == nil {
				t.Fatalf("unsafe bind %q was accepted", test.bind)
			}
		})
	}
}

func TestLoadEnvironmentRejectsMissingOrMalformedSecretsAndIdentity(t *testing.T) {
	tests := []struct {
		name    string
		replace string
		value   string
	}{
		{name: "short cursor secret", replace: "GRAPH_QUERY_CURSOR_SECRET", value: "short"},
		{name: "short previous cursor secret", replace: "GRAPH_QUERY_CURSOR_SECRET_PREVIOUS", value: "short"},
		{name: "equal previous cursor secret", replace: "GRAPH_QUERY_CURSOR_SECRET_PREVIOUS", value: testCursorSecret},
		{name: "uppercase build sha", replace: "GRAPH_SERVICE_BUILD_SHA", value: strings.ToUpper(testBuildSHA)},
		{name: "relative migrations", replace: "MIGRATION_SOURCE", value: "migrations"},
		{name: "wrong database scheme", replace: "DATABASE_URL", value: "https://example.invalid/graph"},
		{name: "zero canary routing epoch", replace: "GRAPH_CANARY_ROUTING_EPOCH", value: "0"},
		{name: "noncanonical canary routing epoch", replace: "GRAPH_CANARY_ROUTING_EPOCH", value: "041"},
		{name: "whitespace canary routing epoch", replace: "GRAPH_CANARY_ROUTING_EPOCH", value: " 41 "},
		{name: "unsafe canary routing epoch", replace: "GRAPH_CANARY_ROUTING_EPOCH", value: "9007199254740992"},
		{name: "zero authority routing epoch", replace: "GRAPH_READ_AUTHORITY_ROUTING_EPOCH", value: "0"},
		{name: "noncanonical authority routing epoch", replace: "GRAPH_READ_AUTHORITY_ROUTING_EPOCH", value: "042"},
		{name: "unsafe authority tenant", replace: "GRAPH_READ_AUTHORITY_TENANT_ID", value: "workspace with space"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			environment := validEnvironment()
			replaced := false
			for index, entry := range environment {
				if strings.HasPrefix(entry, test.replace+"=") {
					environment[index] = test.replace + "=" + test.value
					replaced = true
				}
			}
			if !replaced {
				environment = append(environment, test.replace+"="+test.value)
			}
			if _, err := LoadEnvironment(environment); err == nil {
				t.Fatalf("invalid %s was accepted", test.replace)
			}
		})
	}
}

func TestLoadMigrationEnvironmentRequiresOnlyDatabaseAndAbsoluteSource(t *testing.T) {
	cfg, err := LoadMigrationEnvironment([]string{
		"DATABASE_URL=postgres://graph:secret@127.0.0.1:5432/graph",
		"MIGRATION_SOURCE=/opt/openslack/migrations",
	})
	if err != nil {
		t.Fatalf("LoadMigrationEnvironment() error = %v", err)
	}
	if cfg.MigrationSource != "/opt/openslack/migrations" {
		t.Fatalf("MigrationSource = %q", cfg.MigrationSource)
	}
}

func TestConfigDoesNotExposeCursorSecretThroughFormatting(t *testing.T) {
	cfg, err := LoadEnvironment(validEnvironment())
	if err != nil {
		t.Fatal(err)
	}
	rendered := strings.ReplaceAll(strings.TrimSpace(strings.Join([]string{
		cfg.DatabaseURL,
		cfg.HTTPBind,
		cfg.NetworkMode,
		cfg.ServiceBuildSHA,
		cfg.MigrationSource,
	}, " ")), "\n", " ")
	if strings.Contains(rendered, string(cfg.QueryCursorSecret)) {
		t.Fatal("test setup unexpectedly included cursor secret in non-secret fields")
	}
	if strings.Contains(rendered, string(cfg.PreviousQueryCursorSecret)) {
		t.Fatal("test setup unexpectedly included previous cursor secret in non-secret fields")
	}
}
