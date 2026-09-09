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
		len(manifest.SourceInputs) != 196 || len(manifest.ContractInputs) != 17 {
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
			SHA256: "bf149ec92996802ea48b5dc1a4dc27e1002f75d4a5a4efed0948fe0b6987936b",
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
			SHA256: "602f35a5d42c29f2409a229108ebc64ba9459d59f38c3777a719e69f9ece7a22",
		},
		"runnerV2RuntimeDeliveryIntegrationTest": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/gs9f2_runtime_integration_test.go",
			SHA256: "4230c19e76e1e9befa3f8fa35d2bb2a56da1c3ca906101a5838f762d4e7a6f76",
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
			SHA256: "93071be4d810b919365fd9697233712a29139246aaa5c4c8a86ffba1e942299e",
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
			SHA256: "3e0b8d998f372a2fb82058ffaa88001e6e41fcabb6508b98bc9c866e44d2b009",
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
			SHA256: "1d597a4afb2a9e4d374c59788b7ab43c43b07883ca60a2ea47ff1cf3ac196467",
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
			SHA256: "801b63ef3c12027279ea54efec618ac3f12711fc17cd8c0d127ff6f9a4b990f7",
		},
		"runnerV2RuntimeDeliveryCompositionRootSource": {
			Path:   "services/workflow-control/cmd/runner-server/main.go",
			SHA256: "4bb1b6b1fbaed9cb4da4280aa2c6d321df22ae1eaf757330e6f066943c052a3a",
		},
		"workflowPackageSurface": {
			Path:   "packages/workflows/package.json",
			SHA256: "619ba4eccb338e749dd95457114884113581f78869c0b6ef85a2fedfc6edf786",
		},
		"workflowRunStoreSource": {
			Path:   "packages/workflows/src/run-store.ts",
			SHA256: "fb135dea78ac99bd196b61072516d2a7d585ef490a355ee574e9b0ef3b2a5200",
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
			SHA256: "6ecd6cfa729028088e78af3b7e8b5f1e6a043892deffdcf23590ccb8698e735b",
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
			SHA256: "d564f425f67a435bbca472a9dcac13d8018940ff5f631bc29ad67e723bfa0938",
		},
		"workflowRunRoutingSource": {
			Path:   "packages/workflows/src/workflow-run-routing.ts",
			SHA256: "8c49e898f3b1de5aadbb0289ed7567c51600bd0fa55b98dc6d77fe27032e1e78",
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
			SHA256: "d736cdc8dab90f59f581cb5a591949c309c56f318bc3540dd92cb3b5f0682475",
		},
		"workflowRunReadOnlyInspectionSource": {
			Path:   "packages/workflows/src/workflow-run-readonly-inspection.ts",
			SHA256: "894160dcfee1678367800a405d80ade8fddf011e27a7084b5a09f9ee4490ac24",
		},
		"workflowRunReadOnlyInspectionTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-readonly-inspection.test.ts",
			SHA256: "149fb22c0dfcfa06e8ffa4c7e6115155d3f63082fabc060ace11dfa539da9b69",
		},
		"workflowRunnerControlClientSource": {
			Path:   "packages/workflows/src/workflow-runner-control-client.ts",
			SHA256: "d6ae038ebfcdd60e58ea9937fb34308af1e2349e4e62a27c1f3d12c194108d22",
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
			SHA256: "427ad506fd5cb6b068eb91d73d62eb0c6d2d83a059d095e402a62f3ebfc0c8e6",
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
			SHA256: "d610a0a95b38b9170bf9634706d4f1ab78844f9771422cb3a9724119d9100e26",
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
			SHA256: "d2257b3cc6de2e7e2720f035d1e782717841c77c1fad49da93f290fc1bfa5e4b",
		},
		"workflowRunnerExecutionClientSource": {
			Path:   "packages/workflows/src/workflow-runner-execution-client.ts",
			SHA256: "466e2a67b97f563e358e77e86e3ff6aa6e44fb17d4647c6e5d85597e4721a616",
		},
		"workflowRunnerV2ControlClientSource": {
			Path:   "packages/workflows/src/workflow-runner-v2-control-client.ts",
			SHA256: "6aff04724146f51d8f3867ae683e88de91f89520eea2d66f3b1b189996b807cc",
		},
		"workflowRunnerV2GoProjectionSource": {
			Path:   "packages/workflows/src/workflow-runner-v2-go-projection-store.ts",
			SHA256: "4f3524cbe9543302e8e1ce4cfdac0274fa810ef1733c747c79a55adac420d60b",
		},
		"workflowRunnerV2RuntimeDeliverySource": {
			Path:   "packages/workflows/src/workflow-runner-v2-runtime-delivery.ts",
			SHA256: "a353879725bfc18f726ddb89c2df4459280b5613ce63f671e563510275a2210f",
		},
		"workflowRunnerWorkerSource": {
			Path:   "packages/workflows/src/workflow-runner-worker.ts",
			SHA256: "9baab22032c10acd7318a70da58d8d1c9ed3fa4ae871675a56fc275aa5224ecb",
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
			SHA256: "9e90de86170155380cab607bcc3fbae1ebe027f1d8acbe77575731af55edca68",
		},
		"workflowRunProjectionReadTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-projection.test.ts",
			SHA256: "3089e2d7aa1a1e24df2cae0692da4af810a9ffc3dc25090eb2d93a517aa62ab9",
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
			SHA256: "8f905604eb2eb2f7e649c2fa0d1e38933d1dc29b7e2c6f9d55fc8071394650dd",
		},
		"budgetCompatibilityHistory":      {Path: "packages/workflows/contracts/workflow-budget-authority/compatibility-history.json", SHA256: "e4ecaab911dada04058e2052dadfd327abb651922fd12d0a20a1a64538842922"},
		"budgetCompatibilityHistoryCheck": {Path: "scripts/verify-budget-compatibility-history.mjs", SHA256: "d6abfcc6a38edf70895cff94229b4e0d71d4d5d0479620772227fd551819fd6f"},
		"runPathBoundaryRegression":       {Path: "packages/workflows/src/__tests__/workflow-run-path-boundaries.test.ts", SHA256: "de7ba9f8c999e0b29809153e9708f3ceb8c6627eb903d5264b9b0cc619f1da35"},
		"bindingFieldRules":               {Path: "packages/workflows/src/internal/workflow-binding-field-rules.ts", SHA256: "4b8c92bbbb0f6c2ea7dcf9e3e3f8280a922622dab186fd7ee3b172048d3a0e4a"},
		"resumeCorrelation":               {Path: "packages/workflows/src/internal/workflow-resume-correlation.ts", SHA256: "f49d7f1528da8e92556121cffd46a3a04a8c40296d36b7e3662d07d34bd8cd4c"},
		"bindingCorpusApplication":        {Path: "packages/workflows/src/__tests__/helpers/binding-corpus.ts", SHA256: "e4e04ceab2ef4a07733bfc948fcf5be61c18a99115b44583df964bf39c86764e"},
		"compatibilityHygieneRegression":  {Path: "packages/workflows/src/__tests__/workflow-compatibility-hygiene.test.ts", SHA256: "c1fec15046a9548e716513a9c63d7ff834532d2b1591e6353f1828199dfafa6c"},
		"budgetMaintenanceRegression":     {Path: "services/workflow-control/internal/budgetstore/postgres/maintenance_regression_test.go", SHA256: "b8e1341379177e6db7b62a2f88d8d617ed54c661734b743d48b2cf14fe34a731"},
		"budgetCompatibilityLedger": {
			Path:   "packages/workflows/contracts/workflow-budget-authority/compatibility.json",
			SHA256: "e4ecaab911dada04058e2052dadfd327abb651922fd12d0a20a1a64538842922",
		},
		"budgetCompatibilityGenerator": {
			Path:   "scripts/workflow-budget-authority-contracts/compatibility.ts",
			SHA256: "ab6b0fcc0cee57b82d00c1a97f9b4cd1021eac45d70976190629bda9a335da83",
		},
		"budgetCompatibilityTS": {
			Path:   "packages/workflows/src/internal/workflow-budget-compatibility.generated.ts",
			SHA256: "8055cf7927434818f4f377cd8ec01399175a56f256cce32d63e56cc9e935e374",
		},
		"budgetCompatibilityGo": {
			Path:   "services/workflow-control/budgetcontract/compatibility_generated.go",
			SHA256: "eda464d1357dc359500983d2de92d9d442a1683486935c31d4d73d6fe8d29446",
		},
		"budgetCompatibilityRegression": {
			Path:   "packages/workflows/src/__tests__/workflow-budget-manifest-compatibility.test.ts",
			SHA256: "00ac9079251ad945d86299ae78cc96aff5b695d7851f492035eeac316ac45f47",
		},
		"bindingControlSequenceRules": {
			Path:   "packages/workflows/contracts/workflow-runner-authority-binding/control-sequences.json",
			SHA256: "e9816a8e0ec3f6f227fbcac2df1c53af032d2b1ce6cb4dcc5ec3d7ebf9549620",
		},
		"bindingControlSequenceGenerator": {
			Path:   "scripts/workflow-runner-authority-binding-contracts/control-sequences.ts",
			SHA256: "ad29b67bfbbe1f5aad43ae16d6ee180d42651ebb8ea88e53045f802349d12f63",
		},
		"bindingControlSequenceTS": {
			Path:   "packages/workflows/src/internal/workflow-control-sequences.generated.ts",
			SHA256: "554d15e3112df0257f82a2569d13155dc030b0434a6de51795eedbe6246a48ce",
		},
		"bindingControlSequenceGo": {
			Path:   "services/workflow-control/runnerbindingcontract/control_sequences_generated.go",
			SHA256: "5284e7b38ba03c7effbe793699894a1fa3aab1ff1ae2c0c5dbba64baa7d577ab",
		},
		"bindingControlSequenceTSRegression": {
			Path:   "packages/workflows/src/__tests__/workflow-control-sequence-rules.test.ts",
			SHA256: "607556f8c3fb12883542dc33ebcfd8c0d880ed00fe76a839a6b53299290925b7",
		},
		"bindingControlSequenceGoRegression": {
			Path:   "services/workflow-control/runnerbindingcontract/control_sequences_test.go",
			SHA256: "9541a3402ca23a38389552dbbef6ec12eae0d27366ce7d74babfd6bfe4691330",
		},
		"bindingControlGeneratorEntry": {
			Path:   "scripts/workflow-runner-authority-binding-contracts/index.ts",
			SHA256: "6e5403aa8a2727d496d9588cfeabb5d85842405c6f8ccabf0c2f8c3401c846de",
		},
		"bindingControlGeneratorBody": {
			Path:   "scripts/workflow-runner-authority-binding-contracts/generator.mts",
			SHA256: "33591dfc8920bcfef707e87f8b7473366fd8b8ce5a0ff261b68b5863c8f30e47",
		},
		"bindingControlGeneratorBootstrap": {
			Path:   "scripts/workflow-runner-authority-binding-contracts/bootstrap.mjs",
			SHA256: "b70bf687f0f25f819e678711a82a75dcf108d92f77e0c9c140048ba17eb1e7b0",
		},
		"bindingControlGeneratorLoader": {
			Path:   "scripts/workflow-runner-authority-binding-contracts/sequence-loader.mjs",
			SHA256: "93504ccd489137bd5edd9366f41b57ed3693eaf4f5922a3a1c615f38b87b023f",
		},
		"bindingGoldenTSContext":              {Path: "packages/workflows/src/__tests__/helpers/binding-golden-context.ts", SHA256: "c189b30437d40a1684dd42cb524062e6a45ee73f83a7e07beb3f9dbcbdcd6dd1"},
		"bindingGoldenGoContext":              {Path: "services/workflow-control/runnerbindingcontract/golden_context_test.go", SHA256: "65585aac3685175b45e61fd3fe3062736b003e10436e55f7a4702c6540bb7bd9"},
		"runnerRecoveryRetryCancellationTest": {Path: "services/workflow-control/internal/runnerstore/postgres/recovery_retry_test.go", SHA256: "421bb06df309bb90c5bb3d18f0de61546935600a624263623e743d0071dbed61"},
		"bindingSchemaFieldRules": {
			Path:   "scripts/workflow-runner-authority-binding-contracts/schema-fields.ts",
			SHA256: "3546c08e1b57ccbf5ad0383327abc10d8300e0e28d45bae0b1641939177cc277",
		},
		"bindingSchemaFormats": {
			Path:   "packages/workflows/src/workflow-runner-authority-binding-schema.ts",
			SHA256: "fdb16eb42cfccdbbcadd0785e657d263ae3fab1acd550650e79139cdfead59b6",
		},
		"bindingSchemaBoundaryFixtures": {
			Path:   "packages/workflows/contracts/workflow-runner-authority-binding/schema-boundaries.json",
			SHA256: "ca96fc166a7368ba6cf1f5e1b71e62d9eb06f4eaae4733bd87379eb87ec2d313",
		},
		"bindingSchemaBoundaryTSRegression": {
			Path:   "packages/workflows/src/__tests__/workflow-binding-schema-boundaries.test.ts",
			SHA256: "2419f913e727d6e4595052fd6fdeab9dc7dc4e60fe3a5a89f13a677b3234bdfd",
		},
		"bindingSchemaBoundaryGoRegression": {
			Path:   "services/workflow-control/runnerbindingcontract/schema_boundaries_test.go",
			SHA256: "35a5e8071af7fa860551e2ffc38d6632db382822c24938dbe3ddd78f1828e2ec",
		},
		"runIdentity": {
			Path:   "packages/workflows/src/internal/workflow-run-identity.ts",
			SHA256: "28fb39bb87a2c471978328803510b62a10cfb91eb4a13f2479777d812f7e65e2",
		},
		"runIdentityRegression": {
			Path:   "packages/workflows/src/__tests__/workflow-run-identity.test.ts",
			SHA256: "1d07f1e633f87cbcf84b7842b5b61dee19aa194aecaa07f5a3d3f5df2d54b727",
		},
		"budgetManifestRestartRegression": {
			Path:   "services/workflow-control/internal/budgetstore/postgres/manifest_restart_integration_test.go",
			SHA256: "92dabd89c4e45af67158d67230e6da5a4bc6e2cba82b3e3f387bd6873bd5319a",
		},
		"workflowRunReadQuery": {
			Path:   "packages/workflows/src/workflow-run-read-query.ts",
			SHA256: "4e017099cedd2b58d40afc34f1b02b00f8bbfd435897579f3b3c01a9d6035590",
		},
		"workflowRunReadQueryTests": {
			Path:   "packages/workflows/src/__tests__/workflow-run-read-query.test.ts",
			SHA256: "6f1914cde01255bc09ae4eada9bcd43969689e82968f4708b8e0dcf822bfe3ec",
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
			SHA256: "ab20ca40dd6449bb088c6bb4cb1965baa0320e701f07c99c5159774563b75ef0",
		},
		"runnerRecoveryEvidenceStore": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_evidence.go",
			SHA256: "088225cdaf65de538de826d8d3c2e15d22993d5ea9bf6ba6db48f83131feac8c",
		},
		"runnerRecoveryEvidenceHTTP": {
			Path:   "services/workflow-control/internal/runnerapp/recovery_evidence.go",
			SHA256: "cc1ff4684926ed05b7588cfd96716d9f249a16ca1606d08f93ab0666d4a2b191",
		},
		"runnerRecoveryEvidenceHTTPTests": {
			Path:   "services/workflow-control/internal/runnerapp/recovery_evidence_test.go",
			SHA256: "32f556341cec3104702b3d906df3692b940f316f97a2a9692a1fdc39a6911468",
		},
		"runnerRecoveryEvidencePostgresTests": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_evidence_integration_test.go",
			SHA256: "a88a01a9b577c8519914d9d1be5928962e04cce67195fa2955951363a2ba3bc8",
		},
		"runnerRecoverySchemaReadiness": {
			Path:   "services/workflow-control/internal/databaseready/databaseready.go",
			SHA256: "045cfd1944860291705be14ba460188090ecf8a8dbb881a7ed62cdc2e5b1bf21",
		},
		"runnerRecoveryPostgresTestSupport": {
			Path:   "services/workflow-control/internal/testsupport/postgres.go",
			SHA256: "518493362f97f66bc5718eaa28d06621ca2102a4ad02f40f0d615d741897badf",
		},
		"workflowRecoveryEvidence": {
			Path:   "packages/workflows/src/workflow-run-recovery-evidence.ts",
			SHA256: "9901022f841f4e5d1ceda49f1cdf8ddaf1da1e88583ecd184ad75d72fbac897b",
		},
		"workflowCheckpointRepair": {
			Path:   "packages/workflows/src/workflow-checkpoint-repair.ts",
			SHA256: "40cdab4f4ad11e0249ac08315e2b90fa0f36aa90191f98432fdab732277e6c0b",
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
			SHA256: "43a547ae50b83c21bdb93609c036713620cb741a45da627ab3d6ed443f1719bc",
		},
		"workflowRunnerAuthorityClient": {
			Path:   "packages/workflows/src/workflow-runner-authority-binding-client.ts",
			SHA256: "1f0ae86db0604c4b2772e679706aa1e821af887eafaf01ea168c7768d9edcf1b",
		},
		"workflowRunnerAuthorityRuntime": {
			Path:   "packages/workflows/src/workflow-runner-authority-binding-runtime.ts",
			SHA256: "7d50f0fb4e73573b968b3c6fb2b0b4007d1ad6e9685129851276dd546716abc8",
		},
		"workflowRunnerBudgetClient": {
			Path:   "packages/workflows/src/workflow-runner-budget-authority-client.ts",
			SHA256: "f882c24310ec4d59c581c79c5bc4a3a0db4ba5bda86f84809704c676e696594b",
		},
		"workflowRunnerAuthoritySources": {
			Path:   "packages/workflows/src/workflow-runner-runtime-authorities.ts",
			SHA256: "ff6fa926fb4a2b710e55bc1018a2bfa98be421ecee5e085e39a23a55ea7c73eb",
		},
		"workflowRunnerV2Session": {
			Path:   "packages/workflows/src/workflow-runner-v2-session.ts",
			SHA256: "35a4350055547b6d3ac23beb118ef33ab7bfdc61357ca7c632b4dd5143d1935a",
		},
		"workflowRecoveryEvidenceTests": {
			Path:   "packages/workflows/src/__tests__/workflow-run-recovery-evidence.test.ts",
			SHA256: "49280763b1f11d9d532b172a0753d059dec60f9c771201fe55621f235da4e857",
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
			SHA256: "e6d2b88b482830f022cea24fe127e3076864316d87d97a9ec3b3f2ebf12da26c",
		},
		"workflowEvidenceFileSource": {
			Path:   "packages/workflows/src/internal/workflow-evidence-file.ts",
			SHA256: "333d2204f6bdd3b69f33fb1399ed2b53b83f2d9157c73b6c851f38090e17c57c",
		},
		"workflowReadCorrectnessTest": {
			Path:   "packages/workflows/src/__tests__/workflow-read-correctness.test.ts",
			SHA256: "c23d45b972a086b22565b6f24c038c03bd5358f0554fd4b0ddb8e819486c23e4",
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
			SHA256: "25a9f5777856a0a985dda05d028cc70e32243c7fe0bd2f9b9f5d986a393865ba",
		},
		"workflowBindingReconciliationContract": {
			Path:   "packages/workflows/src/workflow-binding-reconciliation-contract.ts",
			SHA256: "a35d94e3efc25c030151877dfe21f1ddd6c01f60809232ec6f50a62e350bd7ac",
		},
		"workflowBindingReconciliation": {
			Path:   "packages/workflows/src/workflow-binding-reconciliation.ts",
			SHA256: "8926dff32d5ad10647fc2b7da4bd07981e18c2379cfcf01acb1c5901b8cc67f7",
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
			SHA256: "09dd8e4c3954b66d0ad7f774c3972f6593760025dd46f092243aaa84351ddd6e",
		},
		"workflowControlHttpTests": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-control-http.test.ts",
			SHA256: "58378f15af02fb133fe8b23f276feb28c68e1c7c929fccf403dd879183792f1a",
		},
		"workflowRecoveryContractGenerator": {
			Path:   "scripts/workflow-recovery-contracts/index.ts",
			SHA256: "f64232136c81a6c1a3bf752004b921355dcccbb15c1e962572a259051cbfbbd8",
		},
		"workflowRecoveryContractGeneratorConfig": {
			Path:   "scripts/workflow-recovery-contracts/tsconfig.json",
			SHA256: "16d1078d3a31644a7132e3e5b96cbfc984342d30f0256b690b6d43afcaef17f5",
		},
		"runnerBindingReconciliation": {
			Path:   "services/workflow-control/internal/runnerstore/binding_reconciliation.go",
			SHA256: "45cb37073fcedd96f1b728baa54a1b834cc2dec094a4e3594db5c1ef7dd23634",
		},
		"runnerBindingReconciliationPostgres": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/binding_reconciliation.go",
			SHA256: "d8ade21ae8354ede6408ba56d19c2ff1f50ab9d0972d016894631597cfb827c2",
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
			SHA256: "627a938569be00daa3308d9ea2b8274634e05ef395a1f0ff37789ed075c20606",
		},
		"runnerBindingReconciliationHandlerTests": {
			Path:   "services/workflow-control/internal/runnerapp/binding_reconciliation_test.go",
			SHA256: "5429da611b524177ad1c98b549b6e20370343bf37d3589723d6a439599f80931",
		},
		"runnerBindingReconciliationPostgresTests": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/binding_reconciliation_integration_test.go",
			SHA256: "5868529fdf4aca6ead1f917256c6f45257e8b874221ebdc0c4fd6999cff236ca",
		},
		"runnerReconciliationRestartTests": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/reconciliation_restart_integration_test.go",
			SHA256: "764bce473038d3486421fc67d621b8c479e24edd272493a423d2fdd223d345ea",
		},
		"runnerRecoveryContractGenerated": {
			Path:   "services/workflow-control/internal/runnerstore/recovery_contract.generated.go",
			SHA256: "a15cd3abe6019d917e28cf043b80517e079b53456913f96f0f2be5171f8dd713",
		},
		"runnerRecoveryContractTests": {
			Path:   "services/workflow-control/internal/runnerstore/recovery_contract_test.go",
			SHA256: "84758f1846163917a0853a5b920167b9f3b969d978f826bceb0a6890da24792d",
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
			SHA256: "30d66876d95983c1a813d5b532f3dea4bd7ca8ef372b4851fd331b31ee6569da",
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
			SHA256: "2ad6fbbafbe58bf5f893a9f91e7b69018ba401ca1853073e3b8f6be53e2f9aa8",
		},
		"workflowBindingReconciliationCommandTests": {
			Path:   "packages/workflows/src/__tests__/workflow-binding-reconciliation-command.test.ts",
			SHA256: "bb7c822135bcd9136a3c5b53f12a861dbc1ac62d67912facb608239d60a73ee8",
		},
		"workflowRecoveryCLICommandTests": {
			Path:   "apps/cli/src/__tests__/workflow-recovery-command.test.ts",
			SHA256: "f31f5e4bcc2341f0ef487f72ffc7fc9d570d06d14693f1bce0032888781ae72a",
		},
		"workflowReadPath": {
			Path:   "packages/workflows/src/internal/workflow-read-path.ts",
			SHA256: "778ac2b47bd2df836a8dcb18711cf82e8fd41341d9cd4046fc11e4f552e681a3",
		},
		"workflowReadPathTests": {
			Path:   "packages/workflows/src/__tests__/workflow-read-path.test.ts",
			SHA256: "90da6da728b9e0520aaec832e678afb1b664e64b026aedd8b11cca7099fb62eb",
		},
		"recoveryPageBuilder": {
			Path:   "services/workflow-control/internal/runnerstore/canonical_page.go",
			SHA256: "bd68194aa4f7484eb7aee0fcee662f7e227767327d0953ba54fe78e1647c4fdc",
		},
		"recoveryPageBuilderTests": {
			Path:   "services/workflow-control/internal/runnerstore/canonical_page_test.go",
			SHA256: "92488e94d6ab25cbceaaaccba92fa5dbe7a0fbc5cd6061a9c203dbd6ba4140de",
		},
		"runnerRecoveryV3": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_evidence_v3.go",
			SHA256: "ed400856ca4129880cd603a2dfcc7a13ac2cbb3fdf87c8791b74ebc555cc0de9",
		},
		"runnerRecoveryV3Tests": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_evidence_v3_integration_test.go",
			SHA256: "b974efd2b37898d34966448ad381a9fad4af0f4faf14f5add1a007cef4e42cf8",
		},
		"runnerRecoveryRetry": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_retry.go",
			SHA256: "370235681457fb4b23dc3f7092a38952e1a43cc342598b951170932130abb680",
		},
		"runnerRecoveryRetryTests": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/recovery_retry_integration_test.go",
			SHA256: "30cac097bb52c0add9faff22890088ca4db99545676d50117777cfb3aadb921e",
		},
		"recoveryPageMigrationUp": {
			Path:   "services/workflow-control/migrations/000011_index_workflow_runner_recovery_pages.up.sql",
			SHA256: "539bb1d822ec9137a2eff558bc22b6274a3c4d7c66cc3d5c256741a49ffa78f0",
		},
		"recoveryPageMigrationDown": {
			Path:   "services/workflow-control/migrations/000011_index_workflow_runner_recovery_pages.down.sql",
			SHA256: "3030e86397b439ecd65f98ba7094f008c471e66646ba85eb15c85b99fe53a57d",
		},
		"runnerSubmissionSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/repository.go",
			SHA256: "d892573e85f101f3441ea9738cec539440f15e1eb1586ad625cb6e5a28fb16cb",
		},
		"runnerLegacyEventSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/event.go",
			SHA256: "52a8b0cdda542d7ab66613579f71c62335c57a63a12749ae36a3884a5c3908f1",
		},
		"runnerCancellationSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/cancel.go",
			SHA256: "70b0dc1b809b742ddf9881039cd432c1f2ae0b09d3226aefa5fb03bd60884246",
		},
		"runnerAttemptFailureSource": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/failure.go",
			SHA256: "f4cd53badf78a5e7474892cec60302867d53b5f8056f69bdb0679179de678ca8",
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
			SHA256: "b9b6543e7bdd4a14f979230db3b3a269ee3073bd34ce48f6815a6112101a6b22",
		},
		"openapi": {
			Path:   "services/workflow-control/docs/api/openapi.yaml",
			SHA256: "3215e50eadda34c7675cf06449c8b26f567f7f369a26d409c95fe7a7f901343f",
		},
		"runnerOpenapi": {
			Path:   "services/workflow-control/docs/api/runner-openapi.yaml",
			SHA256: "8b251a81fa93195c1b25fe531104b4dff8d6c63154a187c89240643e8ce00b57",
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
			SHA256: "d1694c61ad3a19f9055ffd39cfd082d89beb2b459c8d6284966a74a5f4221c39",
		},
		"workflowRecoveryContractManifest": {
			Path:   "packages/workflows/contracts/workflow-recovery/v2/manifest.json",
			SHA256: "3e8b88ccea716dd5e35ec08228b6020b58ece06ab6ce050da4d07f0865a27a22",
		},
		"workflowRecoveryV3Manifest": {
			Path:   "packages/workflows/contracts/workflow-recovery/v3/manifest.json",
			SHA256: "484f657dfa1d0d6dba5da7ad7e7ea3f73b8013420cc9956cbaff29a3458cf8e4",
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
