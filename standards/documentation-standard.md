---
schema: openslack.document.v1
id: standard-documentation
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-07-29
sources:
  - docs/reference/schemas/documentation/document-metadata.schema.json
  - memory_bank/control-plane.json#/authorities
---

# Documentation Standard

Active English Markdown uses `openslack.document.v1` frontmatter with `id`,
`status`, `authority`, `audience`, `owner`, `updated`, and `sources`. IDs and
paths are unique. Active documents contain no template placeholders.

Canonical facts are declared once in `memory_bank/control-plane.json#/authorities`.
Projections name their source and are regenerated, never hand-edited. Archived
documents keep historical claims but are not operating guidance.

The repository has one root Memory Bank. Its structured governance is JSON
only; nested Memory Banks and YAML/YML inside `memory_bank/` are invalid.
