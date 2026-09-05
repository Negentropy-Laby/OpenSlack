package workerregistry

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerconfig"
)

func TestSupervisorRejectsRetiredEnablementAndUsesOnlyGoAuthorityV2(t *testing.T) {
	for _, reserved := range []string{"OPENSLACK_WORKFLOW_RUNNER_ENABLED", "OPENSLACK_WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED"} {
		root, hash, runtimeConfig := writeBundle(t, func(value *Manifest) { value.FixedEnvironment = []string{reserved + "=1"} })
		if _, err := Load(root, hash, runtimeConfig); err == nil {
			t.Fatalf("manifest override %s was accepted", reserved)
		}
	}
	root, hash, runtimeConfig := writeBundle(t, nil)
	registry, err := Load(root, hash, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	environment := strings.Join(registry.command.Environment, "\n")
	if strings.Contains(environment, "OPENSLACK_WORKFLOW_RUNNER_ENABLED=") || strings.Contains(environment, "OPENSLACK_WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED=") {
		t.Fatalf("retired worker enablement leaked into the sealed environment: %s", environment)
	}
	if _, err := registry.NewSupervisor(); err != nil {
		t.Fatalf("construct sealed v2 supervisor: %v", err)
	}
}

func TestLoadRequiresCompleteGoAuthorityRuntime(t *testing.T) {
	root, hash, runtimeConfig := writeBundle(t, nil)
	runtimeConfig.V2RunAuthority = nil
	if _, err := Load(root, hash, runtimeConfig); err == nil {
		t.Fatal("worker registry accepted a missing Go run authority")
	}
	root, hash, runtimeConfig = writeBundle(t, nil)
	runtimeConfig.V2RuntimeDelivery = nil
	if _, err := Load(root, hash, runtimeConfig); err == nil {
		t.Fatal("worker registry accepted missing v2 runtime delivery")
	}
}

func TestV2RuntimeDeliveryEnvironmentIsReservedHashedAndV2Only(t *testing.T) {
	reserved := []string{
		"WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ENABLED",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ORIGIN",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_BEARER_TOKEN",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_BEARER_SHA256",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_JOURNAL_ROOT",
		"OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_ORIGIN",
		"OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_BEARER_TOKEN",
		"OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_CALLER_ID",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ORIGIN",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_TOKEN",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_SHA256",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_CALLER_ID",
		"OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BUILD_SHA",
	}
	for _, name := range reserved {
		root, hash, runtimeConfig := writeBundle(t, func(value *Manifest) { value.FixedEnvironment = []string{name + "=evil"} })
		if _, err := Load(root, hash, runtimeConfig); err == nil {
			t.Fatalf("manifest override %s was accepted", name)
		}
	}
	root, hash, runtimeConfig := writeBundle(t, nil)
	token := strings.Repeat("r", 40)
	digest := sha256.Sum256([]byte(token))
	runtimeConfig.V2RuntimeDelivery = &runnerconfig.V2RuntimeDeliveryRuntime{
		Origin: "http://127.0.0.1:8081", BearerToken: token,
		BearerSHA256: fmt.Sprintf("%x", digest[:]),
		JournalRoot:  filepath.Join(root, ".openslack.local", "workflow-runner-v2-runtime-delivery"),
		BudgetOrigin: "http://127.0.0.1:8085", BudgetToken: strings.Repeat("b", 40),
		BudgetCallerID: "runner-control",
	}
	authorityToken := strings.Repeat("a", 40)
	authorityDigest := sha256.Sum256([]byte(authorityToken))
	runtimeConfig.V2RunAuthority = &runnerconfig.V2RunAuthorityRuntime{
		Origin: "http://127.0.0.1:8082", BearerToken: authorityToken,
		BearerSHA256: fmt.Sprintf("%x", authorityDigest[:]), CallerID: "workflow-runner-v2",
		ExpectedBuild: strings.Repeat("d", 64),
	}
	registry, err := Load(root, hash, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	v2 := strings.Join(registry.command.Environment, "\n")
	for _, name := range reserved {
		if !strings.Contains(v2, name+"=") {
			t.Fatalf("v2 runtime supervisor missed %s", name)
		}
	}
}

func writeBundle(t *testing.T, mutate func(*Manifest)) (string, string, Runtime) {
	t.Helper()
	root := filepath.Clean(t.TempDir())
	executable := filepath.Join(root, "node")
	entrypoint := filepath.Join(root, "worker.js")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entrypoint, []byte("// sealed worker\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	executableHash, _ := SHA256File(executable)
	entrypointHash, _ := SHA256File(entrypoint)
	manifest := Manifest{
		Schema: ManifestSchema, BundleID: "openslack.workflow-runner.test",
		RunnerBuildHash: entrypointHash,
		Executable:      Artifact{RelativePath: "node", SHA256: executableHash},
		Entrypoint:      Artifact{RelativePath: "worker.js", SHA256: entrypointHash},
		EntrypointMode:  "first-argument", FixedArguments: []string{},
		FixedEnvironment: []string{"TZ=UTC"}, WorkingDirectory: ".",
	}
	if mutate != nil {
		mutate(&manifest)
	}
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ManifestFilename), body, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	runtimeToken := strings.Repeat("r", 40)
	runtimeDigest := sha256.Sum256([]byte(runtimeToken))
	authorityToken := strings.Repeat("a", 40)
	authorityDigest := sha256.Sum256([]byte(authorityToken))
	return root, fmt.Sprintf("%x", digest[:]), Runtime{
		WorkspaceID: "workspace.test", WorkspaceRoot: root, DescriptorRoot: filepath.Join(root, "descriptors"),
		V2RuntimeDelivery: &runnerconfig.V2RuntimeDeliveryRuntime{
			Origin: "http://127.0.0.1:8081", BearerToken: runtimeToken,
			BearerSHA256: fmt.Sprintf("%x", runtimeDigest[:]),
			JournalRoot:  filepath.Join(root, ".openslack.local", "workflow-runner-v2-runtime-delivery"),
			BudgetOrigin: "http://127.0.0.1:8085", BudgetToken: strings.Repeat("b", 40), BudgetCallerID: "runner-control",
		},
		V2RunAuthority: &runnerconfig.V2RunAuthorityRuntime{
			Origin: "http://127.0.0.1:8082", BearerToken: authorityToken,
			BearerSHA256: fmt.Sprintf("%x", authorityDigest[:]), CallerID: "workflow-runner-v2",
			ExpectedBuild: strings.Repeat("d", 64),
		},
	}
}

func TestLoadSealsTrustedBundleWithoutPerJobLaunchOptions(t *testing.T) {
	root, manifestHash, runtimeConfig := writeBundle(t, nil)
	registry, err := Load(root, manifestHash, runtimeConfig)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	entrypointHash, err := SHA256File(filepath.Join(root, "worker.js"))
	if err != nil {
		t.Fatal(err)
	}
	if registry.BundleID() != "openslack.workflow-runner.test" || registry.RunnerBuildHash() != entrypointHash {
		t.Fatalf("unexpected registry identity")
	}
	supervisor, err := registry.NewSupervisor()
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}
	if supervisor.CommandName() != registry.BundleID() || len(supervisor.CommandIdentity()) != 64 {
		t.Fatalf("unexpected sealed supervisor identity")
	}
}

func TestRetiredCheckpointShadowEnvironmentIsReservedAndNeverInjected(t *testing.T) {
	reserved := []string{"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED", "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT", "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_BEARER_TOKEN", "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CALLER_ID", "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT"}
	for _, name := range reserved {
		t.Run("reject "+name, func(t *testing.T) {
			root, hash, runtimeConfig := writeBundle(t, func(value *Manifest) { value.FixedEnvironment = []string{name + "=evil"} })
			if _, err := Load(root, hash, runtimeConfig); err == nil {
				t.Fatal("manifest checkpoint override accepted")
			}
		})
	}
	root, hash, runtimeConfig := writeBundle(t, nil)
	registry, err := Load(root, hash, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range registry.command.Environment {
		if strings.HasPrefix(entry, "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_") {
			t.Fatalf("disabled runtime injected %s", entry)
		}
	}
}

func TestRetiredEffectShadowEnvironmentIsReservedAndNeverInjected(t *testing.T) {
	reserved := []string{"OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENABLED", "OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT", "OPENSLACK_WORKFLOW_EFFECT_SHADOW_BEARER_TOKEN", "OPENSLACK_WORKFLOW_EFFECT_SHADOW_CALLER_ID", "OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT"}
	for _, name := range reserved {
		t.Run("reject "+name, func(t *testing.T) {
			root, hash, runtimeConfig := writeBundle(t, func(value *Manifest) { value.FixedEnvironment = []string{name + "=evil"} })
			if _, err := Load(root, hash, runtimeConfig); err == nil {
				t.Fatal("manifest effect override accepted")
			}
		})
	}
	root, hash, runtimeConfig := writeBundle(t, nil)
	registry, err := Load(root, hash, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range registry.command.Environment {
		if strings.HasPrefix(entry, "OPENSLACK_WORKFLOW_EFFECT_SHADOW_") {
			t.Fatalf("disabled runtime injected %s", entry)
		}
	}
}

func TestLoadRejectsEscapeOverrideAndArtifactDrift(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		mutate func(*Manifest)
	}{
		{"escape", func(value *Manifest) { value.Entrypoint.RelativePath = "../worker.js" }},
		{"identity override", func(value *Manifest) {
			value.FixedEnvironment = []string{"OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID=evil"}
		}},
		{"hash drift", func(value *Manifest) { value.Executable.SHA256 = strings.Repeat("f", 64) }},
		{"runner build hash drift", func(value *Manifest) { value.RunnerBuildHash = strings.Repeat("f", 64) }},
		{"shell mode", func(value *Manifest) { value.EntrypointMode = "executable" }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			root, manifestHash, runtimeConfig := writeBundle(t, testCase.mutate)
			if _, err := Load(root, manifestHash, runtimeConfig); err == nil {
				t.Fatal("expected trusted bundle rejection")
			}
		})
	}
}

func TestLoadRejectsNonClosedBundleWithUnchangedManifestAnchor(t *testing.T) {
	for _, testCase := range []struct {
		name string
		add  func(*testing.T, string)
	}{
		{name: "dependency", add: func(t *testing.T, root string) {
			if err := os.WriteFile(filepath.Join(root, "dependency.js"), []byte("export {};\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "extra execute.js", add: func(t *testing.T, root string) {
			if err := os.WriteFile(filepath.Join(root, "execute.js"), []byte("export {};\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "unknown file", add: func(t *testing.T, root string) {
			if err := os.WriteFile(filepath.Join(root, "README.txt"), []byte("unexpected\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "subdirectory", add: func(t *testing.T, root string) {
			if err := os.Mkdir(filepath.Join(root, "dist"), 0o700); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			root, manifestHash, runtimeConfig := writeBundle(t, nil)
			testCase.add(t, root)
			if _, err := Load(root, manifestHash, runtimeConfig); err == nil {
				t.Fatal("non-closed bundle was accepted with an unchanged external manifest anchor")
			}
		})
	}
}

func TestLoadRejectsEntrypointDriftWithUnchangedManifestAnchor(t *testing.T) {
	root, manifestHash, runtimeConfig := writeBundle(t, nil)
	if err := os.WriteFile(filepath.Join(root, "worker.js"), []byte("import './dependency.js';\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root, manifestHash, runtimeConfig); err == nil || !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Fatalf("entrypoint drift error = %v", err)
	}
}

func TestLoadRejectsManifestDriftAgainstExternalAnchor(t *testing.T) {
	root, manifestHash, runtimeConfig := writeBundle(t, nil)
	manifestPath := filepath.Join(root, ManifestFilename)
	body, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, append(body, byte('\n')), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root, manifestHash, runtimeConfig); err == nil || !strings.Contains(err.Error(), "external SHA-256 anchor") {
		t.Fatalf("manifest anchor drift error = %v", err)
	}
}

func TestLoadRejectsSymlinkBundleEntry(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlink creation requires external privilege")
	}
	root, manifestHash, runtimeConfig := writeBundle(t, nil)
	if err := os.Symlink(filepath.Join(root, "worker.js"), filepath.Join(root, "unknown-link")); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root, manifestHash, runtimeConfig); err == nil {
		t.Fatal("symlink bundle entry was accepted")
	}
}

func TestNewSupervisorRechecksClosedBundleAndStartRechecksArtifacts(t *testing.T) {
	root, manifestHash, runtimeConfig := writeBundle(t, nil)
	registry, err := Load(root, manifestHash, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(root, "execute.js")
	if err := os.WriteFile(unknown, []byte("export {};\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.NewSupervisor(); err == nil {
		t.Fatal("supervisor composition accepted a bundle that was no longer closed")
	}
	if err := os.Remove(unknown); err != nil {
		t.Fatal(err)
	}
	supervisor, err := registry.NewSupervisor()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "worker.js"), []byte("// drift before launch\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := supervisor.Start(t.Context()); err == nil || !strings.Contains(err.Error(), "changed after composition") {
		t.Fatalf("pre-launch entrypoint revalidation error = %v", err)
	}
}

func TestLoadRejectsOversizedSparseArtifactBeforeSupervisor(t *testing.T) {
	root, manifestHash, runtimeConfig := writeBundle(t, nil)
	entrypoint := filepath.Join(root, "worker.js")
	if err := os.Truncate(entrypoint, maxArtifactBytes+1); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root, manifestHash, runtimeConfig); err == nil || !strings.Contains(err.Error(), "closed bundle limit") {
		t.Fatalf("oversized bundle artifact error = %v", err)
	}
}

func TestStableBundleHashRejectsAppendAndMetadataDrift(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		mutate func(*testing.T, string)
	}{
		{name: "append", mutate: func(t *testing.T, path string) {
			file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := file.WriteString("appended"); err != nil {
				_ = file.Close()
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "metadata", mutate: func(t *testing.T, path string) {
			info, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			changed := info.ModTime().Add(2 * time.Second)
			if err := os.Chtimes(path, changed, changed); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "artifact")
			if err := os.WriteFile(path, []byte("sealed artifact\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			before, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			opened, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			testCase.mutate(t, path)
			if _, err := hashStableRegularFile(path, before, opened); err == nil {
				t.Fatal("bundle artifact drift was accepted during hashing")
			}
		})
	}
}

func TestLoadRejectsManifestAndArtifactReplacementWithoutExternalAnchorChange(t *testing.T) {
	root, manifestHash, runtimeConfig := writeBundle(t, nil)
	entrypoint := filepath.Join(root, "worker.js")
	if err := os.WriteFile(entrypoint, []byte("// replaced worker\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	replacementHash, _ := SHA256File(entrypoint)
	manifestPath := filepath.Join(root, ManifestFilename)
	body, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Entrypoint.SHA256 = replacementHash
	replacedManifest, _ := json.Marshal(manifest)
	if err := os.WriteFile(manifestPath, replacedManifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root, manifestHash, runtimeConfig); err == nil || !strings.Contains(err.Error(), "external SHA-256 anchor") {
		t.Fatalf("expected external manifest anchor rejection, got %v", err)
	}
}
