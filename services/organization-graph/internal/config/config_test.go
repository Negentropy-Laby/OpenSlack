package config

import (
	"strings"
	"testing"
)

const testBuildSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const testCursorSecret = "0123456789abcdefFEDCBA9876543210"

func validEnvironment() []string {
	return []string{
		"DATABASE_URL=postgres://graph:secret@127.0.0.1:5432/graph?sslmode=disable",
		"GRAPH_QUERY_CURSOR_SECRET=" + testCursorSecret,
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
}

func TestLoadEnvironmentAllowsExplicitInternalContainerBind(t *testing.T) {
	environment := append(validEnvironment(),
		"GRAPH_NETWORK_MODE=internal",
		"GRAPH_HTTP_BIND=:8080",
		"MIGRATION_SOURCE=/opt/openslack/migrations",
	)
	cfg, err := LoadEnvironment(environment)
	if err != nil {
		t.Fatalf("LoadEnvironment() error = %v", err)
	}
	if cfg.NetworkMode != NetworkInternal || cfg.HTTPBind != ":8080" {
		t.Fatalf("unexpected internal bind: %#v", cfg)
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
		{name: "public internal", mode: "internal", bind: "8.8.8.8:8080"},
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
		{name: "uppercase build sha", replace: "GRAPH_SERVICE_BUILD_SHA", value: strings.ToUpper(testBuildSHA)},
		{name: "relative migrations", replace: "MIGRATION_SOURCE", value: "migrations"},
		{name: "wrong database scheme", replace: "DATABASE_URL", value: "https://example.invalid/graph"},
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
}
