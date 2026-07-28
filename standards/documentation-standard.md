---
schema: openslack.document.v1
id: standard-documentation
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-07-28
sources:
  - docs/reference/schemas/documentation/document-metadata.schema.json
  - memory_bank/document_map.yaml
---

# Documentation Standard

Active English Markdown uses `openslack.document.v1` frontmatter with `id`,
`status`, `authority`, `audience`, `owner`, `updated`, and `sources`. IDs and
paths are unique. Active documents contain no template placeholders.

Canonical facts are declared once in `memory_bank/document_map.yaml`.
Projections name their source and are regenerated, never hand-edited. Archived
documents keep historical claims but are not operating guidance.
