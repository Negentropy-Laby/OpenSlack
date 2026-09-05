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
			"WORKFLOW_RUNNER_EXPLICIT_BINDING_RECONCILIATION",
			"WORKFLOW_CONTROL_DURABLE_RESUME_SOURCE_FENCE",
			"WORKFLOW_CONTROL_RECONCILED_ORPHAN_PAUSE",
		}, "\n") {
		t.Fatalf("source manifest widened authority: %#v", manifest)
	}
	if len(manifest.ContainerInputs) != 6 || manifest.ContainerInputs["goVersion"] != "1.26.5" ||
		len(manifest.SourceInputs) != 148 || len(manifest.ContractInputs) != 16 {
		t.Fatal("source manifest input inventory drifted")
	}
	wantSourceInputs := map[string]manifestReference{
		"dockerfile": {
			Path:   "services/workflow-control/Dockerfile",
			SHA256: "67d82836f02c2d6e4427de945bc8e166d36350de9272cefa682a11ea3b6fe5b4",
		},
		"goMod": {
			Path:   "services/workflow-control/go.mod",
			SHA256: "d7611c1bc73c5b6cceee40770a085c7f4172d885b3ea8f4a7fd8d8694e3fda44",
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
			SHA256: "f02ced7d1cddc7a928911cac1a9d751647f9e1e69fb412d1869b110f4694eb1f",
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
			SHA256: "622a61bcec5b1fed81bee3a5382fcb401e7b7e2ff0bfdef8e8760b75cb1729fe",
		},
		"runnerV2RuntimeDeliveryIntegrationTest": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/gs9f2_runtime_integration_test.go",
			SHA256: "bdfddc094da41f3e254643ce91bdfa48a6a57630c04153065d1d7d415f1be3f4",
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
			SHA256: "33f411776501095742add3702ba9a64de6f29289f115171ca6a9fd3ed6526e11",
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
			SHA256: "782483235f346fddb54f2af289e175b53c15eacba34e55605e87584035dfb02c",
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
			SHA256: "79f2cf079675a17f4ae929df731e2e9ba741ac761a28ef418707ffa01c66af82",
		},
		"runnerV2RuntimeDeliveryCompositionRootSource": {
			Path:   "services/workflow-control/cmd/runner-server/main.go",
			SHA256: "a9c8f2ae95664e7947700fa65fa01d573a33f30d618b26d2d440a228fa4e63cd",
		},
		"workflowPackageSurface": {
			Path:   "packages/workflows/package.json",
			SHA256: "619ba4eccb338e749dd95457114884113581f78869c0b6ef85a2fedfc6edf786",
		},
		"workflowRunStoreSource": {
			Path:   "packages/workflows/src/run-store.ts",
			SHA256: "970b2465b9a4a8bcba9b80def6c860e5780508d34b07ef8e19646dc7682e9e20",
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
			SHA256: "f1e1f7405529ab9863751e30cf57f901d8ac0037af61a0bbad0eb7709e7133c7",
		},
		"workflowRunRoutingSource": {
			Path:   "packages/workflows/src/workflow-run-routing.ts",
			SHA256: "f2431d805336c4da53c4e992087560aa2f83fdb4bc8401cfedacfdfcbfe42abd",
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
			SHA256: "9109819a72962899ff91db0d628049e5b66835d5c396174441efc34c3a6fe46e",
		},
		"workflowRunReadOnlyInspectionSource": {
			Path:   "packages/workflows/src/workflow-run-readonly-inspection.ts",
			SHA256: "e65e4e53df6b326f6f0ecb0429e96cefc67008f409bc0cd11e069fd75e5239cc",
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
			SHA256: "27c7ac369eeecbabb01dae350516410ed3bc58deced26bcbefac4ad3f42aedc8",
		},
		"workflowTUIExecutorsSource": {
			Path:   "apps/cli/src/commands/tui-executors.ts",
			SHA256: "e0d76010c0157b7ab6f5e29216b5d4ff8458c8f4e04987f0b09ef9da6ac48349",
		},
		"workflowTUICompositionSource": {
			Path:   "apps/cli/src/commands/tui.ts",
			SHA256: "58e02a3d14a4b0cae2dfa4ef9f5e47b26de9f82247f6da3af587054566d7a79e",
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
			SHA256: "d525251447925717442d1170b87f5e469006e979ca3c55c05b76171e749cdeca",
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
			SHA256: "6dc28fc0c8f77e9864a86ba2d0ab90db60d439d5ced0bf3aadc77747a0ab2b51",
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
			SHA256: "7e7e352b56f3412910b7728dccd23868085c21c20b79226b4f502d684878cef7",
		},
		"workflowRunnerWorkerSource": {
			Path:   "packages/workflows/src/workflow-runner-worker.ts",
			SHA256: "3f9d633dbae53a20bd125d350093babcdb9784735bf68ab6b179eb08827e1e07",
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
			SHA256: "5831bf81d5b0aafe027cf565bc0f51d326f858b3b0a7935f11c7cb66cc89b255",
		},
		"workflowControlAuthorityHTTPHandlersSource": {
			Path:   "services/workflow-control/internal/authorityapp/handlers.go",
			SHA256: "c6b3dabcd6f710b4696735699b54b469cdd433c538a58f36a2f268cc4c8afca7",
		},
		"workflowControlAuthorityHTTPServerTest": {
			Path:   "services/workflow-control/internal/authorityapp/server_test.go",
			SHA256: "40e090a08dcb5b5864dd669f96d5dac28dae9052ad5034db6b2784d947d4c0e2",
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
			SHA256: "9d7963839e47d3a6524515989b6ce6b8ce0b0e333204f17695493aaa87284fba",
		},
		"workflowRunProjectionReadTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-projection.test.ts",
			SHA256: "2d698feb9f3b7ddcdd920b4c0d8459304713ae97966253fed7a6c70c42fc7625",
		},
		"workflowGoExecutionRecoveryTest": {
			Path:   "packages/workflows/src/__tests__/execute-go-authority.test.ts",
			SHA256: "5f61881238629bf4c5e385f9ae9f08dd320eb1f9f37ab86ffff19d5197026274",
		},
		"runnerMixedOrphanRestartTest": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/runner_recovery_restart_integration_test.go",
			SHA256: "d4da6b2efab7b42ddd2dc46964a52e4a22f8decc88c2dcbba4552dcc5be280cc",
		},
		"workflowRunReadErrorsSource": {
			Path:   "packages/workflows/src/workflow-run-read-errors.ts",
			SHA256: "0954ef6ca9adc0b842c2294fd56f1ae00d154a43bac2ba4b39d0925a357c45a4",
		},
		"workflowRunReadQuery": {
			Path:   "packages/workflows/src/workflow-run-read-query.ts",
			SHA256: "ea383b08041b3c72c9f2a8c59fd59da3bd0229f0d5811954838f66a75c54eb41",
		},
		"workflowRunReadQueryTests": {
			Path:   "packages/workflows/src/__tests__/workflow-run-read-query.test.ts",
			SHA256: "6f807dce5a146dc0e56791b6e593483057e5610aac3a47d6a18d2f88c482794f",
		},
		"runnerRecoveryEvidenceMigrationUp": {
			Path:   "services/workflow-control/migrations/000009_index_workflow_runner_recovery_evidence.up.sql",
			SHA256: "624478ec8a3ff795c2d7090f017ca463152cf43b70f72a71132e2fc80fbb990e",
		},
		"runnerRecoveryEvidenceMigrationDown": {
			Path:   "services/workflow-control/migrations/000009_index_workflow_runner_recovery_evidence.down.sql",
			SHA256: "2cce9a7b400a78f64465a9012761609d18a31e50e49e273423a12918e79cd043",
		},
		"runnerRecoveryEvidenceDomain": {
			Path:   "services/workflow-control/internal/runnerstore/recovery_evidence.go",
			SHA256: "a8e24ac9c463ce5d073995818a0065f962345d8c1412294030fc006eec8f7a7b",
		},
		"runnerRecoveryEvidenceStore": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_evidence.go",
			SHA256: "088225cdaf65de538de826d8d3c2e15d22993d5ea9bf6ba6db48f83131feac8c",
		},
		"runnerRecoveryEvidenceHTTP": {
			Path:   "services/workflow-control/internal/runnerapp/recovery_evidence.go",
			SHA256: "fdc91202901f373970ede9590be7a7fdc7afd65a5d4d519600d795dcee8e479a",
		},
		"runnerRecoveryEvidenceHTTPTests": {
			Path:   "services/workflow-control/internal/runnerapp/recovery_evidence_test.go",
			SHA256: "0abc0b7066b483a922627d6ac0e9c7126f189c6dcd4ca6ded1c3350a3036cd7b",
		},
		"runnerRecoveryEvidencePostgresTests": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_evidence_integration_test.go",
			SHA256: "a88a01a9b577c8519914d9d1be5928962e04cce67195fa2955951363a2ba3bc8",
		},
		"runnerRecoverySchemaReadiness": {
			Path:   "services/workflow-control/internal/databaseready/databaseready.go",
			SHA256: "1293a6b51d1de4b032b03d2f1754c0153677f83a755fc87b02941bff32fe6e82",
		},
		"runnerRecoveryPostgresTestSupport": {
			Path:   "services/workflow-control/internal/testsupport/postgres.go",
			SHA256: "84a4bcae3f59656474258a4df7ed648d9ee4ac20a433d9b749dc898969d3dff9",
		},
		"workflowRecoveryEvidence": {
			Path:   "packages/workflows/src/workflow-run-recovery-evidence.ts",
			SHA256: "cdb39522fe7aea0aca8a0f2dc4a2c7e26ee83fbdb918de97c0ee1c9572a24c62",
		},
		"workflowCheckpointRepair": {
			Path:   "packages/workflows/src/workflow-checkpoint-repair.ts",
			SHA256: "7f8148f8961b41810c14296192ad3e75ae1ba0926885b3d798365c0e2d8920da",
		},
		"workflowCheckpointEvidence": {
			Path:   "packages/workflows/src/internal/workflow-runner-checkpoint-evidence.ts",
			SHA256: "63c4a5701ed8371f514d6e03d73197f118241178491e46238959d050e6eb3381",
		},
		"workflowAuthorityFailure": {
			Path:   "packages/workflows/src/internal/workflow-authority-failure.ts",
			SHA256: "3145400add6dbe1e28e17179c567af6a4d4d2222b0f6092fff10b7372dfebbd5",
		},
		"workflowOwnerFileSecurity": {
			Path:   "packages/workflows/src/workflow-control-shadow.ts",
			SHA256: "2932249f425d9999cb589dd39db2baefade8a49644f22e535668f47aae518fae",
		},
		"workflowRunnerAuthorityClient": {
			Path:   "packages/workflows/src/workflow-runner-authority-binding-client.ts",
			SHA256: "3af16f89e7201f975fd075759dccf3929ddba6e982113243862ea70b4536de4d",
		},
		"workflowRunnerAuthorityRuntime": {
			Path:   "packages/workflows/src/workflow-runner-authority-binding-runtime.ts",
			SHA256: "853fb0d6c619e7b0d450cbff3867ee47d904882fb182f2a9857955af43eadde3",
		},
		"workflowRunnerBudgetClient": {
			Path:   "packages/workflows/src/workflow-runner-budget-authority-client.ts",
			SHA256: "0ddcb76a6bc12806445005560af04bee5a227e93891d1b3edfc797937d1b8882",
		},
		"workflowRunnerAuthoritySources": {
			Path:   "packages/workflows/src/workflow-runner-runtime-authorities.ts",
			SHA256: "ff6fa926fb4a2b710e55bc1018a2bfa98be421ecee5e085e39a23a55ea7c73eb",
		},
		"workflowRunnerV2Session": {
			Path:   "packages/workflows/src/workflow-runner-v2-session.ts",
			SHA256: "6f964c3f2c15eeedd346350e715578bb28e733f38e5d022fd9e7dc84de2e6672",
		},
		"workflowRecoveryEvidenceTests": {
			Path:   "packages/workflows/src/__tests__/workflow-run-recovery-evidence.test.ts",
			SHA256: "2893d9b0cfc17c454b4b32e7b2df2016a57d487e2e16259c8e53f24c4342ab47",
		},
		"workflowCheckpointRepairTests": {
			Path:   "packages/workflows/src/__tests__/workflow-checkpoint-repair.test.ts",
			SHA256: "b57eed00ee255a63f22dd698d555edd60f162a3725688659609a0f266b26faba",
		},
		"workflowRecoveryTestFixtures": {
			Path:   "packages/workflows/src/__tests__/workflow-recovery-fixtures.ts",
			SHA256: "972d5747739c2603bfc262c4353d32facd3d22b763ed35c080a51f094b882438",
		},
		"goCheckVerifierRegression": {
			Path:   "packages/workspace/src/__tests__/go-check-script.test.ts",
			SHA256: "978080071354fdcb8af91873f3f25de5c178ef0565063a71da4c12b239ad980b",
		},
		"workflowEvidenceFileSource": {
			Path:   "packages/workflows/src/internal/workflow-evidence-file.ts",
			SHA256: "41953bcbe3ae32e49c9f07796a232d688cf9d5ed7ab7cab32bf393185008a122",
		},
		"workflowReadCorrectnessTest": {
			Path:   "packages/workflows/src/__tests__/workflow-read-correctness.test.ts",
			SHA256: "eeaed41f2ced64e0e3791024158c3f755b3329161769f1d8eb8ec94f17aebd65",
		},
		"workflowMcpReadMetadataSource": {
			Path:   "apps/mcp/src/workflow-read-metadata.ts",
			SHA256: "6fc154ad4a9491bfdac4ad95c039cf196488856e9a4f28ee2c328832a6404dc7",
		},
		"workflowMcpReadErrorsTest": {
			Path:   "apps/mcp/src/__tests__/workflow-read-errors.test.ts",
			SHA256: "ed291287fa71356cc99862b1a9a3f2b0d1619b651f70ab6325f372c52737835f",
		},
		"workflowCliReadBoundaryTest": {
			Path:   "apps/cli/src/__tests__/workflow-read-boundary.test.ts",
			SHA256: "16e2a69a140596ab811b0e085f912cdd250c2a24347533d00591ead1eaf8fae4",
		},
		"workflowResumeIntent": {
			Path:   "packages/workflows/src/internal/workflow-resume-intent.ts",
			SHA256: "1a7a023cccff91a82a985be0590388d80a8f35321d115bf46698610c1b1d2457",
		},
		"workflowBindingReconciliationContract": {
			Path:   "packages/workflows/src/workflow-binding-reconciliation-contract.ts",
			SHA256: "b0b98dffb364aa874d3bbbea7b83458c59d7fc050f5c56885bd40c5928b84fac",
		},
		"workflowBindingReconciliation": {
			Path:   "packages/workflows/src/workflow-binding-reconciliation.ts",
			SHA256: "2e51b5b921f92491e09c7cf73aad01d4c403b4c5ce078ec2d93980fb3750642b",
		},
		"workflowBindingReconciliationTests": {
			Path:   "packages/workflows/src/__tests__/workflow-binding-reconciliation.test.ts",
			SHA256: "52928986ba59615655b1d322c60cfd5f1422d76d612df453ac4e605750c029b0",
		},
		"workflowReconciliationFixtures": {
			Path:   "packages/workflows/src/__tests__/workflow-reconciliation-fixtures.ts",
			SHA256: "c4a373fc6e8dee962064a5d87fa1e456fccd44cfdb0e197c2c520c9abe7af869",
		},
		"workflowRecoveryContractTests": {
			Path:   "packages/workflows/src/__tests__/workflow-recovery-contract.test.ts",
			SHA256: "2002177b0e0150a49997d164801b270972176d95d9f60f3cdab00b5fed4427d7",
		},
		"workflowControlHttpTests": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-control-http.test.ts",
			SHA256: "58378f15af02fb133fe8b23f276feb28c68e1c7c929fccf403dd879183792f1a",
		},
		"workflowRecoveryContractGenerator": {
			Path:   "scripts/workflow-recovery-contracts/index.ts",
			SHA256: "7147336a057bc5d56193c025d0836044186a871e46e592676735404161c577c9",
		},
		"workflowRecoveryContractGeneratorConfig": {
			Path:   "scripts/workflow-recovery-contracts/tsconfig.json",
			SHA256: "16d1078d3a31644a7132e3e5b96cbfc984342d30f0256b690b6d43afcaef17f5",
		},
		"runnerBindingReconciliation": {
			Path:   "services/workflow-control/internal/runnerstore/binding_reconciliation.go",
			SHA256: "d1d7a392ff1420ba0d9a491b11c6620b8ac9d007ef3db35491412ddccd098579",
		},
		"runnerBindingReconciliationPostgres": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/binding_reconciliation.go",
			SHA256: "98919683d0c871b40e976f418997aeae8acd9cbbd5cc5a574654b47094ff0ef9",
		},
		"runnerReconciliationOverlay": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/settlement_overlay.go",
			SHA256: "6381fdd3e441d54a96ee14057b91bd75266d5458429014d1093260652d96052d",
		},
		"runnerRecoveryEffectFrontier": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_effect_frontier.go",
			SHA256: "7be0db57ea8dd22908720528ef1431b87250188b6e37740610fcd793ba604dea",
		},
		"runnerRecoveryPause": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_pause.go",
			SHA256: "7f46508a70006b9eee6eb9916edd8d9336bf66f13b6037388920953fab2cd9b8",
		},
		"runnerRecoveryEvidenceV2": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_evidence_v2.go",
			SHA256: "24ce8b9ceb41f22413f58d7950f149f4261c4e4a35751da9e4eaa197491544c1",
		},
		"runnerBindingReconciliationHandler": {
			Path:   "services/workflow-control/internal/runnerapp/binding_reconciliation.go",
			SHA256: "7f1b1282a1ce132d57f063bdb10592964eccb584a184b696cf8a53b298141a86",
		},
		"runnerBindingReconciliationHandlerTests": {
			Path:   "services/workflow-control/internal/runnerapp/binding_reconciliation_test.go",
			SHA256: "0cf6d8989446d6794d77c8915cc2fac96bf56a4a31e9986933371e223a0d55ec",
		},
		"runnerBindingReconciliationPostgresTests": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/binding_reconciliation_integration_test.go",
			SHA256: "3258f9a07f013bac3716f6311024093ccd93445577923dee68b6286d16d4461d",
		},
		"runnerReconciliationRestartTests": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/reconciliation_restart_integration_test.go",
			SHA256: "3776470a7fbcbe48e08b7656bf3d7c8e29e349f9c3e62bbae115489cc4753f63",
		},
		"runnerRecoveryContractGenerated": {
			Path:   "services/workflow-control/internal/runnerstore/recovery_contract.generated.go",
			SHA256: "6d18fe20cd89dbfbb86a4617c7e15ffda04ecd4a2687d54db210664bd94ba83a",
		},
		"runnerRecoveryContractTests": {
			Path:   "services/workflow-control/internal/runnerstore/recovery_contract_test.go",
			SHA256: "80e85f45ca90508bbfebbea09aac85a412be07bd642a1b0187a4a9aa70d38423",
		},
		"authorityStorageProofHandler": {
			Path:   "services/workflow-control/internal/authorityapp/storage_proof.go",
			SHA256: "99ca0d22c1d35f6b3587220e7b89587ede564c097c1fe04dd52135b546473c74",
		},
		"authorityStorageProofStore": {
			Path:   "services/workflow-control/internal/authoritystore/postgres/storage_proof.go",
			SHA256: "476b68e60f6d0f20113bd7e66411fcf0f1b8691b37a6317354e5e4609cf41dd7",
		},
		"storageProof": {
			Path:   "services/workflow-control/internal/storageproof/proof.go",
			SHA256: "79d60ca3a62513c25ef154e2fd76febc75af3af076c31fe910437f50ce03e093",
		},
		"storageProofClient": {
			Path:   "services/workflow-control/internal/storageproof/client.go",
			SHA256: "9f7e5cb9fd85d208bfca3e6dfb128a8f741e39dfc8af754a11cbd89e3cf29fa8",
		},
		"bindingReconciliationMigrationUp": {
			Path:   "services/workflow-control/migrations/000010_reconcile_workflow_runner_bindings.up.sql",
			SHA256: "d112f465df59d339d4f0da2170d67a9b8145afc1d85eb67e50690c4e8d44b04f",
		},
		"bindingReconciliationMigrationDown": {
			Path:   "services/workflow-control/migrations/000010_reconcile_workflow_runner_bindings.down.sql",
			SHA256: "df8e3cf35949c1bc710c14c88e463a2a244ab4dcca8bb406583b4cff4082a592",
		},
		"storageProofClientTests": {
			Path:   "services/workflow-control/internal/storageproof/client_test.go",
			SHA256: "a54491c791a3cde105cb35c67beee992b6fb7d8f0fcceeaf62ab094b93998c4b",
		},
		"storageProofTests": {
			Path:   "services/workflow-control/internal/storageproof/proof_test.go",
			SHA256: "e5e7dbaa788eb6b7a32d86aaa9c8a196da8d00e3e4dae9cb6f1fea818ee92672",
		},
		"workflowBindingReconciliationCommandTests": {
			Path:   "packages/workflows/src/__tests__/workflow-binding-reconciliation-command.test.ts",
			SHA256: "bb7c822135bcd9136a3c5b53f12a861dbc1ac62d67912facb608239d60a73ee8",
		},
		"workflowRecoveryCLICommandTests": {
			Path:   "apps/cli/src/__tests__/workflow-recovery-command.test.ts",
			SHA256: "f31f5e4bcc2341f0ef487f72ffc7fc9d570d06d14693f1bce0032888781ae72a",
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
			SHA256: "c5e08ed2c8b9d3e8260d395558fbc85bcf3521c2d3a3f41802f6df08f546f3e5",
		},
		"authorityOpenapi": {
			Path:   "services/workflow-control/docs/api/authority-openapi.yaml",
			SHA256: "c124cac51e2221598406ce405458ec7566771b78ee2edd01796dfa4d34ef10f4",
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
		"workflowRecoveryContractManifest": {
			Path:   "packages/workflows/contracts/workflow-recovery/v2/manifest.json",
			SHA256: "3e8b88ccea716dd5e35ec08228b6020b58ece06ab6ce050da4d07f0865a27a22",
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
