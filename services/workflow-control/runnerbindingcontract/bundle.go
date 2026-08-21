package runnerbindingcontract

import (
	"embed"
	"fmt"
)

// generatedBundle is an exact-byte mirror of the TypeScript-owned GS9-F2a
// authority-binding bundle. Embedding it makes the pure validator
// self-contained without transferring persistence, routing, or runtime
// authority to Go.
//
//go:embed generated/v1/*.json generated/v1/schemas/*.json
var generatedBundle embed.FS

var bundleFiles = []string{
	"schemas/workflow-runner-authority-binding-stage.v1.schema.json",
	"schemas/workflow-runner-authority-binding-resolution.v1.schema.json",
	"schemas/workflow-runner-authority-binding-receipt.v1.schema.json",
	"schemas/workflow-runner-authority-binding-error.v1.schema.json",
	"golden-vectors.json",
	"manifest.json",
}

// BundleFiles returns the closed generated artifact inventory in manifest
// order.
func BundleFiles() []string { return append([]string(nil), bundleFiles...) }

// BundleFile reads one allowlisted embedded artifact.
func BundleFile(name string) ([]byte, error) {
	for _, allowed := range bundleFiles {
		if name == allowed {
			return generatedBundle.ReadFile("generated/v1/" + name)
		}
	}
	return nil, fmt.Errorf("workflow runner authority-binding bundle file %q is not in the closed inventory", name)
}
