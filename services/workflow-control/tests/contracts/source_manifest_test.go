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
		len(manifest.SourceInputs) != 87 || len(manifest.ContractInputs) != 15 {
		t.Fatal("source manifest input inventory drifted")
	}
	wantSourceInputs := map[string]manifestReference{
		"workflowRunReadErrorsSource": {
			Path:   "packages/workflows/src/workflow-run-read-errors.ts",
			SHA256: "6359d7030c3ec0432604f4b14d0797a69e21cfca031da09597c9c24733868e0a",
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
			SHA256: "52891d4e5b44fbe76d7c4bdb461bc533ec5b773d32d27d22bd6eb43d63e06197",
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
			SHA256: "9f4c7fc575f5416b0aa4f381c1e97c776c5c91fc3915277175673ee13d2a0d0d",
		},
		"runnerV2RuntimeDeliveryCompositionRootSource": {
			Path:   "services/workflow-control/cmd/runner-server/main.go",
			SHA256: "c75eaf89b1f23d920fa727aae9d827d7e780254eef1e7fbc4129bcdd22427dda",
		},
		"workflowPackageSurface": {
			Path:   "packages/workflows/package.json",
			SHA256: "619ba4eccb338e749dd95457114884113581f78869c0b6ef85a2fedfc6edf786",
		},
		"workflowRunStoreSource": {
			Path:   "packages/workflows/src/run-store.ts",
			SHA256: "5edd6141de26d9f56da3343a75d031cb15770feec30968b04b0d9888b586e4ea",
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
			SHA256: "26c18119de3b4335cf0f220fe5e9921a098bb70e85d5aef1e956fe13b4414c47",
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
			SHA256: "789c930318759d9e24c0b7d2c3d3b2ad21366a6c5a5d50fc6620232b7a7646a3",
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
			SHA256: "fe1ccd995fcd2cfd2afc98f960b2423d36db1baa1bb94a1c41d5ca44b95db5e6",
		},
		"workflowTUIExecutorsSource": {
			Path:   "apps/cli/src/commands/tui-executors.ts",
			SHA256: "e0d76010c0157b7ab6f5e29216b5d4ff8458c8f4e04987f0b09ef9da6ac48349",
		},
		"workflowTUICompositionSource": {
			Path:   "apps/cli/src/commands/tui.ts",
			SHA256: "56c5001d9a69e29d44b2cc7e722def040c6495974630a7613f976b01a4b67662",
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
			SHA256: "ee126666d1190fbe166ced93ac6d8dda54e5e9b22ef6135dc958fe2a5c868c4f",
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
			SHA256: "eddd7273cbf0847ca679c8232c789c06eac1ac67bccd468ac31b981d2e5b18aa",
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
			SHA256: "9d211f653580d4b3dec06591b9cd1d116f2c76834a7f55f57c5cf8c8af123584",
		},
		"workflowRunnerWorkerSource": {
			Path:   "packages/workflows/src/workflow-runner-worker.ts",
			SHA256: "51f7de33326a13cf101ec0151be416213daf6f0db2d012e107d1166e2c868548",
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
			SHA256: "b7174bbea2f135dc21643e0096be62acb996aec4fc9739c2601d13b1b18db3ea",
		},
		"workflowRunProjectionReadTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-projection.test.ts",
			SHA256: "5e4122028951bb7d5436e7b93c4bd592faf95bd16751d1eb2440a274cc769712",
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
			SHA256: "66a891e94a08e429f09bc1c70135caed0999ccd050d3b0bc82ce8e705250fe5c",
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
