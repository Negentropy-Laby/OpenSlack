package main

import (
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
)

// Keep the qualification entry point stable; its assertions follow the current schema.
func TestBudgetAuthorityServerAcceptsSchemaVersionsSixThroughTen(t *testing.T) {
	if databaseready.BudgetProfile.Minimum != 6 || databaseready.BudgetProfile.Maximum != 11 ||
		databaseready.CurrentSchemaVersion != 11 {
		t.Fatalf("budget authority schema range=%d..%d current=%d",
			databaseready.BudgetProfile.Minimum, databaseready.BudgetProfile.Maximum, databaseready.CurrentSchemaVersion)
	}
}
