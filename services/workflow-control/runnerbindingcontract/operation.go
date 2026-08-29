package runnerbindingcontract

import "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"

type RunnerDelta struct {
	Revision   int64
	Generation int64
}

type AuthorityReceiptHashAlgorithm string

const (
	AuthorityReceiptHashNone             AuthorityReceiptHashAlgorithm = ""
	AuthorityReceiptHashBindingDomain    AuthorityReceiptHashAlgorithm = "binding_receipt_domain_sha256"
	AuthorityReceiptHashCanonicalDurable AuthorityReceiptHashAlgorithm = "canonical_durable_receipt_sha256"
)

type OperationFact struct {
	TargetKind            authoritycontract.Kind
	CompletionControlKind authoritycontract.Kind
	RunnerDelta           RunnerDelta
	SourcePlane           string
	SourceEvidenceState   string
	SourceRevisionDelta   int64
	SourceGenerationDelta int64
	SourceReceiptSchema   *string
	AuthorityReceiptHash  AuthorityReceiptHashAlgorithm
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
	OperationCheckpointCommit: operationFact(authoritycontract.KindCheckpointCommit, authoritycontract.KindEventReceipt, RunnerDelta{Revision: 1}, "checkpoint_control", "committed", 1, 0, "openslack.workflow_runner_checkpoint_authority_receipt.v1", AuthorityReceiptHashNone),
	OperationEffectAuthorize:  operationFact(authoritycontract.KindEffectIntent, authoritycontract.KindEffectAuthorization, RunnerDelta{Revision: 1}, "effect_v2_sibling", "committed", 1, 0, "openslack.workflow_runner_effect_authority_receipt.v1", AuthorityReceiptHashBindingDomain),
	OperationEffectComplete:   operationFact(authoritycontract.KindEffectOutcome, authoritycontract.KindEventReceipt, RunnerDelta{}, "effect_v2_sibling", "committed", 1, 0, "openslack.workflow_runner_effect_completion_receipt.v1", AuthorityReceiptHashNone),
	OperationBudgetReserve:    operationFact(authoritycontract.KindBudgetReserveRequest, authoritycontract.KindBudgetAuthorization, RunnerDelta{Revision: 1}, "budget_account", "prepared", 0, 0, "", AuthorityReceiptHashCanonicalDurable),
	OperationBudgetSettle:     operationFact(authoritycontract.KindBudgetUsageReport, authoritycontract.KindEventReceipt, RunnerDelta{Revision: 1}, "budget_account", "prepared", 0, 0, "", AuthorityReceiptHashNone),
	OperationResumeAdvance:    operationFact(authoritycontract.KindLeaseAccept, authoritycontract.KindResumeOffer, RunnerDelta{Revision: 1, Generation: 1}, "resume_control", "committed", 1, 1, "openslack.workflow_runner_resume_authority_receipt.v1", AuthorityReceiptHashBindingDomain),
}

func operationFact(kind, completionKind authoritycontract.Kind, delta RunnerDelta, plane, state string, revisionDelta, generationDelta int64, receiptSchema string, hashAlgorithm AuthorityReceiptHashAlgorithm) OperationFact {
	var schema *string
	if receiptSchema != "" {
		value := receiptSchema
		schema = &value
	}
	return OperationFact{
		TargetKind: kind, CompletionControlKind: completionKind, RunnerDelta: delta, SourcePlane: plane, SourceEvidenceState: state,
		SourceRevisionDelta: revisionDelta, SourceGenerationDelta: generationDelta, SourceReceiptSchema: schema,
		AuthorityReceiptHash: hashAlgorithm,
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

func CompletionControlKind(operation Operation) (authoritycontract.Kind, error) {
	fact, err := factFor(operation)
	return fact.CompletionControlKind, err
}

func OperationForKind(kind authoritycontract.Kind) (Operation, bool) {
	for _, operation := range orderedOperations {
		if operationFacts[operation].TargetKind == kind {
			return operation, true
		}
	}
	return "", false
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
