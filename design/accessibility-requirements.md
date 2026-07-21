# Accessibility Requirements

> **Status**: Draft — Pre-Implementation CP0 (pending Architecture→Pre-Implementation gate review)
> **Tier**: Basic
> **Domain**: internal headless Bearer-auth JSON/HTTP API + data/migration workflow
> **Authority sources**: `../memory_bank/t1_axioms/ux_accessibility_context.md`,
> `design/ux/surface-profile.md`, `design/ux/interaction-patterns.md`,
> `../docs/api/openapi.yaml`, ADR-0002/ADR-0003, `../docs/architecture/data-model.md`

## Product Adaptation Note

rc_wsman is an internal **headless** notification-delivery service. It has no end-user-facing
UI and no human-sensory surface. WCAG — which addresses human perception of web content — is
therefore **not applicable** to the Bearer-auth JSON/HTTP surface (per `design/ux/surface-profile.md`:
"No visual identity, accessibility UI requirements or prototype screen is applicable").

The applicable accessibility obligation is **API-contract ergonomics** for the developer and
operator audience: machine-readable, stable, versioned errors; safe retry/idempotency; sanitized
asynchronous state; and predictable batch semantics. This document commits the service to the
**Basic** tier on the API/SDK surface and on the data/migration workflow surface.

Higher tiers (SDK example library, integrator usability testing) are deferred to a future
v1+ SDK/integrator program (see Scope).

## Sensory Applicability

| Section | Applicability | Rationale |
|---|---|---|
| Visual | N/A | No visual/UI surface; headless API. |
| Motor | N/A | No pointer/touch/gesture surface; headless API. |
| Cognitive | N/A — addressed via API-ergonomics Basic tier below | Cognitive load for the human operator is reduced through stable errors, sanitized status, and OpenAPI/runbook documentation — not via a sensory UI. |
| Auditory | N/A | No audio surface. |
| Platform accessibility API | N/A | No UI component exposes a platform accessibility tree. |

## Applicable Surfaces

### API/SDK Surface — Tier: Basic

Basic API/SDK = machine-readable errors with stable codes and documentation links. Delivered by:

- **Stable versioned error envelope** — closed typed error categories at module boundaries
  (`../standards/technical-preferences.md` Go Conventions); versioned error shapes in
  `../docs/api/openapi.yaml` (ADR-0002 response envelope, ADR-0003 caller-access errors).
- **Idempotency / retry guidance** — `Submit and Forget` (`design/ux/interaction-patterns.md`):
  `202` = durable acceptance, not vendor delivery; identical bytes under the same
  `Idempotency-Key` is safe; changed bytes under the same key → visible `409`.
- **Sanitized asynchronous status** — `Asynchronous Status`: responses expose stable states and
  sanitized diagnostics only; payload, credential, lease and actor internals are never leaked.
- **Preview then Execute** — replay preview is read-only; execute is a new authenticated request
  with explicit IDs/expected versions; state drift yields per-item skip, never silent overwrite.
- **Partial Batch Result** — every input index appears exactly once in `succeeded`/`skipped`/
  `failed`; a top-level success never hides per-item failure.
- **Enumeration-Safe Errors** — missing/out-of-scope/protected lifecycle states share a public
  negative result; detail is revealed only after authorization proves scope.
- **OpenAPI as the contract surface** — `../docs/api/openapi.yaml` is the machine-readable
  contract; `../docs/operations/runbook.md` documents operator workflows.

### Data / Migration Surface — Tier: Basic

Basic data/migration = dry-run/preview capability plus readable row-level diagnostics. Delivered by:

- **Dry-run via preview-then-execute** — replay `preview` is the read-only dry run before any
  state mutation.
- **Readable per-item diagnostics** — sanitized per-item `skipped`/`failed` reasons keyed by
  input index; no credential/payload/internal leakage.
- **Migration safety** — forward-only migration with rollback verification
  (`../docs/architecture/data-model.md` migration principles); the logical schema is the contract,
  DDL is an Implementation artifact.

## Scope

**In scope (MVP, Basic tier):** stable versioned error envelope; idempotency/retry guidance
(`202`/`409` + `Idempotency-Key`); sanitized asynchronous status; preview-then-execute;
partial-batch results; enumeration-safe errors; migration forward + rollback verification;
OpenAPI as the contract surface.

**Out of scope (deferred):** SDK example library; integrator usability testing; WCAG for a
non-existent web UI; CLI/GUI accessibility (CLI/GUI excluded from MVP per `surface-profile.md`).

## Test Plan

- **Contract tests** derived from CDD AC and `../docs/api/openapi.yaml`
  (`../standards/technical-preferences.md` Quality Rules): assert error-envelope stability,
  idempotency `409` semantics, sanitized status (no payload/credential/lease/actor leakage),
  enumeration-safe negatives, and partial-batch exactly-once-per-index ordering.
- **Migration tests**: forward application + rollback verification per `data-model.md` migration
  principles.
- **No sensory/UI accessibility tests** — N/A (headless API, no human-sensory surface).
