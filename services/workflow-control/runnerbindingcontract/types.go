package runnerbindingcontract

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
		{Name: "authorityV2Manifest", SHA256: "62ae5761447347dd5b6a8c408f5d453a4043f02226163bb5671c552cb8f556f1"},
		{Name: "checkpointManifest", SHA256: "e6b4edefc887f17a83237471e168f4c0819b7848ad6a63d2446fc572bdcff000"},
		{Name: "effectControlManifest", SHA256: "36c356d1753f32f23b13717b957e86d11a264b9c9f16f697e47a4ecaf9253a65"},
		{Name: "effectShadowManifest", SHA256: "72c5f1cc74cf9f21628bd084fceea177d6b32d1321b2b13fb5c17fc8d86e546e"},
		{Name: "budgetManifest", SHA256: "5ba1027cb0c33bb833cff6a5095934231f42700bc6613e8ec815195ca812e714"},
		{Name: "migration7Up", SHA256: "bc09194c0b9ec2d5880a17f71327d99cf5481d88d6dc0d737be099af7a8fd722"},
		{Name: "migration7Down", SHA256: "251b99eb5e088a468ff524d81e59a98ab57543f2b917331b5ea1c239900947d7"},
	}
}
