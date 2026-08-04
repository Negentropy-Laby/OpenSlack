package runnerconfig

import (
	"path/filepath"
	"strings"
	"testing"
)

func validEnvironment(t *testing.T) []string {
	t.Helper()
	root := filepath.Clean(t.TempDir())
	return []string{
		"DATABASE_URL=postgres://runner:secret@127.0.0.1:5432/runner?sslmode=disable",
		"WORKFLOW_RUNNER_CONTROL_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_SERVICE_BUILD_SHA=" + strings.Repeat("a", 64),
		"WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN_SHA256=" + strings.Repeat("b", 64),
		"WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID=workspace.test",
		"WORKFLOW_RUNNER_CONTROL_INSTANCE_ID=runner.test",
		"WORKFLOW_RUNNER_CONTROL_BUNDLE_ROOT=" + root,
		"WORKFLOW_RUNNER_CONTROL_BUNDLE_MANIFEST_SHA256=" + strings.Repeat("c", 64),
		"WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT=" + root,
		"WORKFLOW_RUNNER_CONTROL_DESCRIPTOR_ROOT=" + root,
	}
}

func TestLoadEnvironmentRequiresExplicitEnablementAndClosedPrivateConfig(t *testing.T) {
	environment := validEnvironment(t)
	config, err := LoadEnvironment(environment)
	if err != nil {
		t.Fatalf("LoadEnvironment: %v", err)
	}
	if config.HTTPBind != "127.0.0.1:8081" || config.NetworkMode != NetworkLoopback || config.MaxProcesses != 4 {
		t.Fatalf("unexpected defaults: %+v", config)
	}
	for _, mutation := range []struct {
		name  string
		entry string
	}{
		{"disabled", "WORKFLOW_RUNNER_CONTROL_ENABLED=0"},
		{"unknown", "WORKFLOW_RUNNER_CONTROL_COMMAND=/bin/sh"},
		{"public", "WORKFLOW_RUNNER_CONTROL_HTTP_BIND=8.8.8.8:8081"},
		{"raw secret", "WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN=secret"},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			candidate := append([]string{}, environment...)
			if mutation.name == "disabled" {
				for index := range candidate {
					if strings.HasPrefix(candidate[index], "WORKFLOW_RUNNER_CONTROL_ENABLED=") {
						candidate[index] = mutation.entry
					}
				}
			} else {
				candidate = append(candidate, mutation.entry)
			}
			if _, err := LoadEnvironment(candidate); err == nil {
				t.Fatal("expected closed configuration rejection")
			}
		})
	}
}
