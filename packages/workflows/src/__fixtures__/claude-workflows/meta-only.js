// Fixture: Anthropic-compatible module with ONLY meta export.
// analyzeStaticMeta should parse this successfully.
// detectFormat should return 'anthropic-compatible' (has meta, no preview/run).

export const meta = {
  name: "meta-only",
  description: "Meta-only claude workflow",
  phases: [
    { title: "Scan", detail: "Scan phase" }
  ]
}
