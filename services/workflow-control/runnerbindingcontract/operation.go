package runnerbindingcontract

import "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"

type RunnerDelta struct {
	Revision   int64
	Generation int64
}

func ExpectedKind(operation Operation) (authoritycontract.Kind, error) {
	switch operation {
	case OperationCheckpointCommit:
		return authoritycontract.KindCheckpointCommit, nil
	case OperationEffectAuthorize:
		return authoritycontract.KindEffectIntent, nil
	case OperationEffectComplete:
		return authoritycontract.KindEffectOutcome, nil
	case OperationBudgetReserve:
		return authoritycontract.KindBudgetReserveRequest, nil
	case OperationBudgetSettle:
		return authoritycontract.KindBudgetUsageReport, nil
	case OperationResumeAdvance:
		return authoritycontract.KindLeaseAccept, nil
	default:
		return "", failure(ErrorInvalid, "$/operation", "$/operation is invalid.")
	}
}

func RunnerHeadDelta(operation Operation) (RunnerDelta, error) {
	switch operation {
	case OperationCheckpointCommit, OperationEffectAuthorize, OperationBudgetReserve, OperationBudgetSettle:
		return RunnerDelta{Revision: 1}, nil
	case OperationEffectComplete:
		return RunnerDelta{}, nil
	case OperationResumeAdvance:
		return RunnerDelta{Revision: 1, Generation: 1}, nil
	default:
		return RunnerDelta{}, failure(ErrorInvalid, "$/operation", "$/operation is invalid.")
	}
}
