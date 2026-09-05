package runnerconfig

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func validEnvironment(t *testing.T) []string {
	t.Helper()
	root := filepath.Clean(t.TempDir())
	runtimeToken := strings.Repeat("r", 40)
	runtimeDigest := sha256.Sum256([]byte(runtimeToken))
	authorityToken := strings.Repeat("a", 40)
	authorityDigest := sha256.Sum256([]byte(authorityToken))
	return []string{
		"DATABASE_URL=postgres://runner:secret@127.0.0.1:5432/runner?sslmode=disable",
		"WORKFLOW_RUNNER_CONTROL_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_SERVICE_BUILD_SHA=" + strings.Repeat("a", 64),
		fmt.Sprintf("WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN_SHA256=%x", runtimeDigest[:]),
		"WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID=workspace.test",
		"WORKFLOW_RUNNER_CONTROL_INSTANCE_ID=runner.test",
		"WORKFLOW_RUNNER_CONTROL_BUNDLE_ROOT=" + root,
		"WORKFLOW_RUNNER_CONTROL_BUNDLE_MANIFEST_SHA256=" + strings.Repeat("c", 64),
		"WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT=" + root,
		"WORKFLOW_RUNNER_CONTROL_DESCRIPTOR_ROOT=" + root,
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ORIGIN=http://127.0.0.1:8081",
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_BEARER_TOKEN=" + runtimeToken,
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_JOURNAL_ROOT=" + filepath.Join(root, ".openslack.local", "workflow-runner-v2-runtime-delivery"),
		"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_ORIGIN=http://127.0.0.1:8085",
		"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_BEARER_TOKEN=" + strings.Repeat("e", 40),
		"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_CALLER_ID=runner-control",
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_ORIGIN=http://127.0.0.1:8082",
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_BEARER_TOKEN=" + authorityToken,
		fmt.Sprintf("WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_BEARER_SHA256=%x", authorityDigest[:]),
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_CALLER_ID=workflow-runner-v2",
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_BUILD_SHA=" + strings.Repeat("d", 64),
	}
}

func replaceEnvironment(environment []string, name, value string) []string {
	result := append([]string(nil), environment...)
	for index := range result {
		if strings.HasPrefix(result[index], name+"=") {
			result[index] = name + "=" + value
			return result
		}
	}
	return append(result, name+"="+value)
}

func TestLoadEnvironmentRequiresClosedGoAuthorityV2Config(t *testing.T) {
	environment := validEnvironment(t)
	config, err := LoadEnvironment(environment)
	if err != nil {
		t.Fatalf("LoadEnvironment: %v", err)
	}
	if config.HTTPBind != "127.0.0.1:8081" || config.NetworkMode != NetworkLoopback || config.MaxProcesses != 4 || config.LeaseDuration != time.Minute {
		t.Fatalf("unexpected defaults: %+v", config)
	}
	if !config.V2RuntimeDeliveryEnabled || !config.V2RunAuthorityEnabled || config.V2RuntimeDeliveryRuntime() == nil || config.V2RunAuthorityRuntime() == nil {
		t.Fatal("complete Go-authority v2 profile was not retained")
	}

	for _, mutation := range []struct {
		name  string
		value string
	}{
		{"WORKFLOW_RUNNER_CONTROL_ENABLED", "0"},
		{"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ENABLED", "0"},
		{"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_ENABLED", "0"},
		{"WORKFLOW_RUNNER_CONTROL_NETWORK_MODE", "internal"},
		{"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ORIGIN", "http://localhost:8081"},
		{"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_JOURNAL_ROOT", filepath.Clean(t.TempDir())},
		{"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_BEARER_TOKEN", "short"},
		{"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_BEARER_SHA256", strings.Repeat("0", 64)},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			if _, err := LoadEnvironment(replaceEnvironment(environment, mutation.name, mutation.value)); err == nil {
				t.Fatalf("invalid Go-authority v2 configuration accepted: %s", mutation.name)
			}
		})
	}
}

func TestRetiredWorkerConfigurationIsRejected(t *testing.T) {
	base := validEnvironment(t)
	for _, entry := range []string{
		"WORKFLOW_RUNNER_CONTROL_V2_QUALIFICATION_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_COMMAND=/bin/sh",
	} {
		if _, err := LoadEnvironment(append(append([]string(nil), base...), entry)); err == nil {
			t.Fatalf("retired or unknown runner configuration accepted: %s", entry)
		}
	}
}

func TestLeaseDurationIsExplicitlyBounded(t *testing.T) {
	base := validEnvironment(t)
	config, err := LoadEnvironment(append(append([]string{}, base...), "WORKFLOW_RUNNER_CONTROL_LEASE_DURATION_MS=900000"))
	if err != nil || config.LeaseDuration != 15*time.Minute {
		t.Fatalf("bounded lease duration rejected: %+v %v", config, err)
	}
	for _, value := range []string{"invalid", "59999", "86400001"} {
		if _, err := LoadEnvironment(append(append([]string{}, base...), "WORKFLOW_RUNNER_CONTROL_LEASE_DURATION_MS="+value)); err == nil {
			t.Fatalf("invalid lease duration accepted: %q", value)
		}
	}
	for _, value := range []string{"60000", "86400000"} {
		if _, err := LoadEnvironment(append(append([]string{}, base...), "WORKFLOW_RUNNER_CONTROL_LEASE_DURATION_MS="+value)); err != nil {
			t.Fatalf("valid lease duration rejected: %q: %v", value, err)
		}
	}
}
