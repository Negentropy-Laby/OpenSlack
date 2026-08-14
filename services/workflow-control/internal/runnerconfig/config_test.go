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
