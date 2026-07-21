# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is — and its current stage

`rc_wsman` is a **documentation-first** take-home assignment: an internal API notification-delivery service. Internal callers submit an already-formed vendor HTTP body; the service persists it in a PostgreSQL transactional outbox and delivers to operator-approved vendor HTTPS endpoints with at-least-once semantics, bounded retry, queryable dead-letter state, and guarded manual replay.

The deliverable is the documentation set plus an owner-authorized MVP implementation in progress (batches B1–B6 per [`docs/development-plan.md`](docs/development-plan.md)). **B1 (engineering foundation) and B2 (Notification Store core) are complete and verified**: `migrations/` base schema (pending rows ARE the outbox, dead rows ARE the DLQ, append-only triggers), `internal/config` (env allowlist + fail-closed pepper), `internal/app` (chi v5 `/healthz` + `/metrics`, graceful shutdown), `cmd/server` (startup migrations + schema version check), `internal/notificationstore` (domain + pure state machine + PostgreSQL repository with `FOR UPDATE SKIP LOCKED` claim, OCC, HMAC-signed cursors), full unit + real-PostgreSQL integration tests run with `-race` via Docker. The authoritative stage is [`production/stage.txt`](production/stage.txt) = **`Implementation`**. B3 (Caller Access + Vendor Registry) onward has **not** been authorized.

**Do not start B3+ work (caller/vendor APIs, delivery workers, operations endpoints) or run any stage gate without explicit owner authorization.** The project treats each batch as a separately-authorized step. The local shell has no Go toolchain — build/vet/test run in Docker (`golang:1.26.5`, `GOMODCACHE=.gomodcache`; DB integration tests need `docker compose up -d db` and `DATABASE_URL`).

## Non-obvious working rules (read before editing)

Enforced by the project's CDD (Constitution-Driven-Development) methodology; easy to violate by accident:

- **Authoritative stage**: `production/stage.txt`. Mirrored in `memory_bank/t0_core/current_state.md` and `memory_bank/t0_core/active_context.md` — keep all three consistent when the stage changes.
- **Append + supersede, never overwrite**: review and gate evidence lives in consolidated archives (`design/cdd/reviews/review-archive.md`, `docs/architecture/architecture-review-archive.md`, `memory_bank/t3_archive/gate-archive.md`); append new entries instead of editing recorded verdicts. On 2026-07-21 the owner authorized a one-time consolidation that merged the per-run originals into these archives (their dates/verdicts/SHA-256 are preserved there). Editing a reviewed artifact invalidates its recorded SHA-256 and demands a fresh review pass.
- **Authority Rule** (`design/registry/entities.yaml` line 9): every identifier has exactly one behavioral authority. Architecture may select mechanisms but must not weaken a CDD invariant; a consumer reference (e.g. `architecture.md`) does not grant write ownership.
- **Change Rule** (`docs/architecture/requirements-traceability.md`): adding or changing a CDD acceptance criterion requires updating `tr-registry.yaml` in the same change (component/ADR/test-type mappings). Family-level `planned_test_types` changes are NOT AC changes.
- **CTRL-024** (`docs/architecture/control-manifest.md`): no Kafka, Redis, independent DLQ, scheduler platform, or service mesh in the MVP; no unbounded retry, lease renewal, automatic dead replay, or local fallback state.
- **No SLA before implementation** (`docs/testing/test-strategy.md`): do not invent numeric latency/throughput/RPO/RTO targets — decided later at Architecture + load-test.
- **Secrets are CTRL-016**: the API-key pepper *value* is never persisted (only the non-secret `pepper_id` label on `access_keys`); secret values never enter Store/logs/metrics/audit/responses.
- **Style**: documentation is bilingual — Chinese prose with English technical terms. Match the surrounding file's density, headings, inline-code, and relative-path cross-references. AI assistance is recorded per stage in `docs/ai-usage.md` (append a new section when a new stage begins).

## Methodology — layers and stages

The repo manually follows an external CDD framework (no runtime installed; `memory_bank/t2_execution/workflow_contract.md` is a hand-maintained mirror).

- **Layers**: `T0` laws (`memory_bank/t0_core/`, BL-01..06 constitution) → `T1` support context (`memory_bank/t1_axioms/`) → `T2` execution (`memory_bank/t2_execution/`) → `T3` archive (`memory_bank/t3_archive/`, review + gate evidence).
- **Stages** (each transition gated): Concept → Specification → Architecture → Pre-Implementation → Implementation. Current: **Architecture**.
- **CDDs** (Constitution-Driven Designs) in `design/cdd/` — six module contracts plus `product-concept.md` and `module-index.md`; each carries atomic GIVEN/WHEN/THEN acceptance criteria (290 canonical AC total).
- **ADRs** in `docs/architecture/adr-NNNN-*.md`; inventory + ownership in `docs/architecture/adr-registry.yaml`.

## Architecture (big picture)

One Go binary, one process; PostgreSQL is the only persistent truth and coordination authority.

- **Transactional outbox**: intake persists notification + outbox visibility in one transaction (only then `202`). Pending rows ARE the outbox; dead rows ARE the DLQ — no second queue/table (ADR-0001).
- **At-least-once delivery**: workers claim oldest-eligible rows `FOR UPDATE SKIP LOCKED` with a lease; results transition via OCC + lease validation; lease recovery handles crash-after-send (ADR-0001/0002). External duplicates are possible and publicly disclosed.
- **Six logical modules** (packages, not services): Caller Access · Vendor Registry · Notification Store · Delivery · Operations Control · Reliability Observability (+ App lifecycle). Ownership table in `architecture.md`; DAG + dependency counts in `design/cdd/module-index.md` and `memory_bank/t1_axioms/knowledge_graph.md`. Only an owner writes its tables.
- **Failure convergence**: 25 attempts or 24h ⇒ `dead`. B-01 ruling — a retryable result finishing at/after `cycle_send_cutoff` atomically dies in the *current* Store write (no second claim). See `design/cdd/reviews/delivery-deadline-adjudication.md` and `design/cdd/reviews/deadline-backlog-pressure-analysis-2026-07-20.md`.
- **Security**: callers submit only `vendor_id` + payload; destinations/credentials are Registry-owned. SSRF-safe outbound (DNS pinning, no redirect, pinned-IP dial, no response-body consumption) — ADR-0004. API keys stored as `HMAC-SHA-256(pepper, key)` with a versioned pepper lifecycle (rotation/recovery/invalidation) — ADR-0003.
- **Stack** (target, pinned in `standards/technical-preferences.md`): Go 1.26.5, chi v5, pgx v5, golang-migrate v4, Prometheus `client_golang` v1, PostgreSQL 18.4, OpenAPI 3.1.

Authoritative sources: `docs/architecture/architecture.md` (master), `data-model.md`, `control-manifest.md` (CTRL-001..024), and `docs/api/openapi.yaml` (the fixed contract — design authority until code exists).

## Repository layout

```
README.md, docs/design.md, docs/ai-usage.md       entry points
docs/architecture/      master arch, data model, 4 ADRs, control manifest, traceability, registries, review archive
docs/api/openapi.yaml   OpenAPI 3.1 contract
docs/security/          threat model
docs/operations/        runbook
docs/testing/           test strategy
standards/              technical preferences (stack, package boundaries, forbidden patterns)
design/cdd/             6 module CDDs + product-concept + module-index + reviews/ (archive + 2 decision docs)
design/registry/        entities.yaml (schema/api/permission/config authority map)
design/ux/              surface profile + interaction patterns
design/accessibility-requirements.md  Basic-tier accessibility requirements (CP0)
go.mod                  resolved manifest (chi/pgx/migrate/client_golang; go.sum tracked)
cmd/server/             binary entry: config → pool → migrations → HTTP lifecycle
internal/app/           chi v5 HTTP lifecycle (healthz/metrics, graceful shutdown)
internal/config/        env allowlist config + fail-closed pepper loading
internal/delivery/      CP0 full-jitter backoff leaf + unit test (stdlib-only)
internal/notificationstore/  B2 Store: domain + pure state machine + postgres adapter
migrations/             golang-migrate SQL (000001 base schema, append-only triggers)
tests/                  unit/ + integration/ (real PostgreSQL via DATABASE_URL; skip when unset)
.github/workflows/      tests.yml CI (go mod tidy / go vet / go test -race)
memory_bank/t0_core/    constitution (BL-01..06) + state mirrors
memory_bank/t1_axioms/  tech/system/behavior/qa/architecture/ux/knowledge/module-support context
memory_bank/t2_execution/  workflow contract (manual)
memory_bank/t3_archive/    gate-archive + review index + amendments
production/stage.txt   authoritative stage token (= Architecture)
.aby/                   tooling state — NOT project documentation; ignore
```

## Verification

The local shell has **no Go toolchain**; build/vet/test run in Docker (authorized):

```bash
docker compose up -d db
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/src" -w /src \
  -e GOMODCACHE=/src/.gomodcache \
  -e DATABASE_URL="postgres://rc_wsman:rc_wsman@host.docker.internal:5432/rc_wsman?sslmode=disable" \
  golang:1.26.5 sh -c "go build ./... && go vet ./... && go test -race ./..."
```

CI mirrors this in `.github/workflows/tests.yml` (`go mod tidy`, `go vet ./...`, `go test -race ./...` on push/PR). The repeatable documentation checks the reviews perform (from repo root, Git Bash):

- **YAML registries parse, no duplicate keys**: `python -c "import yaml; yaml.safe_load(open('docs/architecture/tr-registry.yaml'))"` — repeat for `docs/architecture/adr-registry.yaml` and `design/registry/entities.yaml`.
- **Local Markdown links resolve**: confirm every `](...md...)` target exists.
- **AC count unchanged**: `tr-registry.yaml` enumerates 290 canonical AC + 4 NSBR mappings across 24 requirement families.
- **Artifact SHA-256**: `sha256sum <file>` — recorded per-file in review evidence (`docs/architecture/architecture-review-archive.md`).

When implementation is eventually authorized, add the build/lint/test commands here.
