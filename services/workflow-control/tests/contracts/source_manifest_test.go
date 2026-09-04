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

func TestSourceManifestBindsOnlyUnreleasedGS9HInputs(t *testing.T) {
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
		manifest.Service.MigrationPhase != "GS9-H" ||
		manifest.Service.Authority != "GO_NEW_RECORD_AUTHORITY_WITH_TYPESCRIPT_READ_ONLY_RECOVERY" ||
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
		}, "\n") {
		t.Fatalf("source manifest widened authority: %#v", manifest)
	}
	if len(manifest.ContainerInputs) != 6 || manifest.ContainerInputs["goVersion"] != "1.26.5" ||
		len(manifest.SourceInputs) != 72 || len(manifest.ContractInputs) != 15 {
		t.Fatal("source manifest input inventory drifted")
	}
	wantSourceInputs := map[string]manifestReference{
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
			SHA256: "54babd544c1b4e8069f7969ea771fd5631ff256805eb48c9f2e79b30388d4f0b",
		},
		"runnerV2RuntimeDeliveryHTTPQualificationTest": {
			Path:   "services/workflow-control/cmd/runner-server/gs9f2_qualification_test.go",
			SHA256: "7223b6748c9fdddba7f00df9545bd37182e226d8c054e8deeae1c87d2a13edf6",
		},
		"runnerV2AuthorityBindingDomainSource": {
			Path:   "services/workflow-control/internal/runnerstore/v2_binding.go",
			SHA256: "9a3ca099361f1b4fc64a40663b71752e3db4ef06580b14c0d51f19ad9c9c87a4",
		},
		"runnerV2AuthorityBindingLifecycleTest": {
			Path:   "services/workflow-control/internal/runnerstore/postgres/gs9f2_binding_lifecycle_test.go",
			SHA256: "1449b74573f03b24283b8d034b78b754bb5351b36325b3051933c0bd3ad71300",
		},
		"runnerV2RuntimeDeliverySchedulerSource": {
			Path:   "services/workflow-control/internal/runnerscheduler/session_v2.go",
			SHA256: "d89de11e4b4e99db20da29fdd5eedae1e82fe8dacfd0998b32895cb5fbc8bd26",
		},
		"runnerV2RuntimeDeliverySchedulerTest": {
			Path:   "services/workflow-control/internal/runnerscheduler/session_v2_runtime_delivery_test.go",
			SHA256: "4e9d923339de96edf93412fef59f548f1cf47e3986919363f4dd17800a41b8c5",
		},
		"runnerV2RuntimeDeliveryConfigSource": {
			Path:   "services/workflow-control/internal/runnerconfig/config.go",
			SHA256: "27fafa75f3eaeb74a22501e381a1f9825923c9d43d2baca5db5048e29ae0e40a",
		},
		"runnerV2RuntimeDeliveryWorkerRegistrySource": {
			Path:   "services/workflow-control/internal/workerregistry/registry.go",
			SHA256: "120cbb904dc40a6abdee7f5e92e880efc15d546b0c4cf3bb9c9238fc5bc0cd09",
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
			SHA256: "e7a7f13298d7974a0d5e5e18db77ee6bbed4940fb2998074e3b51eb7c35f8fbf",
		},
		"runnerV2RuntimeDeliveryHTTPServerSource": {
			Path:   "services/workflow-control/internal/runnerapp/server.go",
			SHA256: "68f892594ec5f29c2932bbff4107f29addf6089ba23e9a9bc6bb177c9bb06803",
		},
		"runnerV2RuntimeDeliveryCompositionRootSource": {
			Path:   "services/workflow-control/cmd/runner-server/main.go",
			SHA256: "01a31f8274d6dae24a0b4ba4b72c4fdc25c0c80dc48eedec4819bdac5ce5b285",
		},
		"workflowRunRoutingPublicSurface": {
			Path:   "packages/workflows/src/index.ts",
			SHA256: "6b9c63ee3211aafb407ff0644ccecdf82ef20bad120c778122dafe5092dd74c5",
		},
		"workflowRunRoutingSource": {
			Path:   "packages/workflows/src/workflow-run-routing.ts",
			SHA256: "a8eb9e2f0540304a4378bfb66d83e67efbdfa7beaf7be4c72ee08c969f01988f",
		},
		"workflowRunRoutingConfigSource": {
			Path:   "packages/workflows/src/workflow-run-routing-config.ts",
			SHA256: "443a21b20204f3b9329195f61fb0a1cd7bf796fd0db317e09ba4d14213a96763",
		},
		"workflowControlRoutingIdentitySource": {
			Path:   "packages/workflows/src/workflow-control-routing-identity.ts",
			SHA256: "7a57d7343915424b7dc39d6735a3c13f063f7abe280d5a2030a1b17ac855784d",
		},
		"workflowRunProjectionSource": {
			Path:   "packages/workflows/src/workflow-run-projection.ts",
			SHA256: "37a38f8e1342dc3135b4731e683f146daf59c6766a13a810c9e82514b9fe54e2",
		},
		"workflowRunReadOnlyInspectionSource": {
			Path:   "packages/workflows/src/workflow-run-readonly-inspection.ts",
			SHA256: "889ed2a3d946e9b1ef50b5b597950c2101b11833ee453646160eba8c8e3170ca",
		},
		"workflowRunReadOnlyInspectionTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-readonly-inspection.test.ts",
			SHA256: "0c29e820d9fef68eada04264ef87f6c6860941f188c1251cbde7e0fd19c34b02",
		},
		"workflowRunnerControlClientSource": {
			Path:   "packages/workflows/src/workflow-runner-control-client.ts",
			SHA256: "953fcb6fbe274ba087f43f7eb1f86b5c08300f58e984a15c7f45b53bf8f417b9",
		},
		"workflowRunnerSourceInvariantTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-source-invariants.test.ts",
			SHA256: "5c8abd3c4917e0a40f8f4b0f82543c2795bd1c2a8d7fc2a1d72167dd52a72591",
		},
		"workflowCLICompositionSource": {
			Path:   "apps/cli/src/commands/collaboration.ts",
			SHA256: "8948254fd27cf13e535152dfffc0e8d629936b888e4a19e8710400af2223d08b",
		},
		"workflowTUIExecutorsSource": {
			Path:   "apps/cli/src/commands/tui-executors.ts",
			SHA256: "79853ddb475cd07f7924fa71594a8886b6f6b6dc760b918ccc27334ad7f46807",
		},
		"workflowTUICompositionSource": {
			Path:   "apps/cli/src/commands/tui.ts",
			SHA256: "23aca2c7478a6186590bb762f65dc67ee8907bf96e85491d3f7450c2473f67ff",
		},
		"workflowTUIRunsViewSource": {
			Path:   "packages/tui/src/views/WorkflowRunsView.tsx",
			SHA256: "b57c5752f9c82a31e5ae666fb84038ecc16f95f844fa0f29f23ed073719b9f65",
		},
		"workflowTUIRenderShellSource": {
			Path:   "packages/tui/src/views/render-shell.ts",
			SHA256: "2e8468c4c75470fb99d53af19278a2a60fc88ceca77a101330c4c9304f9f8c67",
		},
		"demoAIOrgRehearseSource": {
			Path:   "scripts/demo-ai-org-rehearse.ts",
			SHA256: "07741659c420faf8eaabdf8d4dd7d1fa3c283d7396432b32612f50662b41b9fb",
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
			SHA256: "66282ebf397cf69fc9fe589a07837c862067d7ffb5dd48b8b57c765ea1820975",
		},
		"workflowRunnerExecutionClientSource": {
			Path:   "packages/workflows/src/workflow-runner-execution-client.ts",
			SHA256: "7c7a8903db2d0de8afa5549c2fb957d90c06daa14763ac7892fd25ae1715ed0a",
		},
		"workflowRunnerV2ControlClientSource": {
			Path:   "packages/workflows/src/workflow-runner-v2-control-client.ts",
			SHA256: "10408737e5cc0c9451eeba8e3e7e6fb02120639765110340c66c36f26cfc8566",
		},
		"workflowRunnerV2GoProjectionSource": {
			Path:   "packages/workflows/src/workflow-runner-v2-go-projection-store.ts",
			SHA256: "b25e6a877e6fcb0a5f74b44260c8324f590e124c47cce4f14e4222a7e7e39eae",
		},
		"workflowRunnerV2RuntimeDeliverySource": {
			Path:   "packages/workflows/src/workflow-runner-v2-runtime-delivery.ts",
			SHA256: "9d211f653580d4b3dec06591b9cd1d116f2c76834a7f55f57c5cf8c8af123584",
		},
		"workflowRunnerWorkerSource": {
			Path:   "packages/workflows/src/workflow-runner-worker.ts",
			SHA256: "36c4296de18d5eeb3ced458b162629565f165273d6e43344b4d72fd95a1f2e11",
		},
		"workflowRunRoutingTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-routing.test.ts",
			SHA256: "4f16c45118c405762ff73cb4eb3f378c0f3e53e1748967fb4db8c0be59ab9372",
		},
		"workflowRunnerExecutionClientTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-execution-client.test.ts",
			SHA256: "ddc392d3e735b43908cc8956270a9635df2bdafce39f017e0810b351b238e96e",
		},
		"workflowRunnerV2FoundationTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-v2-foundation.test.ts",
			SHA256: "f48c0b4626aeb4bca03b40e40221c2697c6ad4b23dffac763a921db5814373d7",
		},
		"workflowRunnerWorkerTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-worker.test.ts",
			SHA256: "667c80ebebc12da25499d2a09b3e8748b3ceda5f884750fa8086059dc8e906f2",
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
			SHA256: "70453b70c220ea0c996f018af55d730b52cd7a6d3ae061df71bae3585c2dac07",
		},
		"workflowRunnerV2WorkerRegistryTest": {
			Path:   "services/workflow-control/internal/workerregistry/registry_test.go",
			SHA256: "aa300a14051160b14921cabcb7bc7215ca0ca4c6fcfab5e6668c802fc7b5c56a",
		},
		"workflowRunnerV2HTTPServerTest": {
			Path:   "services/workflow-control/internal/runnerapp/server_test.go",
			SHA256: "40ca605509a58f7add2a1fea96cde427ef32315e3c4ec46849459459c116709a",
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
			SHA256: "2ce5364708165611d0629d293c8ffb9ddd1f6cb7a37b78ded3163e0bdd58c877",
		},
		"workflowEffectControlContractManifest": {
			Path:   "packages/workflows/contracts/workflow-effect-control/v1/manifest.json",
			SHA256: "6114d3282536f4a341102ae7492e32c2f3886de05394751d19fefd9db567f9d4",
		},
		"workflowEffectShadowContractManifest": {
			Path:   "packages/workflows/contracts/workflow-effect-shadow/v1/manifest.json",
			SHA256: "55acf993ae4b951a7426c2d4771733d0ef578095d2b616f7bca0394a43f33b42",
		},
		"workflowBudgetAuthorityContractManifest": {
			Path:   "packages/workflows/contracts/workflow-budget-authority/v1/manifest.json",
			SHA256: "662fdb7237d9225593f1988fc2069e15230482da26c46fac5db73e4ee2604548",
		},
		"workflowRunnerAuthorityBindingContractManifest": {
			Path:   "packages/workflows/contracts/workflow-runner-authority-binding/v1/manifest.json",
			SHA256: "940186e6154b7f10f637eac99f0da755916ba2181d2d0e71c44f4ab68f4181b7",
		},
		"openapi": {
			Path:   "services/workflow-control/docs/api/openapi.yaml",
			SHA256: "3215e50eadda34c7675cf06449c8b26f567f7f369a26d409c95fe7a7f901343f",
		},
		"runnerOpenapi": {
			Path:   "services/workflow-control/docs/api/runner-openapi.yaml",
			SHA256: "1b8740144b85c55d53a2fa743cb9c2dde728969f56050f6fce979298142db00a",
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
			SHA256: "008c529cc7938946834f6653c89c800a113a8ec9803311ec04c51fccb0dbcb8a",
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
