---
schema: openslack.document.v1
id: production-gs6-code-review
status: In Review
authority: canonical
audience:
  - reviewers
  - contributors
owner: governance-control
updated: 2026-08-03
sources:
  - docs/architecture/ts-to-go-migration-roadmap.md
  - docs/architecture/contracts/governance-control.md
  - docs/architecture/contracts/qoder-mcp.md
  - packages/operator/contracts/governed-plan-authority/v1/manifest.json
  - packages/operator/src/__tests__/governed-plan-authority-chain.test.ts
  - services/governance-control/docs/api/openapi.yaml
  - services/governance-control/integration/source-manifest.v2.json
  - .github/workflows/notification-delivery-service.yml
---

# GS6 Governance Authority Cutover Code Review

## Scope

This review covers GS6 new-record routing from the Qoder MCP mutation profiles to the Go
Governance Control durable plan authority. TypeScript remains the plan compiler, host binding and
confirmation validator, sealed action dispatcher, and Collaboration audit projector. PostgreSQL is
the only durable record writer for a plan whose immutable route is `go / governance-control`.

The review includes strict Go receipts, route epochs and rollback drain, pending-audit recovery,
the local STDIO MCP 12/16/17 catalogs, exact-byte contracts, PostgreSQL migrations, OpenAPI, and
the exact hosted qualification workflow. It does not migrate existing TypeScript records or delete
the TypeScript writer.

This review does not establish authenticated Qoder Desktop, `QODER_VERIFIED`, remote MCP/OAuth,
release, live deployment, production activation, or independent human approval.

## Review Summary

| Perspective | Verdict                           | Evidence considered                                                                                                                                   |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript  | APPROVED                          | Immutable per-record routes, strict receipt/status binding, no local fallback, HTTP-to-store-to-service failure chains, journal recovery, path safety |
| Go          | APPROVED                          | PostgreSQL single writer, CAS/idempotency/fingerprint, state machine, active/drain epochs, pending-audit invariant, GET envelope closure, OpenAPI     |
| QA          | CLEAN / QUALIFIED for local scope | Failure and restart matrices, current-revision recovery, 4,097-entry bound, official SDK 16/17 paths, rollback drain, evidence ceilings               |
| Lead        | READY FOR HUMAN REVIEW            | Cross-language authority ownership, recovery ordering, tool-surface stability, contract and hosted-gate alignment                                     |

The first independent review found blocking gaps in rollback transport binding, pre-journal audit
recovery, expiry enforcement, end-to-end unknown-commit evidence, and Desktop/server exposure
ordering. Re-review then found an invalid `complete_execution + reconciliation_required` recovery
mapping, HTTP status/receipt drift, and an authority GET body-contract mismatch. The candidate was
corrected without changing the accepted GS6 architecture. The final TypeScript, Go, QA, and lead
reviews report no remaining code-level blocker.

## Authority and Recovery Boundaries

- A route sidecar is frozen before durable acceptance. A Go-routed plan is never written to the
  TypeScript local plan store, and transport, conflict, timeout, invalid receipt, or unknown commit
  never triggers per-request local fallback.
- A higher routing epoch selects the backend only for new records. Existing Go records retain their
  original epoch. Any policy with historical Go epochs requires the complete Go transport so old
  records and audit deliveries can drain after a `ts-local` rollback.
- Go mutation, immutable record version, head CAS, durable receipt, authority event, and one pending
  audit delivery commit in one PostgreSQL transaction. A plan cannot advance while its current
  revision audit remains pending, so at most one pending delivery exists and it binds the current
  head.
- TypeScript persists `prepared` audit journal bytes before Collaboration projection, marks the
  exact event `collaboration_recorded`, acknowledges Go idempotently, and retires the journal only
  after the acknowledgement. Startup also point-reads the current Go revision, closing the crash
  window between Go commit and local journal creation before MCP is exposed.
- Mutation responses bind exact canonical bytes, idempotency key, caller, workspace, routing epoch,
  expected build, path, and status. Only `201 accepted`, `200 duplicate`, and
  `202 reconciliation_required` combinations are valid. Unknown outcomes are recovered only from
  the exact durable receipt and otherwise remain fail-closed.
- The recovery mapping accepts only the frozen operation/state pairs. In particular,
  `reconciliation_required` is acknowledged through `require_reconciliation`, never by pretending
  it was a normal `complete_execution` result.

## Surface and Security Boundaries

- The local MCP catalogs remain exactly 12 read-only, 16 agent-bound, and 17 human-attested tools.
  No shell, generic command, direct GitHub approval/merge, policy, registry, or arbitrary adapter
  authority was added.
- Human-attested Workflow decisions retain their separate local human binding and do not become
  GitHub review. The official SDK test forwards the same Go authority binding while preserving the
  exact 17-tool catalog.
- Route, policy, and audit files use canonical bounded bytes, atomic publication, no-follow opens,
  realpath containment, stable file/directory identities, and bounded recovery scans. Unknown,
  damaged, linked, replaced, or multiply owned state fails closed.
- The private HTTP surface accepts only IP-literal loopback or explicitly configured internal
  transport. DNS names, credentials, redirects, fragments, extra paths, query parameters, read
  bodies, oversized/noncanonical responses, workspace drift, and build drift are rejected.
- Go authority accept is default-off. This interface has no remote tenant authentication and is not
  a public Connector or production network boundary.

## Local Validation Basis

- Governance authority generation and exact-byte mirror check: 36 generated files current.
- Focused Vitest: Operator 62/62, MCP composition 18/18, CLI command and official SDK 35/35, and
  hosted-workflow contract 6/6 passed. The 4,097-sidecar boundary has an explicit 90-second test
  budget and passed locally.
- The real TypeScript failure chain exercises `GovernanceAuthorityHttpClient -> RoutedStore ->
GovernedPlanService`. Accept/claim timeout, 503, receipt 404/timeout/202, and terminal uncertainty
  preserve zero local records, zero pre-claim effects, and exactly-once terminal execution.
- Root TypeScript build/typecheck, targeted ESLint, changed-file Prettier, documentation verify,
  documentation migration-check, contract freshness, and `git diff --check` passed.
- Go 1.26.5 `gofmt`, `go test -count=1 ./...`, `go vet ./...`, and `go build ./...` passed for
  locally runnable packages. Verbose inspection confirmed that PostgreSQL and qualification tests
  were skipped without `DATABASE_URL`; those skips are not counted as database passes.
- The repository inventory records 5,439 Vitest tests in 437 files. This is a frozen collection
  inventory, not a claim that the complete repository suite was executed in this review.

## Hosted Evidence Still Required

The exact committed PR head must pass the mandatory hosted Governance Control verifier, including:

- pinned PostgreSQL 18.4 authority, CAS, response-loss, migration, and same-volume restart tests;
- official MCP SDK to TypeScript routing to Go HTTP to PostgreSQL single-writer qualification;
- Go race qualification;
- pinned container build, health/version/metrics and authority HTTP smoke;
- OpenAPI, Prometheus, SBOM, distribution, source-manifest, and exact-head workflow checks.

The current host has no PostgreSQL service, Docker daemon, or CGO compiler, so these are explicit
hosted gates rather than local pass claims.

## Verdict

**READY FOR INDEPENDENT HUMAN REVIEW.** The implementation review found no remaining code-level
blocker. Because `.github/**` is modified, the candidate remains Red Zone and requires independent
human approval after exact-head hosted checks. This record does not originate that approval and
does not claim PRMS readiness, merge completion, authenticated Desktop, remote Connector, release,
live evidence, or production verification.
