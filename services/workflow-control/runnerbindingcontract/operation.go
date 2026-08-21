package runnerbindingcontract

import "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"

type RunnerDelta struct {
	Revision   int64
	Generation int64
}

type OperationFact struct {
	TargetKind            authoritycontract.Kind
	RunnerDelta           RunnerDelta
	SourcePlane           string
	SourceEvidenceState   string
	SourceRevisionDelta   int64
	SourceGenerationDelta int64
	SourceReceiptSchema   *string
}

var orderedOperations = []Operation{
	OperationCheckpointCommit,
	OperationEffectAuthorize,
	OperationEffectComplete,
	OperationBudgetReserve,
	OperationBudgetSettle,
	OperationResumeAdvance,
}

var operationFacts = map[Operation]OperationFact{
	OperationCheckpointCommit: operationFact(authoritycontract.KindCheckpointCommit, RunnerDelta{Revision: 1}, "checkpoint_control", "committed", 1, 0, "openslack.workflow_runner_checkpoint_authority_receipt.v1"),
	OperationEffectAuthorize:  operationFact(authoritycontract.KindEffectIntent, RunnerDelta{Revision: 1}, "effect_v2_sibling", "committed", 1, 0, "openslack.workflow_runner_effect_authority_receipt.v1"),
	OperationEffectComplete:   operationFact(authoritycontract.KindEffectOutcome, RunnerDelta{}, "effect_v2_sibling", "committed", 1, 0, "openslack.workflow_runner_effect_completion_receipt.v1"),
	OperationBudgetReserve:    operationFact(authoritycontract.KindBudgetReserveRequest, RunnerDelta{Revision: 1}, "budget_account", "prepared", 0, 0, ""),
	OperationBudgetSettle:     operationFact(authoritycontract.KindBudgetUsageReport, RunnerDelta{Revision: 1}, "budget_account", "prepared", 0, 0, ""),
	OperationResumeAdvance:    operationFact(authoritycontract.KindLeaseAccept, RunnerDelta{Revision: 1, Generation: 1}, "resume_control", "committed", 1, 1, "openslack.workflow_runner_resume_authority_receipt.v1"),
}

func operationFact(kind authoritycontract.Kind, delta RunnerDelta, plane, state string, revisionDelta, generationDelta int64, receiptSchema string) OperationFact {
	var schema *string
	if receiptSchema != "" {
		value := receiptSchema
		schema = &value
	}
	return OperationFact{
		TargetKind: kind, RunnerDelta: delta, SourcePlane: plane, SourceEvidenceState: state,
		SourceRevisionDelta: revisionDelta, SourceGenerationDelta: generationDelta, SourceReceiptSchema: schema,
	}
}

func factFor(operation Operation) (OperationFact, error) {
	fact, ok := operationFacts[operation]
	if !ok {
		return OperationFact{}, failure(ErrorInvalid, "$/operation", "$/operation is invalid.")
	}
	return fact, nil
}

func Operations() []Operation { return append([]Operation(nil), orderedOperations...) }

func ExpectedKind(operation Operation) (authoritycontract.Kind, error) {
	fact, err := factFor(operation)
	return fact.TargetKind, err
}

func RunnerHeadDelta(operation Operation) (RunnerDelta, error) {
	fact, err := factFor(operation)
	return fact.RunnerDelta, err
}

func SourceReceiptSchema(operation Operation) (*string, error) {
	fact, err := factFor(operation)
	if err != nil || fact.SourceReceiptSchema == nil {
		return nil, err
	}
	value := *fact.SourceReceiptSchema
	return &value, nil
}
