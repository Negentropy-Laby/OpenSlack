package runnerprotocol

import _ "embed"

var (
	//go:embed generated/v1/manifest.json
	embeddedManifest []byte
	//go:embed generated/v1/golden-vectors.json
	embeddedGoldenVectors []byte
	//go:embed generated/v1/schemas/workflow-runner-message.v1.schema.json
	embeddedMessageSchema []byte
	//go:embed generated/v1/schemas/workflow-runner-prepared-message.v1.schema.json
	embeddedPreparedMessageSchema []byte
)

// ContractManifestBytes returns a defensive copy of the TypeScript-owned v1
// contract manifest mirrored into this validator package.
func ContractManifestBytes() []byte { return cloneBytes(embeddedManifest) }

// GoldenVectorsBytes returns a defensive copy of the cross-language vectors.
func GoldenVectorsBytes() []byte { return cloneBytes(embeddedGoldenVectors) }

// MessageSchemaBytes returns a defensive copy of the closed message schema.
func MessageSchemaBytes() []byte { return cloneBytes(embeddedMessageSchema) }

// PreparedMessageSchemaBytes returns a defensive copy of the prepared-message
// schema.
func PreparedMessageSchemaBytes() []byte { return cloneBytes(embeddedPreparedMessageSchema) }

func cloneBytes(value []byte) []byte { return append([]byte(nil), value...) }
