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

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
)

func TestProtocolSupervisorsUseMutuallyExclusiveReservedEnablement(t *testing.T) {
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
	v1 := strings.Join(selectProtocolEnvironment(registry.command.Environment, "openslack.workflow_runner.v1"), "\n")
	v2 := strings.Join(selectProtocolEnvironment(registry.command.Environment, authoritycontract.ProtocolVersion), "\n")
	if !strings.Contains(v1, "OPENSLACK_WORKFLOW_RUNNER_ENABLED=1") || strings.Contains(v1, "OPENSLACK_WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED=1") {
		t.Fatalf("v1 sealed environment is ambiguous: %s", v1)
	}
	if !strings.Contains(v2, "OPENSLACK_WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED=1") || strings.Contains(v2, "OPENSLACK_WORKFLOW_RUNNER_ENABLED=1") {
		t.Fatalf("v2 sealed environment is ambiguous: %s", v2)
	}
	if _, err := registry.NewSupervisorForProtocol(authoritycontract.ProtocolVersion); err != nil {
		t.Fatalf("construct sealed v2 supervisor: %v", err)
	}
}

func TestV2QualificationSupervisorStripsIncompatibleShadowInjection(t *testing.T) {
	environment := []string{
		"OPENSLACK_WORKFLOW_RUNNER_ENABLED=1",
		"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED=1",
		"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT=http://127.0.0.1:8083/v1/shadow/workflow-control/checkpoints",
		"OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENABLED=1",
		"OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT=http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events",
		"OPENSLACK_AGENT_ID=agent.test",
	}
	v1 := strings.Join(selectProtocolEnvironment(environment, "openslack.workflow_runner.v1"), "\n")
	v2 := strings.Join(selectProtocolEnvironment(environment, authoritycontract.ProtocolVersion), "\n")
	if !strings.Contains(v1, "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED=1") || !strings.Contains(v1, "OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENABLED=1") {
		t.Fatalf("v1 supervisor lost configured shadow transport: %s", v1)
	}
	if strings.Contains(v2, "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_") || strings.Contains(v2, "OPENSLACK_WORKFLOW_EFFECT_SHADOW_") ||
		!strings.Contains(v2, "OPENSLACK_WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED=1") || strings.Contains(v2, "OPENSLACK_WORKFLOW_RUNNER_ENABLED=1") {
		t.Fatalf("v2 qualification supervisor received incompatible shadow configuration: %s", v2)
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
	runtimeConfig.V2RuntimeDeliveryEnabled = true
	runtimeConfig.V2RuntimeDeliveryOrigin = "http://127.0.0.1:8081"
	runtimeConfig.V2RuntimeDeliveryBearerToken = token
	runtimeConfig.V2RuntimeDeliveryBearerSHA256 = fmt.Sprintf("%x", digest[:])
	runtimeConfig.V2RuntimeDeliveryJournalRoot = filepath.Join(root, ".openslack.local", "workflow-runner-v2-runtime-delivery")
	runtimeConfig.V2BudgetOrigin = "http://127.0.0.1:8085"
	runtimeConfig.V2BudgetBearerToken = strings.Repeat("b", 40)
	runtimeConfig.V2BudgetCallerID = "runner-control"
	registry, err := Load(root, hash, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	v1 := strings.Join(selectProtocolEnvironment(registry.command.Environment, "openslack.workflow_runner.v1"), "\n")
	v2 := strings.Join(selectProtocolEnvironment(registry.command.Environment, authoritycontract.ProtocolVersion), "\n")
	for _, name := range reserved {
		if strings.Contains(v1, name+"=") {
			t.Fatalf("v1 supervisor received %s", name)
		}
		if !strings.Contains(v2, name+"=") {
			t.Fatalf("v2 runtime supervisor missed %s", name)
		}
	}
	runtimeConfig.V2RuntimeDeliveryBearerSHA256 = strings.Repeat("f", 64)
	if _, err := Load(root, hash, runtimeConfig); err == nil {
		t.Fatal("mismatched raw companion token hash was accepted")
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
	return root, fmt.Sprintf("%x", digest[:]), Runtime{WorkspaceID: "workspace.test", WorkspaceRoot: root, DescriptorRoot: filepath.Join(root, "descriptors")}
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

func TestCheckpointShadowEnvironmentIsReservedAndInjectedOnlyByRuntime(t *testing.T) {
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
	runtimeConfig.CheckpointShadowEnabled = true
	runtimeConfig.CheckpointShadowEndpoint = "http://127.0.0.1:8083/v1/shadow/workflow-control/checkpoints"
	runtimeConfig.CheckpointShadowBearerToken = strings.Repeat("t", 32)
	runtimeConfig.CheckpointShadowCallerID = "runner-control"
	runtimeConfig.CheckpointShadowJournalRoot = filepath.Join(root, ".openslack.local", "workflow-checkpoint-shadow")
	registry, err = Load(root, hash, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(registry.command.Environment, "\n")
	for _, want := range []string{"OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED=1", "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT=" + runtimeConfig.CheckpointShadowEndpoint, "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_BEARER_TOKEN=" + runtimeConfig.CheckpointShadowBearerToken, "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CALLER_ID=runner-control", "OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT=" + runtimeConfig.CheckpointShadowJournalRoot} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing trusted injection %s", want)
		}
	}
}

func TestCheckpointShadowEndpointRejectsDNSAndURLUserinfo(t *testing.T) {
	for _, endpoint := range []string{
		"http://localhost:8083/v1/shadow/workflow-control/checkpoints",
		"http://user@127.0.0.1:8083/v1/shadow/workflow-control/checkpoints",
		"http://user:password@[::1]:8083/v1/shadow/workflow-control/checkpoints",
	} {
		t.Run(endpoint, func(t *testing.T) {
			root, hash, runtimeConfig := writeBundle(t, nil)
			runtimeConfig.CheckpointShadowEnabled = true
			runtimeConfig.CheckpointShadowEndpoint = endpoint
			runtimeConfig.CheckpointShadowBearerToken = strings.Repeat("t", 32)
			runtimeConfig.CheckpointShadowCallerID = "runner-control"
			runtimeConfig.CheckpointShadowJournalRoot = filepath.Join(root, ".openslack.local", "workflow-checkpoint-shadow")
			if _, err := Load(root, hash, runtimeConfig); err == nil {
				t.Fatal("unsafe checkpoint shadow endpoint was accepted")
			}
		})
	}
}

func TestEffectShadowEnvironmentIsReservedAndInjectedOnlyByRuntime(t *testing.T) {
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
	runtimeConfig.EffectShadowEnabled = true
	runtimeConfig.EffectShadowEndpoint = "http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events"
	runtimeConfig.EffectShadowBearerToken = strings.Repeat("e", 32)
	runtimeConfig.EffectShadowCallerID = "runner-control"
	runtimeConfig.EffectShadowJournalRoot = filepath.Join(root, ".openslack.local", "workflow-effect-shadow")
	registry, err = Load(root, hash, runtimeConfig)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(registry.command.Environment, "\n")
	for _, want := range []string{
		"OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENABLED=1",
		"OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT=" + runtimeConfig.EffectShadowEndpoint,
		"OPENSLACK_WORKFLOW_EFFECT_SHADOW_BEARER_TOKEN=" + runtimeConfig.EffectShadowBearerToken,
		"OPENSLACK_WORKFLOW_EFFECT_SHADOW_CALLER_ID=runner-control",
		"OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT=" + runtimeConfig.EffectShadowJournalRoot,
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing trusted injection %s", want)
		}
	}
}

func TestEffectShadowEndpointRejectsDNSAndURLUserinfo(t *testing.T) {
	for _, endpoint := range []string{
		"http://localhost:8084/v1/shadow/workflow-control/effect-events",
		"http://user@127.0.0.1:8084/v1/shadow/workflow-control/effect-events",
		"http://user:password@[::1]:8084/v1/shadow/workflow-control/effect-events",
	} {
		t.Run(endpoint, func(t *testing.T) {
			root, hash, runtimeConfig := writeBundle(t, nil)
			runtimeConfig.EffectShadowEnabled = true
			runtimeConfig.EffectShadowEndpoint = endpoint
			runtimeConfig.EffectShadowBearerToken = strings.Repeat("e", 32)
			runtimeConfig.EffectShadowCallerID = "runner-control"
			runtimeConfig.EffectShadowJournalRoot = filepath.Join(root, ".openslack.local", "workflow-effect-shadow")
			if _, err := Load(root, hash, runtimeConfig); err == nil {
				t.Fatal("unsafe effect shadow endpoint was accepted")
			}
		})
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
