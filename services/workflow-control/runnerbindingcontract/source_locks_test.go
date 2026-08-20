package runnerbindingcontract

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestSourceLocksMatchAuthoritativeFiles(t *testing.T) {
	t.Parallel()

	repositoryRoot := filepath.Clean(filepath.Join("..", "..", ".."))
	paths := map[string]string{
		"runnerV1Manifest":      "packages/workflows/contracts/workflow-runner/v1/manifest.json",
		"authorityV2Manifest":   "packages/workflows/contracts/workflow-control-authority/v2/manifest.json",
		"checkpointManifest":    "packages/workflows/contracts/workflow-checkpoint-shadow/v1/manifest.json",
		"effectControlManifest": "packages/workflows/contracts/workflow-effect-control/v1/manifest.json",
		"effectShadowManifest":  "packages/workflows/contracts/workflow-effect-shadow/v1/manifest.json",
		"budgetManifest":        "packages/workflows/contracts/workflow-budget-authority/v1/manifest.json",
		"migration7Up":          "services/workflow-control/migrations/000007_integrate_workflow_runner_v2.up.sql",
		"migration7Down":        "services/workflow-control/migrations/000007_integrate_workflow_runner_v2.down.sql",
	}
	locks := SourceLocks()
	if len(locks) != len(paths) {
		t.Fatalf("source lock count = %d, want %d", len(locks), len(paths))
	}
	for _, lock := range locks {
		path, ok := paths[lock.Name]
		if !ok {
			t.Fatalf("unknown source lock %q", lock.Name)
		}
		contents, err := os.ReadFile(filepath.Join(repositoryRoot, filepath.FromSlash(path)))
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		digest := sha256.Sum256(contents)
		if got := hex.EncodeToString(digest[:]); got != lock.SHA256 {
			t.Fatalf("%s sha256 = %s, want %s", path, got, lock.SHA256)
		}
		delete(paths, lock.Name)
	}
	if len(paths) != 0 {
		t.Fatalf("source locks missing paths: %v", paths)
	}
}
