package runnerbindingcontract

import "testing"

// The active subtest owns fixture configuration failures and prior validation.
func goldenControlContext(t *testing.T, golden bindingGoldenVectors, kind string, control controlGoldenExchange) ControlDeliveryValidationContext {
	t.Helper()
	exchange, ok := golden.Positive.Operations[string(control.Operation)]
	if kind == "budget_authorization" {
		exchange, ok = golden.Positive.SemanticVariants["budgetReserveGoAuthority"]
	}
	if !ok || exchange.Stage.Value == nil || exchange.StageReceipt.Value == nil || exchange.Resolution.Value == nil || exchange.ResolutionReceipt.Value == nil {
		t.Fatalf("missing operation context for control kind %s", kind)
	}
	return ControlDeliveryValidationContext{
		Stage: exchange.Stage.Value, StageReceipt: exchange.StageReceipt.Value,
		Resolution: exchange.Resolution.Value, ResolutionReceipt: exchange.ResolutionReceipt.Value,
		PriorEventDelivery: controlPriorForGolden(t, golden, kind, control), BudgetSourceResult: control.BudgetSourceResult,
	}
}
