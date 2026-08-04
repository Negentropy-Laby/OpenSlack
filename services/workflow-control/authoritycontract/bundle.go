package authoritycontract

import (
	"embed"
	"fmt"
)

// generatedBundle is an exact-byte mirror generated from the TypeScript-owned
// v2 contract bundle. Embedding it makes validators self-contained but does
// not transfer generation or runtime authority to Go.
//
//go:embed generated/v2/*.json generated/v2/schemas/*.json
var generatedBundle embed.FS

var bundleFiles = []string{
	"schemas/workflow-control-authority-state.v2.schema.json",
	"schemas/workflow-control-authority-message.v2.schema.json",
	"schemas/workflow-control-authority-prepared-message.v2.schema.json",
	"schemas/workflow-control-authority-receipt.v2.schema.json",
	"golden-vectors.json",
	"manifest.json",
}

func BundleFiles() []string { return append([]string(nil), bundleFiles...) }

func BundleFile(name string) ([]byte, error) {
	for _, allowed := range bundleFiles {
		if name == allowed {
			return generatedBundle.ReadFile("generated/v2/" + name)
		}
	}
	return nil, fmt.Errorf("authority contract bundle file %q is not in the closed inventory", name)
}
