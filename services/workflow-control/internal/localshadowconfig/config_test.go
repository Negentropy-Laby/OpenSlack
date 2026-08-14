package localshadowconfig

import (
	"path/filepath"
	"testing"
)

func TestSharedLocalShadowConfigurationVectors(t *testing.T) {
	workspace := t.TempDir()
	localRoot := filepath.Join(workspace, ".openslack.local")
	journal := filepath.Join(localRoot, "workflow-effect-shadow")
	protected := []string{
		filepath.Join(localRoot, "workflows", "effect-approvals"),
		filepath.Join(localRoot, "workflows", "effect-authority"),
	}
	valid := []string{
		"http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events",
		"http://[::1]:8084/v1/shadow/workflow-control/effect-events",
	}
	for _, endpoint := range valid {
		if err := Validate(Options{WorkspaceRoot: workspace, JournalRoot: journal, Endpoint: endpoint, Routes: []string{"/v1/shadow/workflow-control/effect-events"}, ProtectedRoots: protected}); err != nil {
			t.Fatalf("valid endpoint %q: %v", endpoint, err)
		}
	}
	checkpointRoutes := []string{"/", "/v1/shadow/workflow-control/checkpoints"}
	for _, endpoint := range []string{"http://127.0.0.1:8085", "http://127.0.0.1:8085/v1/shadow/workflow-control/checkpoints"} {
		if err := Validate(Options{WorkspaceRoot: workspace, JournalRoot: filepath.Join(localRoot, "checkpoint-shadow"), Endpoint: endpoint, Routes: checkpointRoutes}); err != nil {
			t.Fatalf("valid checkpoint endpoint %q: %v", endpoint, err)
		}
	}

	invalidEndpoints := []string{
		"http://localhost:8084/v1/shadow/workflow-control/effect-events",
		"http://127.0.0.1:8084\\v1\\shadow\\workflow-control\\effect-events",
		"http://127.0.0.01:8084/v1/shadow/workflow-control/effect-events",
		"http://user@127.0.0.1:8084/v1/shadow/workflow-control/effect-events",
		"http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events?retry=1",
		"http://127.0.0.1:8084/v1/shadow/workflow-control/checkpoints",
	}
	for _, endpoint := range invalidEndpoints {
		if err := Validate(Options{WorkspaceRoot: workspace, JournalRoot: journal, Endpoint: endpoint, Routes: []string{"/v1/shadow/workflow-control/effect-events"}, ProtectedRoots: protected}); err == nil {
			t.Fatalf("invalid endpoint %q was accepted", endpoint)
		}
	}
	invalidRoots := []string{
		localRoot,
		workspace,
		filepath.Join(localRoot, "workflows"),
		filepath.Join(localRoot, "workflows", "effect-approvals", "shadow"),
		filepath.Join(localRoot, "workflows", "effect-authority"),
	}
	for _, root := range invalidRoots {
		if err := Validate(Options{WorkspaceRoot: workspace, JournalRoot: root, Endpoint: valid[0], Routes: []string{"/v1/shadow/workflow-control/effect-events"}, ProtectedRoots: protected}); err == nil {
			t.Fatalf("invalid journal root %q was accepted", root)
		}
	}
}
