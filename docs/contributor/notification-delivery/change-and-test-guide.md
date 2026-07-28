---
schema: openslack.document.v1
id: contributor-notification-delivery-change-test
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Notification Delivery Change And Test Guide

Choose tests by the boundary being changed. The commands below are the focused minimums; repository
validation and PR governance still apply.

## Change Matrix

| Change type                    | Primary files                                                                                                     | Contract and documentation                                            | Focused verification                                                                                                                | Typical risk                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Route, queue, Blob, receipt    | `packages/github/src/watch-*.ts`, `notification-blob-store.ts`, `notification-receipt-store.ts`                   | Integration contract, operations guide when operator behavior changes | Relevant `packages/github/src/__tests__/notification-*.test.ts`; workspace typecheck                                                | Yellow                                       |
| Handoff or operations client   | `notification-service-client.ts`, `notification-service-ops-client.ts`                                            | Integration contract, security boundary                               | Client, handoff-contract, operations, and reconciliation tests                                                                      | Yellow                                       |
| Reconciliation or recovery     | `notification-reconciliation.ts`, `notification-delivery-operations.ts`                                           | Operations guide and security boundary                                | `notification-delivery-operations.test.ts`, `notification-reconciliation.test.ts`                                                   | Yellow                                       |
| Service OpenAPI                | `services/notification-delivery/docs/api/openapi.yaml`, Go handlers and domains                                   | Integration contract and service architecture                         | `go test ./internal/app`; `go test ./tests/contracts`; manifest verification                                                        | Yellow                                       |
| PostgreSQL, outbox, worker     | `services/notification-delivery/internal/**`, `migrations/**`                                                     | Service architecture, data model, runbook                             | `go test ./...`; `go vet ./...`; `go test -race ./...`; PostgreSQL integration tests where required                                 | Yellow                                       |
| Service documentation          | `services/notification-delivery/README.md`, `docs/**`, `design/**`, `memory_bank/**`                              | Keep OpenSlack lifecycle claims in root docs                          | Update affected workspace-manifest entries; `sha256sum --check docs/testing/workspace-manifest.sha256`; `go test ./tests/contracts` | Yellow                                       |
| Cross-system security boundary | `packages/github/**`, service security/transport/auth code, root security docs                                    | Threat model plus root security boundary                              | Relevant TypeScript and Go security/contract tests; negative payload/secret disclosure checks                                       | Yellow or Red if protected paths are touched |
| Qualification contract         | `packages/github/src/notification-import-qualification*`, `deploy/notification-import-qualification/**`, workflow | Evidence map, integration contract, schema and environment manifests  | Qualification unit/deployment tests, typecheck, workflow invariant tests; `.github/**` review                                       | Red when workflow changes                    |

## Platform Route, Queue, Or Client

Run only the relevant focused files while iterating, then the package/repository gates:

```bash
bun vitest run packages/github/src/__tests__/notification-handoff-contracts.test.ts
bun vitest run packages/github/src/__tests__/notification-service-client.test.ts
bun vitest run packages/github/src/__tests__/notification-delivery-operations.test.ts
bun vitest run packages/github/src/__tests__/notification-reconciliation.test.ts
bun run typecheck
```

If the final bytes, idempotency key, strict `202`, HTTP classification, or authority transfer
changes, update both sides of the contract in the same governed change. Accepted records must never
gain a direct fallback.

## Service OpenAPI

An OpenAPI edit is not documentation-only when it changes the wire contract. Update the Go
implementation and any TypeScript client parser that consumes the changed shape.

From `services/notification-delivery`:

```bash
go test ./internal/app
go test ./tests/contracts
go build ./...
go vet ./...
go test -race ./...
```

Update the service workspace manifest entry for every changed or added in-scope file.

## PostgreSQL, Outbox, Or Vendor Delivery

Keep notification/outbox visibility atomic and preserve append-only attempts, bounded retry,
manual replay, and safe outbound transport. Run the full Go suite and any PostgreSQL-backed tests
required by the changed package. Update architecture, data model, runbook, threat model, and
OpenAPI only where their owned facts changed.

Do not move service database state into OpenSlack's local queue or make the service documentation
the source of OpenSlack lifecycle status.

## Service Documentation And Manifest

The manifest is
`services/notification-delivery/docs/testing/workspace-manifest.sha256`.

- Each line is a lowercase SHA-256, two spaces, and a POSIX relative path.
- Paths are unique and strictly sorted.
- Update only entries for affected files and add entries for new in-scope files.
- Do not hash the manifest itself.
- Do not use an absolute path, `..`, a backslash, or a symlink.

Verify from the service root:

```bash
sha256sum --check docs/testing/workspace-manifest.sha256
go test ./tests/contracts
```

## Security Boundary

Review changes for:

- caller and auditor principal separation;
- credential references rather than exposed secret values;
- no payload, endpoint, secret, or raw vendor-response disclosure;
- HTTPS, SSRF defenses, DNS pinning, and no redirects;
- immutable accepted-record authority;
- metadata-only reconciliation and fail-closed quarantine.

Update the [root boundary](../../security/notification-delivery-boundary.md) only when the
cross-system contract changes. Service implementation details remain in the
[service threat model](../../../services/notification-delivery/docs/security/threat-model.md).

## Qualification

Qualification changes must preserve the distinction between:

- the report schema and verifier;
- deployment/environment inputs;
- the protected workflow;
- a future sealed report; and
- lifecycle authorization that remains outside the report.

The current repository contains no passing post-import qualification receipt. Do not create a
narrative substitute or claim IB7 from fixture/unit-test success.

## Repository Gates

Before delivery, run the gates appropriate to the final scope:

```bash
bun run typecheck
bun run test
bun run -w run build
bun run openslack status verify
bun run openslack workspace validate
bun run openslack self eval --suite golden
bash scripts/genesis-validate.sh
```

Classify the actual changed paths with `openslack self classify-pr`. Root `docs/**` is Green,
implementation paths are generally Yellow, and `.github/**` is Red. All PRs still require valid
human approval under repository governance.
