package runnerbindingcontract

import (
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

func TestFractionalBudgetRateUsesCanonicalE1Arithmetic(t *testing.T) {
	t.Parallel()
	const path = "$/evidence/rateNanoUsdPerToken"
	rate, err := rateValue("0.125", path)
	if err != nil {
		t.Fatalf("validate fractional rate: %v", err)
	}
	charge, err := budgetcontract.ChargeNanoUSD("12", rate)
	if err != nil {
		t.Fatalf("charge fractional rate: %v", err)
	}
	if charge != "2" {
		t.Fatalf("half-up fractional charge = %s, want 2", charge)
	}
	if _, err := rateValue("1.000000000000000001", path); err != nil {
		t.Fatalf("18-digit canonical fractional rate rejected: %v", err)
	}
}
