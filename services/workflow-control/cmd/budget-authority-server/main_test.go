package main

import (
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
)

func TestBudgetAuthorityServerAcceptsSchemaVersionsSixThroughNine(t *testing.T) {
	if databaseready.BudgetProfile.Minimum != 6 || databaseready.BudgetProfile.Maximum != 9 ||
		databaseready.CurrentSchemaVersion != 9 {
		t.Fatalf("budget authority schema range=%d..%d current=%d",
			databaseready.BudgetProfile.Minimum, databaseready.BudgetProfile.Maximum, databaseready.CurrentSchemaVersion)
	}
}
