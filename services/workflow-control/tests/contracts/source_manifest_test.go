package contracts_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

type manifestReference struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type sourceManifest struct {
	Schema  string `json:"schema"`
	Status  string `json:"status"`
	Service struct {
		GoModule       string `json:"goModule"`
		TargetPath     string `json:"targetPath"`
		MigrationPhase string `json:"migrationPhase"`
		Authority      string `json:"authority"`
	} `json:"service"`
	ContainerInputs map[string]string            `json:"containerInputs"`
	SourceInputs    map[string]manifestReference `json:"sourceInputs"`
	ContractInputs  map[string]manifestReference `json:"contractInputs"`
	LegalInputs     struct {
		License           manifestReference `json:"license"`
		Notice            manifestReference `json:"notice"`
		ThirdPartyNotices struct {
			manifestReference
			ProductionModuleCount int `json:"productionModuleCount"`
		} `json:"thirdPartyNotices"`
		RepositorySBOMInput struct {
			manifestReference
			Scope       string `json:"scope"`
			Attestation string `json:"attestation"`
		} `json:"repositorySbomInput"`
	} `json:"legalInputs"`
	Scope struct {
		Authorizes []string `json:"authorizes"`
		NonClaims  []string `json:"nonClaims"`
	} `json:"scope"`
}

func TestSourceManifestBindsOnlyUnreleasedGS9IInputs(t *testing.T) {
	repositoryRoot, serviceRoot := roots(t)
	path := filepath.Join(serviceRoot, "integration", "source-manifest.v2.json")
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var manifest sourceManifest
	if err := decoder.Decode(&manifest); err != nil {
		t.Fatalf("decode source manifest: %v", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatal("source manifest contains trailing JSON")
	}
	if manifest.Schema != "openslack.workflow_control_source.v2" ||
		manifest.Status != "REPOSITORY_SOURCE_INPUT_UNRELEASED" ||
		manifest.Service.GoModule != "github.com/Negentropy-Laby/OpenSlack/services/workflow-control" ||
		manifest.Service.TargetPath != "services/workflow-control" ||
		manifest.Service.MigrationPhase != "GS9-I" ||
		manifest.Service.Authority != "GO_NEW_RECORD_AUTHORITY_WITH_TYPESCRIPT_READ_ONLY_EVIDENCE" ||
		strings.Join(manifest.Scope.Authorizes, "\n") != strings.Join([]string{
			"WORKFLOW_CONTROL_SHADOW_OBSERVATION",
			"WORKFLOW_RUNNER_ATTEMPT_LEASE_FENCING",
			"WORKFLOW_RUNNER_CANCELLATION_CONTROL",
			"WORKFLOW_RUNNER_JOB_LIFECYCLE_CONTROL",
			"WORKFLOW_RUNNER_PROCESS_SUPERVISION",
			"WORKFLOW_RUNNER_PROTOCOL_RECEIPT",
			"WORKFLOW_CONTROL_AUTHORITY_QUALIFICATION_RUN_SPINE",
			"WORKFLOW_CONTROL_AUTHORITY_QUALIFICATION_EXACT_RECEIPT",
			"WORKFLOW_CONTROL_AUTHORITY_QUALIFICATION_OUTBOX",
			"WORKFLOW_CONTROL_AUTHORITY_QUALIFICATION_RECONCILIATION",
			"WORKFLOW_CONTROL_CHECKPOINT_SHADOW_OBSERVATION",
			"WORKFLOW_CONTROL_CHECKPOINT_SHADOW_EXACT_RECEIPT",
			"WORKFLOW_CONTROL_CHECKPOINT_SHADOW_RECONCILIATION",
			"WORKFLOW_CONTROL_EFFECT_SHADOW_OBSERVATION",
			"WORKFLOW_CONTROL_EFFECT_SHADOW_EXACT_RECEIPT",
			"WORKFLOW_CONTROL_EFFECT_SHADOW_OUTBOX",
			"WORKFLOW_CONTROL_EFFECT_SHADOW_RECONCILIATION",
			"WORKFLOW_CONTROL_BUDGET_AUTHORITY_QUALIFICATION_DURABLE_ENVELOPE",
			"WORKFLOW_CONTROL_BUDGET_AUTHORITY_QUALIFICATION_ACCOUNT",
			"WORKFLOW_CONTROL_BUDGET_AUTHORITY_QUALIFICATION_RESERVATION",
			"WORKFLOW_CONTROL_BUDGET_AUTHORITY_QUALIFICATION_LEDGER",
			"WORKFLOW_CONTROL_BUDGET_AUTHORITY_QUALIFICATION_EXACT_RECEIPT",
			"WORKFLOW_CONTROL_BUDGET_AUTHORITY_QUALIFICATION_RECONCILIATION",
			"WORKFLOW_RUNNER_V2_FOUNDATION_ADMISSION",
			"WORKFLOW_RUNNER_V2_FOUNDATION_STORAGE",
			"WORKFLOW_RUNNER_V2_FOUNDATION_NEGOTIATION",
			"WORKFLOW_RUNNER_V2_FOUNDATION_RECEIPT_BEFORE_DECISION_TRANSPORT",
			"WORKFLOW_RUNNER_V2_LOCAL_PROVIDER_ATTEMPT_ORDERING_SEAM",
			"WORKFLOW_RUNNER_V2_AUTHORITY_BINDING_COORDINATOR",
			"WORKFLOW_RUNNER_V2_AUTHORITY_BINDING_RECOVERY",
			"WORKFLOW_RUNNER_V2_CHECKPOINT_ADAPTER",
			"WORKFLOW_RUNNER_V2_EFFECT_ADAPTER",
			"WORKFLOW_RUNNER_V2_BUDGET_ADAPTER",
			"WORKFLOW_RUNNER_V2_BUDGET_IDENTITY_BINDING",
			"WORKFLOW_RUNNER_V2_RESUME_ADAPTER",
			"WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_QUALIFICATION",
			"WORKFLOW_BUDGET_QUALIFICATION_RUNTIME_CLIENT",
			"WORKFLOW_RUN_IMMUTABLE_ROUTE_RECEIPT",
			"WORKFLOW_RUN_ROUTING_PROCESS_IMMUTABILITY",
			"WORKFLOW_RUN_ROUTING_BOUNDED_ALLOWLIST",
			"WORKFLOW_CONTROL_AUTHORITY_NEW_RECORD_CANARY",
			"WORKFLOW_CONTROL_AUTHORITY_BOUNDED_DRAIN_EPOCH",
			"WORKFLOW_RUNNER_V2_NEW_RECORD_CANARY_SUBMISSION",
			"WORKFLOW_RUNNER_V2_GO_RECOVERY_PROJECTION",
			"WORKFLOW_RUNNER_V2_EXACT_IDEMPOTENT_SUBMIT_RECOVERY",
			"WORKFLOW_RUNNER_V2_SINGLE_WRITER_NEGATIVE_GUARD",
			"WORKFLOW_CONTROL_AUTHORITY_CUTOVER",
			"WORKFLOW_CONTROL_STATE_MACHINE_AUTHORITY",
			"WORKFLOW_RUNSTORE_AUTHORITY",
			"WORKFLOW_RUN_ROUTING_GO_NEW_RECORD_CUTOVER",
			"WORKFLOW_RUN_TYPESCRIPT_MUTATION_COMPOSITION_RETIRED",
			"WORKFLOW_RUN_READ_ONLY_RECOVERY_INSPECTION",
			"WORKFLOW_RUNNER_V1_ADMISSION_RETIRED",
			"WORKFLOW_RUN_TYPESCRIPT_AUTHORITATIVE_WRITER_DELETED",
			"WORKFLOW_RUNNER_TYPESCRIPT_EXECUTION_FALLBACK_DELETED",
			"WORKFLOW_RUN_TYPESCRIPT_WRITER_REACTIVATION_SWITCH_DELETED",
			"WORKFLOW_RUNNER_TYPESCRIPT_PUBLIC_TEST_INJECTION_DELETED",
			"WORKFLOW_RUNNER_V1_IMPLEMENTATION_DELETED",
		}, "\n") {
		t.Fatalf("source manifest widened authority: %#v", manifest)
	}
	if len(manifest.ContainerInputs) != 6 || manifest.ContainerInputs["goVersion"] != "1.26.5" ||
		len(manifest.SourceInputs) != 108 || len(manifest.ContractInputs) != 15 {
		t.Fatal("source manifest input inventory drifted")
	}
	wantSourceInputs := map[string]manifestReference{
		"workflowRecoveryTestFixtures": {
			Path:   "packages/workflows/src/__tests__/workflow-recovery-fixtures.ts",
			SHA256: "972d5747739c2603bfc262c4353d32facd3d22b763ed35c080a51f094b882438",
		},
		"workflowCheckpointRepairTests": {
			Path:   "packages/workflows/src/__tests__/workflow-checkpoint-repair.test.ts",
			SHA256: "a0997c067901f161ddd4da8fba78893c8b9f661f2789d8ea2660492841e62a4c",
		},
		"workflowRecoveryEvidenceTests": {
			Path:   "packages/workflows/src/__tests__/workflow-run-recovery-evidence.test.ts",
			SHA256: "a4e3a68ede2141854acd38e124e8858b5457e1e709c6e4314c3dd85d26fdc645",
		},
		"workflowRunnerV2Session": {
			Path:   "packages/workflows/src/workflow-runner-v2-session.ts",
			SHA256: "b96fa886aec4f2378c8b80dc115cfa67949f953affa53810675fd59973f41204",
		},
		"workflowRunnerAuthoritySources": {
			Path:   "packages/workflows/src/workflow-runner-runtime-authorities.ts",
			SHA256: "ff6fa926fb4a2b710e55bc1018a2bfa98be421ecee5e085e39a23a55ea7c73eb",
		},
		"workflowRunnerBudgetClient": {
			Path:   "packages/workflows/src/workflow-runner-budget-authority-client.ts",
			SHA256: "c5ae6ca49631360c89260291828c268ebe20cc864d8a5de686c11b1dc8619679",
		},
		"workflowRunnerAuthorityRuntime": {
			Path:   "packages/workflows/src/workflow-runner-authority-binding-runtime.ts",
			SHA256: "d3bf067af77056ff914c79751ec53d60708761fb58bf12942d9bf2473bc72261",
		},
		"workflowRunnerAuthorityClient": {
			Path:   "packages/workflows/src/workflow-runner-authority-binding-client.ts",
			SHA256: "30780db18f2f967053766aefcb7ba52b39a2b0ddd1a09d10fd7f284b15c2cf62",
		},
		"workflowOwnerFileSecurity": {
			Path:   "packages/workflows/src/workflow-control-shadow.ts",
			SHA256: "ff842826901af5331ef9f44d02e21be74ca5176c7463fefe251103a357fe7d71",
		},
		"workflowAuthorityFailure": {
			Path:   "packages/workflows/src/internal/workflow-authority-failure.ts",
			SHA256: "9caf73800922c10b2a35357985f3fdb2c03f71ad0c7d21d2bec8b53d57b55415",
		},
		"workflowCheckpointEvidence": {
			Path:   "packages/workflows/src/internal/workflow-runner-checkpoint-evidence.ts",
			SHA256: "63c4a5701ed8371f514d6e03d73197f118241178491e46238959d050e6eb3381",
		},
		"workflowCheckpointRepair": {
			Path:   "packages/workflows/src/workflow-checkpoint-repair.ts",
			SHA256: "5d620b2cfc55e1f77fc27ae95bfb6e64a4f2b94aca14e2a6226e622f1f705e04",
		},
		"workflowRecoveryEvidence": {
			Path:   "packages/workflows/src/workflow-run-recovery-evidence.ts",
			SHA256: "e0a158356232f0ea36b2161d50302ca26deeb4c74806c3d1e3d80a2df2cf3f46",
		},
		"runnerRecoveryPostgresTestSupport": {
			Path:   "services/workflow-control/internal/testsupport/postgres.go",
			SHA256: "02362638f6326ff8522b5141847ea1b4119f545abccd223983d640a7e5946235",
		},
		"runnerRecoverySchemaReadiness": {
			Path:   "services/workflow-control/internal/databaseready/databaseready.go",
			SHA256: "7c84d07aeba1f3894a7cbad9bbd8069162ff5b5da1fdff6a406000d4525894b3",
		},
		"runnerRecoveryEvidencePostgresTests": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_evidence_integration_test.go",
			SHA256: "a88a01a9b577c8519914d9d1be5928962e04cce67195fa2955951363a2ba3bc8",
		},
		"runnerRecoveryEvidenceHTTPTests": {
			Path:   "services/workflow-control/internal/runnerapp/recovery_evidence_test.go",
			SHA256: "a892cbbd588cbd00d68edbd96babdaa593b85be859a7afd73854a9fcf0b9088d",
		},
		"runnerRecoveryEvidenceHTTP": {
			Path:   "services/workflow-control/internal/runnerapp/recovery_evidence.go",
			SHA256: "97d6b3ebba6d053e853040a1a2ab45bb66849479a719c0fa30522ca4b20c6f13",
		},
		"runnerRecoveryEvidenceStore": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_evidence.go",
			SHA256: "088225cdaf65de538de826d8d3c2e15d22993d5ea9bf6ba6db48f83131feac8c",
		},
		"runnerRecoveryEvidenceDomain": {
			Path:   "services/workflow-control/internal/runnerstore/recovery_evidence.go",
			SHA256: "bf0c3eea0549452fc5fc3d962c1c4bb2cc7762ad60cf202383fbe5d668d87b0c",
		},
		"runnerRecoveryEvidenceMigrationDown": {
			Path:   "services/workflow-control/migrations/000009_index_workflow_runner_recovery_evidence.down.sql",
			SHA256: "2cce9a7b400a78f64465a9012761609d18a31e50e49e273423a12918e79cd043",
		},
		"runnerRecoveryEvidenceMigrationUp": {
			Path:   "services/workflow-control/migrations/000009_index_workflow_runner_recovery_evidence.up.sql",
			SHA256: "624478ec8a3ff795c2d7090f017ca463152cf43b70f72a71132e2fc80fbb990e",
		},
		"dockerfile": {
			Path:   "services/workflow-control/Dockerfile",
			SHA256: "67d82836f02c2d6e4427de945bc8e166d36350de9272cefa682a11ea3b6fe5b4",
		},
		"goMod": {
			Path:   "services/workflow-control/go.mod",
			SHA256: "443b57d7f5516a1cbea8288ddd58cfaaa1640cac9d2c93f6c445e7a094e21852",
		},
		"goSum": {
			Path:   "services/workflow-control/go.sum",
			SHA256: "5928913791b8b595ecdc0a084e9a822a62b0231fb77441185525d30da287ef64",
		},
		"authorityMigrationUp": {
			Path:   "services/workflow-control/migrations/000003_create_workflow_control_authority.up.sql",
			SHA256: "12562719aece57a06f28fed839aea2c343e63536b47612980b747d15d1a368f8",
		},
		"authorityMigrationDown": {
			Path:   "services/workflow-control/migrations/000003_create_workflow_control_authority.down.sql",
			SHA256: "fc04888e19b4c22c3885b5025501084b977e312e5205a62270958195b1edb9a9",
		},
		"checkpointShadowMigrationUp": {
			Path:   "services/workflow-control/migrations/000004_create_workflow_control_checkpoint_shadow.up.sql",
			SHA256: "dacd2cf88ae75afdb8503f7261e436b7e2daa43cd462fbbbe5464e0bc16172e0",
		},
		"checkpointShadowMigrationDown": {
			Path:   "services/workflow-control/migrations/000004_create_workflow_control_checkpoint_shadow.down.sql",
			SHA256: "32e76f0a6aec433d2615cfd3a74f17acff4a7f4ae1998f09d47e0b907d793193",
		},
		"effectShadowMigrationUp": {
			Path:   "services/workflow-control/migrations/000005_create_workflow_control_effect_shadow.up.sql",
			SHA256: "999f63ac6440929c70b574227aea55b521c1afb3233363e32522c4cb1be7a1ad",
		},
		"effectShadowMigrationDown": {
			Path:   "services/workflow-control/migrations/000005_create_workflow_control_effect_shadow.down.sql",
			SHA256: "f603d2039c3dbd63ef0e2012242791ccd64fbeaa2c8cd8f427443d4dd50664b8",
		},
		"budgetAuthorityMigrationUp": {
			Path:   "services/workflow-control/migrations/000006_create_workflow_control_budget_authority.up.sql",
			SHA256: "c5d461de2066aa657812a78676c3919d00320b85617a154ce62868c70925020c",
		},
		"budgetAuthorityMigrationDown": {
			Path:   "services/workflow-control/migrations/000006_create_workflow_control_budget_authority.down.sql",
			SHA256: "e3548650dc03cafc3cd70c90ab3cf76af2f8aaf905390917bf93b576d4be5ea7",
		},
		"runnerV2MigrationUp": {
			Path:   "services/workflow-control/migrations/000007_integrate_workflow_runner_v2.up.sql",
			SHA256: "bc09194c0b9ec2d5880a17f71327d99cf5481d88d6dc0d737be099af7a8fd722",
		},
		"runnerV2MigrationDown": {
			Path:   "services/workflow-control/migrations/000007_integrate_workflow_runner_v2.down.sql",
			SHA256: "251b99eb5e088a468ff524d81e59a98ab57543f2b917331b5ea1c239900947d7",
		},
		"runnerV2EventSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/v2_event.go",
			SHA256: "a2d83bc870c6b8e7aeb2df41d904e3db17f1bc0117da7911f20eb8c4a73a94ef",
		},
		"runnerV2FoundationIntegrationTest": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/v2_foundation_integration_test.go",
			SHA256: "b6e8a85d519fe3fbde69b6d4a83b2218201e0635fd1afdd92bcef1bc399dcfde",
		},
		"runnerV2RuntimeDeliveryMigrationUp": {
			Path:   "services/workflow-control/migrations/000008_deliver_workflow_runner_authority_bindings.up.sql",
			SHA256: "3ab0b53c5b3d5f56792e6e7569eb33928cf129fd701d91d24f44c2570a8add1c",
		},
		"runnerV2RuntimeDeliveryMigrationDown": {
			Path:   "services/workflow-control/migrations/000008_deliver_workflow_runner_authority_bindings.down.sql",
			SHA256: "1abaac1f58443cce2a44a23566b47eb3fc7eada20c0fd141715f25dcd789e438",
		},
		"runnerV2RuntimeAdmissionSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/v2_admission.go",
			SHA256: "346b44b754cf4414b6895be8ef5f27e6be91ae950d5c60d3f32ea19c8d3acb78",
		},
		"runnerV2AuthorityBindingSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/v2_binding.go",
			SHA256: "3e1bd0ca0a3608365719eceb5852a2cd14405101b38eef2ba4bb777158d94178",
		},
		"runnerV2RuntimeDeliveryIntegrationTest": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/gs9f2_runtime_integration_test.go",
			SHA256: "25f8108cd7fc23fd492e771133e6268be755df8f7d59b045ceeead8060817418",
		},
		"runnerV2RuntimeDeliveryHTTPQualificationTest": {
			Path:   "services/workflow-control/cmd/runner-server/gs9f2_qualification_test.go",
			SHA256: "a2b7af31a242ca8493f2b3b4206376d675d8b4e672980e6250c23d861d68a33f",
		},
		"runnerV2AuthorityBindingDomainSource": {
			Path:   "services/workflow-control/internal/runnerstore/v2_binding.go",
			SHA256: "9a3ca099361f1b4fc64a40663b71752e3db4ef06580b14c0d51f19ad9c9c87a4",
		},
		"runnerV2AuthorityBindingLifecycleTest": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/gs9f2_binding_lifecycle_test.go",
			SHA256: "ed1291e7ab80893a11102028a5370a0db5cf5ca970826814055a85d010dda1d5",
		},
		"runnerV2RuntimeDeliverySchedulerSource": {
			Path:   "services/workflow-control/internal/runnerscheduler/session_v2.go",
			SHA256: "d89de11e4b4e99db20da29fdd5eedae1e82fe8dacfd0998b32895cb5fbc8bd26",
		},
		"runnerV2SchedulerCompositionSource": {
			Path:   "services/workflow-control/internal/runnerscheduler/scheduler.go",
			SHA256: "16e1312f559e103d7543c1865def85483afa4f5efe93149ea1a6cc01c0b56c8b",
		},
		"runnerV2RuntimeDeliverySchedulerTest": {
			Path:   "services/workflow-control/internal/runnerscheduler/session_v2_runtime_delivery_test.go",
			SHA256: "4e9d923339de96edf93412fef59f548f1cf47e3986919363f4dd17800a41b8c5",
		},
		"runnerV2RuntimeDeliveryConfigSource": {
			Path:   "services/workflow-control/internal/runnerconfig/config.go",
			SHA256: "89ff790c80f25b7fb9c9bdabdef4d1dc74333552f3b7e25470cd0155b5c97413",
		},
		"runnerV2RuntimeDeliveryWorkerRegistrySource": {
			Path:   "services/workflow-control/internal/workerregistry/registry.go",
			SHA256: "beb07cee5ab751d6a5c1a48ad955707a1cd15c7f1a9f0a31c5a53bf188d70910",
		},
		"runnerV2RuntimeDeliveryClaimSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/claim.go",
			SHA256: "5927c342e399ee46c5176235d623ce6a26c62ea039d92375abc6028851733e60",
		},
		"runnerV2RuntimeDeliveryStateMachineSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/v2_delivery.go",
			SHA256: "4238323e746bbeba33c33702ea906f56d6388467827b7d027c96fedc9a9b2ffc",
		},
		"runnerV2RuntimeDeliveryCancellationSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/v2_cancel.go",
			SHA256: "e81eafed98feb8b02af0807f71083d7b8e017ce80882d2365537081d236a8d99",
		},
		"runnerV2RuntimeDeliveryProcessRecoverySource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/process.go",
			SHA256: "8993acc692f1ce20e193de93ecf570d2afe24ef5672430b5ec4a67268be4b0ad",
		},
		"runnerV2BudgetPointReadSource": {
			Path:   "services/workflow-control/internal/budgetstore/postgres/read.go",
			SHA256: "20638b616e20d95ae714b02ade675e3eee4b746a324a3eaaf699517708acf3be",
		},
		"runnerV2RuntimeDeliveryHTTPHandlersSource": {
			Path:   "services/workflow-control/internal/runnerapp/handlers.go",
			SHA256: "fdd8bec3336f3e523dfc35f6f7f036b40e87d48787692f44b7a83324764e074e",
		},
		"runnerV2RuntimeDeliveryHTTPServerSource": {
			Path:   "services/workflow-control/internal/runnerapp/server.go",
			SHA256: "ccf73890dd1b8794d5161888795ae058969303853f06a573bce1e6a9f98f8a5b",
		},
		"runnerV2RuntimeDeliveryCompositionRootSource": {
			Path:   "services/workflow-control/cmd/runner-server/main.go",
			SHA256: "1464bd8b4a71b3f257388f465d533b8e6f8ee5e6a4dfad3d0dc2086850b3cd19",
		},
		"workflowPackageSurface": {
			Path:   "packages/workflows/package.json",
			SHA256: "619ba4eccb338e749dd95457114884113581f78869c0b6ef85a2fedfc6edf786",
		},
		"workflowRunStoreSource": {
			Path:   "packages/workflows/src/run-store.ts",
			SHA256: "04465ded2f9d00ecdf2ed5f891b46ee699a5b2fec81bedba3686f7bc1c49b882",
		},
		"workflowRunStoreRecoveryAccessSource": {
			Path:   "packages/workflows/src/internal/workflow-run-store-recovery-access.ts",
			SHA256: "d93a7db2ac375293d81da44398fa400381c0fbe522f1de6d0c853417909c5adf",
		},
		"workflowExecutionAuthoritySource": {
			Path:   "packages/workflows/src/execute.ts",
			SHA256: "e7bf367cf3fcd7ce0a51f1f00f9b0a09c3143eb2896633cc6ad795c6ed753832",
		},
		"workflowResumeReadOnlySource": {
			Path:   "packages/workflows/src/resume.ts",
			SHA256: "9504bf6323c3413fd2b7c8d0c04461c7bcee733671b73ef3d9aaef8ec271d5cf",
		},
		"workflowRunnerWorkerBinSource": {
			Path:   "packages/workflows/src/workflow-runner-worker-bin.ts",
			SHA256: "e7010e44b9d449da0b69aec1077707afbac217ae55b5e9deeceb504bb54b9782",
		},
		"workflowRunnerWorkerPublicSource": {
			Path:   "packages/workflows/src/workflow-runner-worker-public.ts",
			SHA256: "067840743014133fc8bbb9309abdc6ba805615afebe2d9a2e4508b2633ab235d",
		},
		"workflowRunRoutingPublicSurface": {
			Path:   "packages/workflows/src/index.ts",
			SHA256: "c4bcc20bc345717154b971c357ee885f587d9e377bd3480eb810482f87a77c4b",
		},
		"workflowRunRoutingSource": {
			Path:   "packages/workflows/src/workflow-run-routing.ts",
			SHA256: "528dae9356c14fc8bfe9acf692417d54dd4c07ebfcdd68398b1da9bfc06ba037",
		},
		"workflowRunRoutingConfigSource": {
			Path:   "packages/workflows/src/workflow-run-routing-config.ts",
			SHA256: "4eabc662d021fd83695f8334e00a6828848b42aa18c65122621de8226ab6c6c6",
		},
		"workflowControlRoutingIdentitySource": {
			Path:   "packages/workflows/src/workflow-control-routing-identity.ts",
			SHA256: "7a57d7343915424b7dc39d6735a3c13f063f7abe280d5a2030a1b17ac855784d",
		},
		"workflowRunProjectionSource": {
			Path:   "packages/workflows/src/workflow-run-projection.ts",
			SHA256: "f713a1f370f57560f5d0fc7998a7ffbe5419c7792d71b3bdc5483bb5a10c3517",
		},
		"workflowRunReadOnlyInspectionSource": {
			Path:   "packages/workflows/src/workflow-run-readonly-inspection.ts",
			SHA256: "c9b764a32e4f9955e0033f2d87bca09c99a3ccb93439015763afd0bc27c3b561",
		},
		"workflowRunReadOnlyInspectionTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-readonly-inspection.test.ts",
			SHA256: "149fb22c0dfcfa06e8ffa4c7e6115155d3f63082fabc060ace11dfa539da9b69",
		},
		"workflowRunnerControlClientSource": {
			Path:   "packages/workflows/src/workflow-runner-control-client.ts",
			SHA256: "e0c8549de59dbb9324999c0320b95fd8a7eb9fb38f41db1d8e943b6520ca5cfd",
		},
		"workflowRunnerSourceInvariantTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-source-invariants.test.ts",
			SHA256: "7356a76809d894cc99f85959f94b0de99a5e3b7efbd89d86e8c42ea26da86dfb",
		},
		"workflowCLICompositionSource": {
			Path:   "apps/cli/src/commands/collaboration.ts",
			SHA256: "578fb8d4503250d9dcb2bb0502acdb6b675dad1598640645f6c31b30127889fe",
		},
		"workflowTUIExecutorsSource": {
			Path:   "apps/cli/src/commands/tui-executors.ts",
			SHA256: "e0d76010c0157b7ab6f5e29216b5d4ff8458c8f4e04987f0b09ef9da6ac48349",
		},
		"workflowTUICompositionSource": {
			Path:   "apps/cli/src/commands/tui.ts",
			SHA256: "670232dc3453b9059572bf3080c95db110733bf16644b64ec3696631758a27ac",
		},
		"workflowTUIRunsViewSource": {
			Path:   "packages/tui/src/views/WorkflowRunsView.tsx",
			SHA256: "1209ea7befbb07295bca08560f96d24fe068a9fb9c0c04066e84e5be5f041ca3",
		},
		"workflowTUIRenderShellSource": {
			Path:   "packages/tui/src/views/render-shell.ts",
			SHA256: "2e8468c4c75470fb99d53af19278a2a60fc88ceca77a101330c4c9304f9f8c67",
		},
		"demoAIOrgRehearseSource": {
			Path:   "scripts/demo-ai-org-rehearse.ts",
			SHA256: "2ec2925fd27e02c534a9f5c104985b33156ad4bd9943cf22619f714c3f2e6f3b",
		},
		"workflowGoCheckSource": {
			Path:   "scripts/go-check.sh",
			SHA256: "f5c5213725f9c384c2e8bb393832ac9e192c978994a1b123d8df0e650069613b",
		},
		"workflowHostedGateSource": {
			Path:   ".github/workflows/notification-delivery-service.yml",
			SHA256: "2a80691d2271d0a24a40fa0a9a85e0f4673a7633c8b3b2bf57481bf841336d47",
		},
		"workflowControlAuthorityBindingValidationSource": {
			Path:   "services/workflow-control/internal/authoritybinding/validation.go",
			SHA256: "4a6b057dd26f58454a6e091d499ca91618cd14f5f7e1230356940c6270dc76fd",
		},
		"workflowControlAuthorityBindingValidationTest": {
			Path:   "services/workflow-control/internal/authoritybinding/validation_test.go",
			SHA256: "db69444811e9895fcdb89540989786cd1939615aeb9baea14b25c26232d7b973",
		},
		"workflowControlAuthorityBindingValidationVectors": {
			Path:   "services/workflow-control/internal/authoritybinding/testdata/routing_identity_vectors.json",
			SHA256: "f3655891c4b90904b5b26076cd65e8ff578fa656faed5979957afcc80c34eef2",
		},
		"workflowControlAuthorityClientSource": {
			Path:   "packages/workflows/src/workflow-control-authority-client.ts",
			SHA256: "0c489f7a2204a06817232c162ba446765c86489d0af9e6310fc5ccfe03bf994b",
		},
		"workflowRunnerExecutionClientSource": {
			Path:   "packages/workflows/src/workflow-runner-execution-client.ts",
			SHA256: "b9b57c25cee502c535057eb881fe5e576ccb89b7f6dee9c907a9f1090c44e922",
		},
		"workflowRunnerV2ControlClientSource": {
			Path:   "packages/workflows/src/workflow-runner-v2-control-client.ts",
			SHA256: "10408737e5cc0c9451eeba8e3e7e6fb02120639765110340c66c36f26cfc8566",
		},
		"workflowRunnerV2GoProjectionSource": {
			Path:   "packages/workflows/src/workflow-runner-v2-go-projection-store.ts",
			SHA256: "7cc527e04271b5dabf7cba3249767fe25265f9cc2b41771d8d5a35f1ad3b504b",
		},
		"workflowRunnerV2RuntimeDeliverySource": {
			Path:   "packages/workflows/src/workflow-runner-v2-runtime-delivery.ts",
			SHA256: "40cfdf8dc5ff31c0dc1c2875f059f242ccd2f63d4b7572c30728eb0bc6291bf4",
		},
		"workflowRunnerWorkerSource": {
			Path:   "packages/workflows/src/workflow-runner-worker.ts",
			SHA256: "356e074bc1e82e1d5c35bb0fbe567afba26a323fddcabf101334b4ad694a4021",
		},
		"workflowRunRoutingTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-routing.test.ts",
			SHA256: "0ac533b22765efb175d396615c39483c3aa6b25474429ec90e7af9cb92b7ee08",
		},
		"workflowRunnerExecutionClientTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-execution-client.test.ts",
			SHA256: "8450d28c669df3c0a20ab3ed77bc7d3b7d7e9e82a647ff64230abdee6c1b5854",
		},
		"workflowRunnerV2FoundationTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-v2-foundation.test.ts",
			SHA256: "f48c0b4626aeb4bca03b40e40221c2697c6ad4b23dffac763a921db5814373d7",
		},
		"workflowRunnerWorkerTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-worker.test.ts",
			SHA256: "12a1a169b5af5e82578d17294723ad27cb0e6bde4d9cec9689fffae518bc2ba2",
		},
		"workflowControlAuthorityConfigSource": {
			Path:   "services/workflow-control/internal/config/authority.go",
			SHA256: "6d40c0cc25228b4cccbe5f13ef987260b6ad7f9e6e6ffdaaceb4ecc5d010250a",
		},
		"workflowControlAuthorityConfigTest": {
			Path:   "services/workflow-control/internal/config/authority_test.go",
			SHA256: "c17ee5ebc0e157979d7fc20e4d6a45fe7806a975f59b35e36ff4ba99878bee95",
		},
		"workflowControlAuthorityHTTPServerSource": {
			Path:   "services/workflow-control/internal/authorityapp/server.go",
			SHA256: "2d96f52cf859aedb506498b50a5c8b17b336306c861e733e950410922f7b2a28",
		},
		"workflowControlAuthorityHTTPHandlersSource": {
			Path:   "services/workflow-control/internal/authorityapp/handlers.go",
			SHA256: "c6b3dabcd6f710b4696735699b54b469cdd433c538a58f36a2f268cc4c8afca7",
		},
		"workflowControlAuthorityHTTPServerTest": {
			Path:   "services/workflow-control/internal/authorityapp/server_test.go",
			SHA256: "c88aea51348e77e315a4f12cd2b34938002375afd42b5db19cd40e13545144a8",
		},
		"workflowControlAuthorityCompositionRootSource": {
			Path:   "services/workflow-control/cmd/authority-server/main.go",
			SHA256: "53fcfb540b1a6b2c8d4aaa94aa39c686b64e1ccffed58c28de1b870ddf49d840",
		},
		"workflowRunnerV2RuntimeDeliveryConfigTest": {
			Path:   "services/workflow-control/internal/runnerconfig/config_test.go",
			SHA256: "41acefe7cb4e6cbdc436049b8c5e2acadcc489ca7f1198d4c34360337391b1d9",
		},
		"workflowRunnerV2WorkerRegistryTest": {
			Path:   "services/workflow-control/internal/workerregistry/registry_test.go",
			SHA256: "3968f7e39b4edeaf891a3c56c00384d92b9b4af5a6291aaa7df932dd0b7c6318",
		},
		"workflowRunnerV2HTTPServerTest": {
			Path:   "services/workflow-control/internal/runnerapp/server_test.go",
			SHA256: "6291be53742c4f3086f6caf2de91b6d3877077e6746f04b7c1166a74833c0372",
		},
		"workflowRunnerResumeSource": {
			Path:   "packages/workflows/src/internal/workflow-runner-resume-source.ts",
			SHA256: "b9fd5aaca989208f9cde435ec6f8bf19fe43a355dc166a1359d9a44b35e5a8ff",
		},
		"workflowRunProjectionReadTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-projection.test.ts",
			SHA256: "52d9fafa29265a734c497152230c0ced8ee72959d8c46f43020fdf001188283c",
		},
		"workflowGoExecutionRecoveryTest": {
			Path:   "packages/workflows/src/__tests__/execute-go-authority.test.ts",
			SHA256: "5f61881238629bf4c5e385f9ae9f08dd320eb1f9f37ab86ffff19d5197026274",
		},
		"runnerMixedOrphanRestartTest": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/runner_recovery_restart_integration_test.go",
			SHA256: "d4da6b2efab7b42ddd2dc46964a52e4a22f8decc88c2dcbba4552dcc5be280cc",
		},
	}
	if !reflect.DeepEqual(manifest.SourceInputs, wantSourceInputs) {
		t.Fatalf("source manifest source inputs drifted: %#v", manifest.SourceInputs)
	}
	wantContractInputs := map[string]manifestReference{
		"workflowCheckpointShadowContractManifest": {
			Path:   "packages/workflows/contracts/workflow-checkpoint-shadow/v1/manifest.json",
			SHA256: "e6b4edefc887f17a83237471e168f4c0819b7848ad6a63d2446fc572bdcff000",
		},
		"workflowControlContractManifest": {
			Path:   "packages/workflows/contracts/workflow-control/v1/manifest.json",
			SHA256: "3c7440ae6254337a6e1d93beb2e531d591fa2f781717d3a8e96d0d2e5d872d86",
		},
		"workflowControlShadowContractManifest": {
			Path:   "packages/workflows/contracts/workflow-control-shadow/v1/manifest.json",
			SHA256: "91e6eaab207e9baa85fb3be84e1b3370983e881f0057a97cb566c5dc834f5f23",
		},
		"workflowRunnerContractManifest": {
			Path:   "packages/workflows/contracts/workflow-runner/v1/manifest.json",
			SHA256: "908ff368f35033206b975a0421396f49e588098f040aecef2fdd18cd8b67ece6",
		},
		"workflowControlAuthorityContractManifest": {
			Path:   "packages/workflows/contracts/workflow-control-authority/v2/manifest.json",
			SHA256: "7994937f8b66c67ba4c90ce9018fcbde095ad34e6f377b3cd09959bb5c53d2ba",
		},
		"workflowEffectControlContractManifest": {
			Path:   "packages/workflows/contracts/workflow-effect-control/v1/manifest.json",
			SHA256: "76929e860fc42573e87dfe09f106d15f4913b2da3da5f96e4a8c1d58d095d1c2",
		},
		"workflowEffectShadowContractManifest": {
			Path:   "packages/workflows/contracts/workflow-effect-shadow/v1/manifest.json",
			SHA256: "58208d1618b6a629e821dbb10d214a9a57eaf6b3771a1b61e1d2198c4038354a",
		},
		"workflowBudgetAuthorityContractManifest": {
			Path:   "packages/workflows/contracts/workflow-budget-authority/v1/manifest.json",
			SHA256: "83e5f88e01cbeb5e301004c34ed7cad446b98a59812771a9bf3be562a0509b3b",
		},
		"workflowRunnerAuthorityBindingContractManifest": {
			Path:   "packages/workflows/contracts/workflow-runner-authority-binding/v1/manifest.json",
			SHA256: "2d50a803ef9db37695d1dfae3ce149ee4558948adea637433160077cdd9fda28",
		},
		"openapi": {
			Path:   "services/workflow-control/docs/api/openapi.yaml",
			SHA256: "3215e50eadda34c7675cf06449c8b26f567f7f369a26d409c95fe7a7f901343f",
		},
		"runnerOpenapi": {
			Path:   "services/workflow-control/docs/api/runner-openapi.yaml",
			SHA256: "58262cf888605313bd31c76bf7694ecf31321154be67fddeebbcfc589ff4b6ff",
		},
		"authorityOpenapi": {
			Path:   "services/workflow-control/docs/api/authority-openapi.yaml",
			SHA256: "6699c816b03a92915237ecab8870850e44dfae896df8bd43d40ce2dc62fa828c",
		},
		"checkpointShadowOpenapi": {
			Path:   "services/workflow-control/docs/api/checkpoint-shadow-openapi.yaml",
			SHA256: "a33f978174fa9b82393864d5b97f03082196a8d369e07d60cc35ce69345fa67a",
		},
		"effectShadowOpenapi": {
			Path:   "services/workflow-control/docs/api/effect-shadow-openapi.yaml",
			SHA256: "9d279805c2dca29d55b070b90f87576d6f663b95aefda3b286eecb4dde726876",
		},
		"budgetAuthorityOpenapi": {
			Path:   "services/workflow-control/docs/api/budget-authority-openapi.yaml",
			SHA256: "3e9c73898eef5f9e3c5687d2afe40f5e341ce4ce4d1bb5ab09095393abc5c3a4",
		},
	}
	if !reflect.DeepEqual(manifest.ContractInputs, wantContractInputs) {
		t.Fatalf("source manifest contract inputs drifted: %#v", manifest.ContractInputs)
	}
	wantNonClaims := []string{
		"CHECKPOINT_RESUME_AUTHORITY", "FULL_GO_CUTOVER", "LIVE_VERIFIED", "PRODUCTION",
		"QODER_VERIFIED", "REGISTRY_INCLUSION", "RELEASE", "REMOTE_CONNECTOR",
		"SIGNED_PROVENANCE", "USER_VISIBLE_READ_AUTHORITY", "WORKFLOW_BUDGET_PRODUCTION_AUTHORITY",
		"WORKFLOW_BUDGET_PRODUCTION_INITIAL_POLICY_SOURCE",
		"WORKFLOW_EFFECT_APPROVAL_AUTHORITY",
		"WORKFLOW_EFFECT_EXECUTION_AUTHORITY", "WORKFLOW_ROUTING_ALLOWLIST_EXPANSION",
	}
	actualNonClaims := append([]string(nil), manifest.Scope.NonClaims...)
	sort.Strings(actualNonClaims)
	if strings.Join(actualNonClaims, "\n") != strings.Join(wantNonClaims, "\n") {
		t.Fatalf("source manifest non-claims = %v", manifest.Scope.NonClaims)
	}
	for _, references := range []map[string]manifestReference{manifest.SourceInputs, manifest.ContractInputs} {
		for _, reference := range references {
			assertReference(t, repositoryRoot, reference)
		}
	}
	assertReference(t, repositoryRoot, manifest.LegalInputs.License)
	assertReference(t, repositoryRoot, manifest.LegalInputs.Notice)
	assertReference(t, repositoryRoot, manifest.LegalInputs.ThirdPartyNotices.manifestReference)
	assertReference(t, repositoryRoot, manifest.LegalInputs.RepositorySBOMInput.manifestReference)
	if manifest.LegalInputs.ThirdPartyNotices.ProductionModuleCount != 13 ||
		manifest.LegalInputs.RepositorySBOMInput.Scope != "SELECTED_REPOSITORY_SOURCE_AND_BUILD_INPUTS" ||
		manifest.LegalInputs.RepositorySBOMInput.Attestation != "UNSIGNED" {
		t.Fatal("source manifest distribution scope drifted")
	}
}

func TestRepositorySBOMAndComposeStayBounded(t *testing.T) {
	_, serviceRoot := roots(t)
	var sbom struct {
		BOMFormat   string `json:"bomFormat"`
		SpecVersion string `json:"specVersion"`
		Components  []struct {
			Name, Version string
		} `json:"components"`
	}
	body, err := os.ReadFile(filepath.Join(serviceRoot, "SBOM.cdx.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &sbom); err != nil {
		t.Fatal(err)
	}
	if sbom.BOMFormat != "CycloneDX" || sbom.SpecVersion != "1.6" || len(sbom.Components) != 13 {
		t.Fatalf("unexpected SBOM inventory: %#v", sbom)
	}
	compose, err := os.ReadFile(filepath.Join(serviceRoot, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range []string{
		`127.0.0.1:${WORKFLOW_CONTROL_DB_PORT:-5432}:5432`,
		`127.0.0.1:${WORKFLOW_CONTROL_APP_PORT:-8080}:8080`,
		`127.0.0.1:${WORKFLOW_CONTROL_PROMETHEUS_PORT:-9090}:9090`,
	} {
		if !strings.Contains(string(compose), binding) {
			t.Fatalf("Compose is missing loopback binding %q", binding)
		}
	}
}

func assertReference(t *testing.T, repositoryRoot string, reference manifestReference) {
	t.Helper()
	if len(reference.SHA256) != sha256.Size*2 {
		t.Fatalf("invalid SHA-256 for %s", reference.Path)
	}
	if decoded, err := hex.DecodeString(reference.SHA256); err != nil || len(decoded) != sha256.Size {
		t.Fatalf("invalid SHA-256 for %s", reference.Path)
	}
	target := filepath.Clean(filepath.Join(repositoryRoot, filepath.FromSlash(reference.Path)))
	relative, err := filepath.Rel(repositoryRoot, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		t.Fatalf("manifest path escapes repository: %s", reference.Path)
	}
	body, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read %s: %v", reference.Path, err)
	}
	actual := sha256.Sum256(body)
	if hex.EncodeToString(actual[:]) != reference.SHA256 {
		t.Fatalf("SHA-256 drift for %s", reference.Path)
	}
}

func roots(t *testing.T) (string, string) {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source manifest test path")
	}
	serviceRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
	return filepath.Clean(filepath.Join(serviceRoot, "..", "..")), serviceRoot
}
