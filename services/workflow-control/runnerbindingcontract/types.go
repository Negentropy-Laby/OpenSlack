package runnerbindingcontract

import "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"

const (
	ContractVersion      = "openslack.workflow_runner_authority_binding.v1"
	StageSchema          = "openslack.workflow_runner_authority_binding_stage.v1"
	ResolutionSchema     = "openslack.workflow_runner_authority_binding_resolution.v1"
	ReceiptSchema        = "openslack.workflow_runner_authority_binding_receipt.v1"
	ErrorSchema          = "openslack.workflow_runner_authority_binding_error.v1"
	PreparedSchema       = "openslack.workflow_runner_authority_binding_prepared.v1"
	IdempotencyPrefix    = "openslack.workflow-runner-authority-binding.v1."
	FutureRuntimeProfile = "workflow-control-runner-v2-runtime-delivery-v1"

	MaxFrameBytes         = 1_048_576
	MaxReceiptBytes       = 65_536
	MaxErrorBytes         = 16_384
	MaxEvidenceBytes      = 786_432
	MaxJSONDepth          = 16
	MaxJSONNodes          = 8_192
	MaxStringBytes        = 524_288
	MaxSafeInteger        = int64(1<<53 - 1)
	MaxRateDecimalBytes   = 64
	MaxRateFractionDigits = 18
	budgetManifestSHA256  = budgetcontract.CurrentManifestSHA256
)

type Operation string

const (
	OperationCheckpointCommit Operation = "checkpoint_commit"
	OperationEffectAuthorize  Operation = "effect_authorize"
	OperationEffectComplete   Operation = "effect_complete"
	OperationBudgetReserve    Operation = "budget_reserve"
	OperationBudgetSettle     Operation = "budget_settle"
	OperationResumeAdvance    Operation = "resume_advance"
)

type SourceLock struct {
	Name   string
	SHA256 string
}

func SourceLocks() []SourceLock {
	return []SourceLock{
		{Name: "runnerV1Manifest", SHA256: "908ff368f35033206b975a0421396f49e588098f040aecef2fdd18cd8b67ece6"},
		{Name: "authorityV2Manifest", SHA256: "7994937f8b66c67ba4c90ce9018fcbde095ad34e6f377b3cd09959bb5c53d2ba"},
		{Name: "checkpointManifest", SHA256: "e6b4edefc887f17a83237471e168f4c0819b7848ad6a63d2446fc572bdcff000"},
		{Name: "effectControlManifest", SHA256: "76929e860fc42573e87dfe09f106d15f4913b2da3da5f96e4a8c1d58d095d1c2"},
		{Name: "effectShadowManifest", SHA256: "58208d1618b6a629e821dbb10d214a9a57eaf6b3771a1b61e1d2198c4038354a"},
		{Name: "budgetManifest", SHA256: budgetManifestSHA256},
		{Name: "migration7Up", SHA256: "bc09194c0b9ec2d5880a17f71327d99cf5481d88d6dc0d737be099af7a8fd722"},
		{Name: "migration7Down", SHA256: "251b99eb5e088a468ff524d81e59a98ab57543f2b917331b5ea1c239900947d7"},
	}
}
