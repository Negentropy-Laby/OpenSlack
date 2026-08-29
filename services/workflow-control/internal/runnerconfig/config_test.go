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
	if config.HTTPBind != "127.0.0.1:8081" || config.NetworkMode != NetworkLoopback || config.MaxProcesses != 4 || config.LeaseDuration != time.Minute {
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

func TestLeaseDurationIsExplicitlyBounded(t *testing.T) {
	base := validEnvironment(t)
	configured := append(append([]string{}, base...), "WORKFLOW_RUNNER_CONTROL_LEASE_DURATION_MS=900000")
	config, err := LoadEnvironment(configured)
	if err != nil || config.LeaseDuration != 15*time.Minute {
		t.Fatalf("bounded lease duration rejected: %+v %v", config, err)
	}
	for _, value := range []string{"invalid", "9999", "86400001"} {
		candidate := append(append([]string{}, base...), "WORKFLOW_RUNNER_CONTROL_LEASE_DURATION_MS="+value)
		if _, err := LoadEnvironment(candidate); err == nil {
			t.Fatalf("invalid lease duration accepted: %q", value)
		}
	}
}

func TestV2QualificationIsDefaultOffAndRequiresExactEnablement(t *testing.T) {
	base := validEnvironment(t)
	config, err := LoadEnvironment(base)
	if err != nil {
		t.Fatal(err)
	}
	if config.V2QualificationEnabled {
		t.Fatal("v2 qualification was not default-off")
	}
	enabled := append(append([]string{}, base...), "WORKFLOW_RUNNER_CONTROL_V2_QUALIFICATION_ENABLED=1")
	config, err = LoadEnvironment(enabled)
	if err != nil || !config.V2QualificationEnabled {
		t.Fatalf("exact v2 qualification enablement rejected: %+v %v", config, err)
	}
	for _, value := range []string{"0", "true", "yes", " 1", "1 "} {
		candidate := append(append([]string{}, base...), "WORKFLOW_RUNNER_CONTROL_V2_QUALIFICATION_ENABLED="+value)
		if _, err := LoadEnvironment(candidate); err == nil {
			t.Fatalf("non-exact v2 enablement accepted: %q", value)
		}
	}
}

func TestV2RuntimeDeliveryConfigurationIsSealedAndDefaultOff(t *testing.T) {
	base := validEnvironment(t)
	workspace := strings.TrimPrefix(firstEnvironment(base, "WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT"), "WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT=")
	token := strings.Repeat("r", 40)
	digest := sha256.Sum256([]byte(token))
	for index := range base {
		if strings.HasPrefix(base[index], "WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN_SHA256=") {
			base[index] = fmt.Sprintf("WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN_SHA256=%x", digest[:])
		}
	}
	runtimeValues := []string{
		"WORKFLOW_RUNNER_CONTROL_V2_QUALIFICATION_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ORIGIN=http://127.0.0.1:8081",
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_BEARER_TOKEN=" + token,
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_JOURNAL_ROOT=" + filepath.Join(workspace, ".openslack.local", "workflow-runner-v2-runtime-delivery"),
		"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_ORIGIN=http://127.0.0.1:8085",
		"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_BEARER_TOKEN=" + strings.Repeat("e", 40),
		"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_CALLER_ID=runner-control",
	}
	config, err := LoadEnvironment(append(append([]string{}, base...), runtimeValues...))
	if err != nil || !config.V2RuntimeDeliveryEnabled || config.V2RuntimeDeliveryBearerToken != token {
		t.Fatalf("sealed runtime config rejected: %+v %v", config, err)
	}
	if _, err := LoadEnvironment(append(append([]string{}, base...), runtimeValues[2:]...)); err == nil {
		t.Fatal("disabled runtime accepted credential-bearing configuration")
	}
	for _, replacement := range []string{
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ORIGIN=http://localhost:8081",
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_BEARER_TOKEN=" + strings.Repeat("x", 40),
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_JOURNAL_ROOT=" + workspace,
		"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_ORIGIN=https://127.0.0.1:8085",
		"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_BEARER_TOKEN=short",
		"WORKFLOW_RUNNER_CONTROL_V2_BUDGET_CALLER_ID=invalid caller",
	} {
		candidate := append(append([]string{}, base...), runtimeValues...)
		name, _, _ := strings.Cut(replacement, "=")
		for index := range candidate {
			if strings.HasPrefix(candidate[index], name+"=") {
				candidate[index] = replacement
			}
		}
		if _, err := LoadEnvironment(candidate); err == nil {
			t.Fatalf("invalid sealed runtime config accepted: %s", replacement)
		}
	}
	withoutQualification := append(append([]string{}, base...), runtimeValues[1:]...)
	if _, err := LoadEnvironment(withoutQualification); err == nil {
		t.Fatal("runtime delivery was enabled without v2 qualification")
	}
	internal := append(append([]string{}, base...), runtimeValues...)
	internal = append(internal, "WORKFLOW_RUNNER_CONTROL_NETWORK_MODE=internal")
	if _, err := LoadEnvironment(internal); err == nil {
		t.Fatal("runtime delivery was enabled outside loopback network mode")
	}

	authorityToken := strings.Repeat("a", 40)
	authorityDigest := sha256.Sum256([]byte(authorityToken))
	authorityValues := []string{
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_ORIGIN=http://127.0.0.1:8082",
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_BEARER_TOKEN=" + authorityToken,
		fmt.Sprintf("WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_BEARER_SHA256=%x", authorityDigest[:]),
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_CALLER_ID=workflow-runner-v2",
		"WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_BUILD_SHA=" + strings.Repeat("d", 64),
	}
	canaryValues := append(append([]string{}, runtimeValues...), authorityValues...)
	config, err = LoadEnvironment(append(append([]string{}, base...), canaryValues...))
	if err != nil || !config.V2RunAuthorityEnabled || config.V2RunAuthorityRuntime() == nil {
		t.Fatalf("sealed run authority rejected: %+v %v", config, err)
	}
	if _, err := LoadEnvironment(append(append([]string{}, base...), authorityValues...)); err == nil {
		t.Fatal("run authority was enabled without v2 runtime delivery")
	}
	badAuthorityHash := append(append([]string{}, base...), canaryValues...)
	for index := range badAuthorityHash {
		if strings.HasPrefix(badAuthorityHash[index], "WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_BEARER_SHA256=") {
			badAuthorityHash[index] = "WORKFLOW_RUNNER_CONTROL_V2_RUN_AUTHORITY_BEARER_SHA256=" + strings.Repeat("0", 64)
		}
	}
	if _, err := LoadEnvironment(badAuthorityHash); err == nil {
		t.Fatal("mismatched run authority bearer hash was accepted")
	}
}

func firstEnvironment(environment []string, name string) string {
	for _, entry := range environment {
		if strings.HasPrefix(entry, name+"=") {
			return entry
		}
	}
	return ""
}

func TestCheckpointShadowRunnerConfigIsExplicitAndClosed(t *testing.T) {
	base := validEnvironment(t)
	config, err := LoadEnvironment(base)
	if err != nil {
		t.Fatal(err)
	}
	if config.CheckpointShadowEnabled || config.CheckpointShadowBearerToken != "" {
		t.Fatal("checkpoint shadow was not default-off")
	}
	workspace := ""
	for _, entry := range base {
		if strings.HasPrefix(entry, "WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT=") {
			workspace = strings.TrimPrefix(entry, "WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT=")
		}
	}
	journal := filepath.Join(workspace, ".openslack.local", "workflow-checkpoint-shadow")
	token := strings.Repeat("t", 32)
	enabled := append(append([]string{}, base...), "WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_ENABLED=1", "WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_ENDPOINT=http://127.0.0.1:8083/v1/shadow/workflow-control/checkpoints", "WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_BEARER_TOKEN="+token, "WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_CALLER_ID=runner-control", "WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_JOURNAL_ROOT="+journal)
	config, err = LoadEnvironment(enabled)
	if err != nil {
		t.Fatal(err)
	}
	if !config.CheckpointShadowEnabled || config.CheckpointShadowBearerToken != token {
		t.Fatal("checkpoint shadow runtime config was not preserved")
	}
	for _, entry := range []string{"WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_ENDPOINT=http://127.0.0.1:8083/v1/shadow/workflow-control/checkpoints", "WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_ENABLED=yes", "WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_ENABLED=1", "WORKFLOW_RUNNER_CONTROL_CHECKPOINT_SHADOW_ENABLED=1"} {
		candidate := append([]string{}, base...)
		candidate = append(candidate, entry)
		if _, err := LoadEnvironment(candidate); err == nil {
			t.Fatalf("invalid checkpoint config accepted: %s", entry)
		}
	}
}

func TestEffectShadowRunnerConfigIsExplicitAndClosed(t *testing.T) {
	base := validEnvironment(t)
	config, err := LoadEnvironment(base)
	if err != nil {
		t.Fatal(err)
	}
	if config.EffectShadowEnabled || config.EffectShadowBearerToken != "" {
		t.Fatal("effect shadow was not default-off")
	}
	workspace := ""
	for _, entry := range base {
		if strings.HasPrefix(entry, "WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT=") {
			workspace = strings.TrimPrefix(entry, "WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT=")
		}
	}
	journal := filepath.Join(workspace, ".openslack.local", "workflow-effect-shadow")
	token := strings.Repeat("e", 32)
	enabled := append(append([]string{}, base...),
		"WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_ENABLED=1",
		"WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_ENDPOINT=http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events",
		"WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_BEARER_TOKEN="+token,
		"WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_CALLER_ID=runner-control",
		"WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_JOURNAL_ROOT="+journal,
	)
	config, err = LoadEnvironment(enabled)
	if err != nil {
		t.Fatal(err)
	}
	if !config.EffectShadowEnabled || config.EffectShadowBearerToken != token || config.EffectShadowJournalRoot != journal {
		t.Fatal("effect shadow runtime config was not preserved")
	}
	for _, entry := range []string{
		"WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_ENDPOINT=http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events",
		"WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_ENABLED=yes",
		"WORKFLOW_RUNNER_CONTROL_EFFECT_SHADOW_ENABLED=1",
	} {
		candidate := append(append([]string{}, base...), entry)
		if _, err := LoadEnvironment(candidate); err == nil {
			t.Fatalf("invalid effect config accepted: %s", entry)
		}
	}
}
