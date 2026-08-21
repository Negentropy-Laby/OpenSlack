package runnerbindingcontract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

type runnerBindingManifest struct {
	Schema            string `json:"schema"`
	ContractVersion   string `json:"contractVersion"`
	Profile           string `json:"profile"`
	AuthorityBoundary struct {
		Batch                          string   `json:"batch"`
		Normative                      bool     `json:"normative"`
		ContractOnly                   bool     `json:"contractOnly"`
		QualificationOnly              bool     `json:"qualificationOnly"`
		AuthorityClaim                 string   `json:"authorityClaim"`
		GoAuthorityImplemented         bool     `json:"goAuthorityImplemented"`
		RuntimeCompositionImplemented  bool     `json:"runtimeCompositionImplemented"`
		ProductionRoutingActivated     bool     `json:"productionRoutingActivated"`
		FrozenAuthorityV2KindsExtended bool     `json:"frozenAuthorityV2KindsExtended"`
		FrozenAuthorityV2KindCount     int      `json:"frozenAuthorityV2KindCount"`
		SourceAuthoritiesReplaced      bool     `json:"sourceAuthoritiesReplaced"`
		NotDelivered                   []string `json:"notDelivered"`
		NotActivated                   []string `json:"notActivated"`
		NotClaimed                     []string `json:"notClaimed"`
		SeparateGates                  []string `json:"separateGates"`
	} `json:"authorityBoundary"`
	Protocol struct {
		Sequence                                  []string `json:"sequence"`
		IndependentCompanionSequence              bool     `json:"independentCompanionSequence"`
		FrozenTargetBytesBoundBeforeAuthority     bool     `json:"frozenTargetBytesBoundBeforeAuthority"`
		ResolutionAckPrecedesFrozenTargetDelivery bool     `json:"resolutionAckPrecedesFrozenTargetDelivery"`
		ControlDeliveryAck                        bool     `json:"controlDeliveryAck"`
		ExactReplayReturnsOriginalReceiptBytes    bool     `json:"exactReplayReturnsOriginalReceiptBytes"`
	} `json:"protocol"`
	Operations []struct {
		Operation             Operation   `json:"operation"`
		TargetKind            string      `json:"targetKind"`
		RunnerDelta           RunnerDelta `json:"runnerDelta"`
		SourcePlane           string      `json:"sourcePlane"`
		SourceEvidenceState   string      `json:"sourceEvidenceState"`
		SourceRevisionDelta   int64       `json:"sourceRevisionDelta"`
		SourceGenerationDelta int64       `json:"sourceGenerationDelta"`
		SourceReceiptSchema   *string     `json:"sourceReceiptSchema"`
	} `json:"operations"`
	Evidence struct {
		Closed             bool     `json:"closed"`
		RawFieldsForbidden []string `json:"rawFieldsForbidden"`
		ProviderIdentity   string   `json:"providerIdentity"`
		ResultIdentity     string   `json:"resultIdentity"`
	} `json:"evidence"`
	ExactFraming struct {
		Encoding              string `json:"encoding"`
		CanonicalJSON         bool   `json:"canonicalJson"`
		TerminalLFCount       int    `json:"terminalLfCount"`
		CarriageReturnAllowed bool   `json:"carriageReturnAllowed"`
	} `json:"exactFraming"`
	SourceLocks map[string]struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
	} `json:"sourceLocks"`
	BundleFiles []string `json:"bundleFiles"`
	Artifacts   map[string]struct {
		Path       string `json:"path"`
		ByteLength int    `json:"byteLength"`
		SHA256     string `json:"sha256"`
	} `json:"artifacts"`
}

func TestGeneratedBundleIsExactTypeScriptMirror(t *testing.T) {
	t.Parallel()
	repository := runnerBindingRepositoryRoot(t)
	for _, name := range BundleFiles() {
		mirrored, err := BundleFile(name)
		if err != nil {
			t.Fatalf("read embedded %s: %v", name, err)
		}
		source, err := os.ReadFile(filepath.Join(
			repository,
			"packages/workflows/contracts/workflow-runner-authority-binding/v1",
			filepath.FromSlash(name),
		))
		if err != nil {
			t.Fatalf("read TypeScript artifact %s: %v", name, err)
		}
		if !reflect.DeepEqual(mirrored, source) {
			t.Fatalf("Go mirror differs byte-for-byte for %s", name)
		}
	}
	if _, err := BundleFile("../manifest.json"); err == nil {
		t.Fatal("bundle reader accepted traversal outside the closed inventory")
	}
}

func TestManifestLocksClosedContractAndAuthorityCeiling(t *testing.T) {
	t.Parallel()
	manifestBytes, err := BundleFile("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest runnerBindingManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if manifest.Schema != "openslack.workflow_runner_authority_binding_contract_manifest.v1" ||
		manifest.ContractVersion != ContractVersion || manifest.Profile != FutureRuntimeProfile {
		t.Fatalf("manifest identity drifted: %+v", manifest)
	}
	boundary := manifest.AuthorityBoundary
	if boundary.Batch != "GS9-F2a" || !boundary.Normative || !boundary.ContractOnly || !boundary.QualificationOnly ||
		boundary.AuthorityClaim != "NO_AUTHORITY" || boundary.GoAuthorityImplemented ||
		boundary.RuntimeCompositionImplemented || boundary.ProductionRoutingActivated ||
		boundary.FrozenAuthorityV2KindsExtended || boundary.FrozenAuthorityV2KindCount != 18 ||
		boundary.SourceAuthoritiesReplaced || HasDurableAuthority() {
		t.Fatalf("authority ceiling widened: %+v", boundary)
	}
	if !reflect.DeepEqual(boundary.NotDelivered, []string{
		"migration_000008", "database", "http", "durable_store", "scheduler", "worker",
		"checkpoint_adapter", "effect_adapter", "budget_adapter", "resume_adapter",
		"provider_adapter", "authority_recovery", "runtime_composition",
	}) || !reflect.DeepEqual(boundary.NotActivated, []string{
		"future_runtime_profile", "production_v2_submission", "new_record_acceptance", "routing",
		"canary", "cutover", "typescript_fallback_removal", "typescript_writer_retirement",
	}) || !reflect.DeepEqual(boundary.NotClaimed, []string{
		"runtime_authority_delivery", "go_production_workflow_authority",
		"go_production_checkpoint_authority", "go_production_effect_authority",
		"go_production_budget_policy_authority", "go_production_provider_authority",
		"go_production_run_store_authority", "go_production_user_visible_read_authority",
		"authenticated_external_host_qualification", "qoder", "remote_connector", "release",
		"live", "tag", "npm", "production_readiness",
	}) || !reflect.DeepEqual(boundary.SeparateGates, []string{
		"hosted_exact_head_checks", "review_thread_resolution", "independent_human_approval", "merge",
	}) {
		t.Fatalf("authority boundary inventory drifted: %+v", boundary)
	}
	protocol := manifest.Protocol
	if !reflect.DeepEqual(protocol.Sequence, []string{"stage_event", "stage_event_ack", "commit_authority", "commit_authority_ack"}) ||
		!protocol.IndependentCompanionSequence || !protocol.FrozenTargetBytesBoundBeforeAuthority ||
		!protocol.ResolutionAckPrecedesFrozenTargetDelivery || !protocol.ControlDeliveryAck ||
		!protocol.ExactReplayReturnsOriginalReceiptBytes {
		t.Fatalf("protocol invariants drifted: %+v", protocol)
	}
	if !manifest.Evidence.Closed || manifest.Evidence.ProviderIdentity != "hash_only" ||
		manifest.Evidence.ResultIdentity != "hash_only" ||
		!reflect.DeepEqual(manifest.Evidence.RawFieldsForbidden, []string{
			"provider", "providerId", "model", "modelId", "prompt", "result", "nonce", "credential", "credentials",
		}) {
		t.Fatalf("closed evidence contract drifted: %+v", manifest.Evidence)
	}
	if manifest.ExactFraming.Encoding != "utf-8" || !manifest.ExactFraming.CanonicalJSON ||
		manifest.ExactFraming.TerminalLFCount != 1 || manifest.ExactFraming.CarriageReturnAllowed {
		t.Fatalf("exact framing drifted: %+v", manifest.ExactFraming)
	}
	if !reflect.DeepEqual(manifest.BundleFiles, BundleFiles()) {
		t.Fatalf("bundle inventory drifted: %v", manifest.BundleFiles)
	}
	assertManifestOperationMatrix(t, manifest)
	assertManifestArtifacts(t, manifest)
	assertManifestSourceLocks(t, manifest)
}

func TestBundleSchemasCloseEveryObjectShape(t *testing.T) {
	t.Parallel()
	for _, name := range BundleFiles()[:4] {
		contents, err := BundleFile(name)
		if err != nil {
			t.Fatal(err)
		}
		var schema any
		if err := json.Unmarshal(contents, &schema); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		assertClosedSchemaObject(t, schema, name)
	}
}

func assertManifestOperationMatrix(t *testing.T, manifest runnerBindingManifest) {
	t.Helper()
	if len(manifest.Operations) != len(Operations()) {
		t.Fatalf("operation count = %d", len(manifest.Operations))
	}
	for index, operation := range Operations() {
		entry := manifest.Operations[index]
		fact, err := factFor(operation)
		if err != nil {
			t.Fatal(err)
		}
		if entry.Operation != operation || entry.TargetKind != string(fact.TargetKind) || entry.RunnerDelta != fact.RunnerDelta ||
			entry.SourcePlane != fact.SourcePlane || entry.SourceEvidenceState != fact.SourceEvidenceState ||
			entry.SourceRevisionDelta != fact.SourceRevisionDelta || entry.SourceGenerationDelta != fact.SourceGenerationDelta ||
			!nullableStringsEqual(entry.SourceReceiptSchema, fact.SourceReceiptSchema) {
			t.Fatalf("operation matrix drift at %s: %+v", operation, entry)
		}
	}
}

func assertManifestArtifacts(t *testing.T, manifest runnerBindingManifest) {
	t.Helper()
	if len(manifest.Artifacts) != len(BundleFiles())-1 {
		t.Fatalf("artifact count = %d", len(manifest.Artifacts))
	}
	for name, artifact := range manifest.Artifacts {
		if name != artifact.Path {
			t.Fatalf("artifact path drift: %s != %s", name, artifact.Path)
		}
		contents, err := BundleFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if len(contents) != artifact.ByteLength || sha256Bytes(contents) != artifact.SHA256 {
			t.Fatalf("artifact evidence mismatch for %s", name)
		}
	}
}

func assertManifestSourceLocks(t *testing.T, manifest runnerBindingManifest) {
	t.Helper()
	repository := runnerBindingRepositoryRoot(t)
	locks := SourceLocks()
	if len(manifest.SourceLocks) != len(locks) {
		t.Fatalf("manifest source lock count = %d", len(manifest.SourceLocks))
	}
	for _, expected := range locks {
		lock, ok := manifest.SourceLocks[expected.Name]
		if !ok || lock.SHA256 != expected.SHA256 {
			t.Fatalf("source lock %s drifted: %+v", expected.Name, lock)
		}
		contents, err := os.ReadFile(filepath.Join(repository, filepath.FromSlash(lock.Path)))
		if err != nil {
			t.Fatalf("read source lock %s: %v", lock.Path, err)
		}
		if sha256Bytes(contents) != lock.SHA256 {
			t.Fatalf("source lock file drifted: %s", lock.Path)
		}
	}
}

func assertClosedSchemaObject(t *testing.T, value any, path string) {
	t.Helper()
	switch current := value.(type) {
	case map[string]any:
		if current["type"] == "object" {
			closed, exists := current["additionalProperties"]
			if !exists || closed != false {
				t.Fatalf("object schema is not closed at %s", path)
			}
		}
		for key, child := range current {
			assertClosedSchemaObject(t, child, path+"/"+key)
		}
	case []any:
		for _, child := range current {
			assertClosedSchemaObject(t, child, path)
		}
	}
}

func runnerBindingRepositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve bundle test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

func sha256Bytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func nullableStringsEqual(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
