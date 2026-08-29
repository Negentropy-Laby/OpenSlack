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

func TestSourceManifestBindsOnlyUnreleasedGS9GInputs(t *testing.T) {
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
		manifest.Service.MigrationPhase != "GS9-G" ||
		manifest.Service.Authority != "IMMUTABLE_ROUTE_RECEIPT_SELECTS_TYPESCRIPT_OR_GO_NEW_RECORD_AUTHORITY" ||
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
			"WORKFLOW_RUN_ROUTING_HIGHER_EPOCH_TS_ROLLBACK",
			"WORKFLOW_RUNNER_V2_SINGLE_WRITER_NEGATIVE_GUARD",
		}, "\n") {
		t.Fatalf("source manifest widened authority: %#v", manifest)
	}
	if len(manifest.ContainerInputs) != 6 || manifest.ContainerInputs["goVersion"] != "1.26.5" ||
		len(manifest.SourceInputs) != 57 || len(manifest.ContractInputs) != 15 {
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
			SHA256: "1eafdc3ca4c0e22f421afa017dab7bc2a98f6de30237302e838206d406f9e33a",
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
			SHA256: "8f5fd155d8ddec770c18402250599747313ddc4d2ae6a978b8d9354f86cbcdfd",
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
			SHA256: "e210882abd3729e9afeb7eb72979614437a25149465c88242b62b1e294718220",
		},
		"runnerV2RuntimeDeliverySchedulerTest": {
			Path:   "services/workflow-control/internal/runnerscheduler/session_v2_runtime_delivery_test.go",
			SHA256: "80e6a883ac27ae2e2d7231291919698468cd7d41474d5bd48697f1fbc9ec90c8",
		},
		"runnerV2RuntimeDeliveryConfigSource": {
			Path:   "services/workflow-control/internal/runnerconfig/config.go",
			SHA256: "1bc08a1580ee084593ef14b34e156b1716b9bb9b27db73a496de38bf7680fd08",
		},
		"runnerV2RuntimeDeliveryWorkerRegistrySource": {
			Path:   "services/workflow-control/internal/workerregistry/registry.go",
			SHA256: "e7a890cd70f574f79f7944a464b3597209126194fbe9a808ace44878c627ef92",
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
			SHA256: "81a8cf1ba6430e714dc54fde93bb3df19b6ba750b42f1bbf6bd8786d2cc0cc4d",
		},
		"runnerV2RuntimeDeliveryHTTPServerSource": {
			Path:   "services/workflow-control/internal/runnerapp/server.go",
			SHA256: "32ca54b562ba34571ed62063d46bd0f51176bd36cc1032793ce2dd94c4c91dab",
		},
		"runnerV2RuntimeDeliveryCompositionRootSource": {
			Path:   "services/workflow-control/cmd/runner-server/main.go",
			SHA256: "93584a5e6a61500f87c7a646611aabe0da53597c3a86e0317f0323ab130367b4",
		},
		"workflowRunRoutingPublicSurface": {
			Path:   "packages/workflows/src/index.ts",
			SHA256: "cd0c6fcff4fd7a65f39b290c0eab2c3ce4f8327b30b87a998e0d6284d0ceb5be",
		},
		"workflowRunRoutingSource": {
			Path:   "packages/workflows/src/workflow-run-routing.ts",
			SHA256: "8cb1fd1889c216f2d3ec969b6a7d3836b2662cfc30e72c12c019ac92e4f68168",
		},
		"workflowRunRoutingConfigSource": {
			Path:   "packages/workflows/src/workflow-run-routing-config.ts",
			SHA256: "e5b561ae952f66277fd4542296a3cdca46c79a69835ecf2bdb5f254f364539bb",
		},
		"workflowControlAuthorityClientSource": {
			Path:   "packages/workflows/src/workflow-control-authority-client.ts",
			SHA256: "7b15f0580efaccd0c9299b65cc9bfc80c83c501945f6b6976005b3afa0b6029b",
		},
		"workflowRunnerExecutionClientSource": {
			Path:   "packages/workflows/src/workflow-runner-execution-client.ts",
			SHA256: "8444ee2a3b7fe6a38f8b945c384cd68ecf7f24d31d487730794a3f11b71beade",
		},
		"workflowRunnerV2ControlClientSource": {
			Path:   "packages/workflows/src/workflow-runner-v2-control-client.ts",
			SHA256: "318d1aa2f0862e01c88326192712d541fabec92f55db1457582f92b475800409",
		},
		"workflowRunnerV2GoProjectionSource": {
			Path:   "packages/workflows/src/workflow-runner-v2-go-projection-store.ts",
			SHA256: "28a1cdc6a3b916995be958f48dfa6537df2e99f7440ce8ea0c4ecde30a0b4a12",
		},
		"workflowRunnerV2RuntimeDeliverySource": {
			Path:   "packages/workflows/src/workflow-runner-v2-runtime-delivery.ts",
			SHA256: "1b6ce916802d9df94d35a3a6352f488a2f7c988be9de2375b683c374eb9f5817",
		},
		"workflowRunnerWorkerSource": {
			Path:   "packages/workflows/src/workflow-runner-worker.ts",
			SHA256: "e76e8096f667d8a0a11c83d3446f53fa5e55c9acd9098443d6198a8cccaa9dac",
		},
		"workflowRunRoutingTest": {
			Path:   "packages/workflows/src/__tests__/workflow-run-routing.test.ts",
			SHA256: "5919193cf4fd2a5fa346534b91b47efafa3c235670e082dcc8081aa07e952229",
		},
		"workflowRunnerExecutionClientTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-execution-client.test.ts",
			SHA256: "ec737317a88bc1a948a4b9e155f0dd667fff13f5b2217f4bd1ca9f8604a86367",
		},
		"workflowRunnerV2FoundationTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-v2-foundation.test.ts",
			SHA256: "3a8e5516972363a2f7db7e70deefe5c892d5f01caffa66947c08e254181a4fc5",
		},
		"workflowRunnerWorkerTest": {
			Path:   "packages/workflows/src/__tests__/workflow-runner-worker.test.ts",
			SHA256: "e201ed19f4fc06ab95e3694607af0e631ee0052ada9cc79b4ad3958217b4e897",
		},
		"workflowControlAuthorityConfigSource": {
			Path:   "services/workflow-control/internal/config/authority.go",
			SHA256: "d8a0f2cff61e5cfb0214dd2f642096d8c5b882c4beebcdb10994f977a2507db5",
		},
		"workflowControlAuthorityConfigTest": {
			Path:   "services/workflow-control/internal/config/authority_test.go",
			SHA256: "a18cf551f0c342cc33e995c44a186b41e65dd4cb55495e6f04dd09b963066054",
		},
		"workflowControlAuthorityHTTPServerSource": {
			Path:   "services/workflow-control/internal/authorityapp/server.go",
			SHA256: "e96e0e806212231cb0dfc60c68ddd10ac3c4f0d213afaefbeb98275d06eee8f3",
		},
		"workflowControlAuthorityHTTPHandlersSource": {
			Path:   "services/workflow-control/internal/authorityapp/handlers.go",
			SHA256: "c13faf0b32c57b79b35a76503e6583e104e03a09194bcf334d70355397e1d914",
		},
		"workflowControlAuthorityHTTPServerTest": {
			Path:   "services/workflow-control/internal/authorityapp/server_test.go",
			SHA256: "975a0ad99b25b2ea832880e671a26824421e123797d6a8555ac1aa6372e39f6f",
		},
		"workflowControlAuthorityCompositionRootSource": {
			Path:   "services/workflow-control/cmd/authority-server/main.go",
			SHA256: "9258088cb57a44370271ca060d92cd5cea0fb5f68de2d011b94d7f98fb167d32",
		},
		"workflowRunnerV2RuntimeDeliveryConfigTest": {
			Path:   "services/workflow-control/internal/runnerconfig/config_test.go",
			SHA256: "66b30605755b8911e6d055a697ab2586034ed8ef06a4a49c3ec5128811fba583",
		},
		"workflowRunnerV2WorkerRegistryTest": {
			Path:   "services/workflow-control/internal/workerregistry/registry_test.go",
			SHA256: "aa300a14051160b14921cabcb7bc7215ca0ca4c6fcfab5e6668c802fc7b5c56a",
		},
		"workflowRunnerV2HTTPServerTest": {
			Path:   "services/workflow-control/internal/runnerapp/server_test.go",
			SHA256: "be4bc59c832a4496812fcf48e0412bf7469ac20cb4d7a89ed1e2e9055ef747e5",
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
			SHA256: "3abaa009a76f400540d7dc2c720d8b659dbd02a4fe4785be8dfc96680bdd8762",
		},
		"openapi": {
			Path:   "services/workflow-control/docs/api/openapi.yaml",
			SHA256: "3215e50eadda34c7675cf06449c8b26f567f7f369a26d409c95fe7a7f901343f",
		},
		"runnerOpenapi": {
			Path:   "services/workflow-control/docs/api/runner-openapi.yaml",
			SHA256: "c33614d7fb95a001b1bbc11913c156a8042807a3f8da5a1a13ca3725d0b29873",
		},
		"authorityOpenapi": {
			Path:   "services/workflow-control/docs/api/authority-openapi.yaml",
			SHA256: "2bfd07ba8724290fb61ceaa38c7aba48633d2a6a3ea88de4f1475394c7221a32",
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
		"AUTHENTICATED_EXTERNAL_QUALIFICATION", "CHECKPOINT_RESUME_AUTHORITY", "FULL_GO_CUTOVER",
		"GS9_H_TYPESCRIPT_READ_ONLY_RECOVERY", "LEGACY_TYPESCRIPT_DRAIN_COMPLETE", "LIVE_VERIFIED", "PRODUCTION",
		"QODER_VERIFIED", "REGISTRY_INCLUSION", "RELEASE", "REMOTE_CONNECTOR",
		"SIGNED_PROVENANCE", "USER_VISIBLE_READ_AUTHORITY", "WORKFLOW_BUDGET_PRODUCTION_AUTHORITY",
		"WORKFLOW_BUDGET_PRODUCTION_INITIAL_POLICY_SOURCE",
		"WORKFLOW_CONTROL_AUTHORITY_CUTOVER", "WORKFLOW_CONTROL_STATE_MACHINE_AUTHORITY",
		"WORKFLOW_EFFECT_APPROVAL_AUTHORITY",
		"WORKFLOW_EFFECT_EXECUTION_AUTHORITY", "WORKFLOW_ROUTING_ALLOWLIST_EXPANSION", "WORKFLOW_RUNSTORE_AUTHORITY",
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
