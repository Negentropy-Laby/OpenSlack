package config

import (
	"strings"
	"testing"
)

func TestCheckpointShadowDefaultsDisabledOnLoopback(t *testing.T) {
	value, err := LoadCheckpointShadowEnvironment(nil)
	if err != nil {
		t.Fatal(err)
	}
	if value.QualificationMode || value.HTTPBind != "127.0.0.1:8083" || value.DatabaseURL != "" {
		t.Fatalf("unexpected default: %#v", value)
	}
}
func TestCheckpointShadowQualificationRequiresBindings(t *testing.T) {
	_, err := LoadCheckpointShadowEnvironment([]string{"WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=local-qualification-v1"})
	if err == nil {
		t.Fatal("missing bindings accepted")
	}
	hash := strings.Repeat("a", 64)
	value, err := LoadCheckpointShadowEnvironment([]string{"WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=local-qualification-v1", "DATABASE_URL=postgres://user:pass@localhost/db", "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_SERVICE_BUILD_SHA=" + hash, "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_BEARER_TOKEN_SHA256=" + hash, "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_WORKSPACE_ID=workspace", "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_CALLER_ID=caller"})
	if err != nil {
		t.Fatal(err)
	}
	if !value.QualificationMode {
		t.Fatal("qualification mode not enabled")
	}
}
