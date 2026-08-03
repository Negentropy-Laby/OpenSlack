package config

import "testing"

const testBuild = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestLoadEnvironmentRequiresClosedPrivateConfiguration(t *testing.T) {
	environment := []string{
		"DATABASE_URL=postgres://user:pass@127.0.0.1:5432/openslack",
		"WORKFLOW_CONTROL_SERVICE_BUILD_SHA=" + testBuild,
	}
	value, err := LoadEnvironment(environment)
	if err != nil {
		t.Fatal(err)
	}
	if value.HTTPBind != "127.0.0.1:8080" || value.NetworkMode != NetworkLoopback || value.ServiceBuildSHA != testBuild {
		t.Fatalf("unexpected configuration: %+v", value)
	}
	for _, invalid := range [][]string{
		append(environment, "WORKFLOW_CONTROL_UNKNOWN=true"),
		{"DATABASE_URL=postgres://user:pass@127.0.0.1:5432/openslack", "WORKFLOW_CONTROL_SERVICE_BUILD_SHA=short"},
		append(environment, "WORKFLOW_CONTROL_HTTP_BIND=8.8.8.8:8080", "WORKFLOW_CONTROL_NETWORK_MODE=internal"),
		append(environment, "WORKFLOW_CONTROL_HTTP_BIND=localhost:8080"),
	} {
		if _, err := LoadEnvironment(invalid); err == nil {
			t.Fatalf("expected invalid environment to fail: %v", invalid)
		}
	}
}

func TestLoadMigrationRequiresPostgresAndAbsoluteSource(t *testing.T) {
	valid := []string{"DATABASE_URL=postgresql://user:pass@db:5432/openslack", "MIGRATION_SOURCE=/safe/migrations"}
	value, err := LoadMigrationEnvironment(valid)
	if err != nil {
		t.Fatal(err)
	}
	if value.MigrationDatabaseURL != "pgx5://user:pass@db:5432/openslack" || value.MigrationSource != "/safe/migrations" {
		t.Fatalf("unexpected migration configuration: %+v", value)
	}
	for _, invalid := range [][]string{
		{"DATABASE_URL=https://db.example/openslack"},
		{"DATABASE_URL=postgres://user:pass@db:5432/openslack", "MIGRATION_SOURCE=relative"},
		{"DATABASE_URL=postgres://user:pass@db:5432/openslack", "MIGRATION_DATABASE_URL=postgres://user:pass@db/openslack"},
	} {
		if _, err := LoadMigrationEnvironment(invalid); err == nil {
			t.Fatalf("expected invalid migration environment to fail: %v", invalid)
		}
	}
}
