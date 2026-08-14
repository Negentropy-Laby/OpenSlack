package budgetcontract

import (
	"embed"
	"fmt"
)

// generatedBundle is an exact-byte mirror of the TypeScript-owned E1 bundle.
// Embedding it makes the pure validator self-contained without transferring
// writer, persistence, routing, or runtime authority to Go.
//
//go:embed generated/v1/*.json generated/v1/schemas/*.json
var generatedBundle embed.FS

var bundleFiles = []string{
	"schemas/workflow-budget-account.v1.schema.json",
	"schemas/workflow-budget-reserve-request.v1.schema.json",
	"schemas/workflow-budget-reserve-decision.v1.schema.json",
	"schemas/workflow-budget-reservation.v1.schema.json",
	"schemas/provider-usage-receipt.v1.schema.json",
	"schemas/workflow-budget-settlement-request.v1.schema.json",
	"schemas/workflow-budget-settlement.v1.schema.json",
	"schemas/workflow-budget-ledger-entry.v1.schema.json",
	"schemas/workflow-budget-receipt.v1.schema.json",
	"schemas/workflow-budget-reconciliation.v1.schema.json",
	"schemas/workflow-budget-legacy-approval-observation.v1.schema.json",
	"schemas/workflow-budget-prepared-request.v1.schema.json",
	"golden-vectors.json",
	"manifest.json",
}

func BundleFiles() []string { return append([]string(nil), bundleFiles...) }

func BundleFile(name string) ([]byte, error) {
	for _, allowed := range bundleFiles {
		if name == allowed {
			return generatedBundle.ReadFile("generated/v1/" + name)
		}
	}
	return nil, fmt.Errorf("workflow budget authority bundle file %q is not in the closed inventory", name)
}
