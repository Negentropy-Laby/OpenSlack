---
schema: openslack.document.v1
id: production-gs3-a-code-review
status: In Review
authority: canonical
audience:
  - reviewers
  - contributors
owner: organization-graph
updated: 2026-08-01
sources:
  - docs/architecture/adr/adr-0002-multi-go-service-workspace.md
  - docs/architecture/ts-to-go-migration-roadmap.md
  - packages/organization-graph/src/read-mirror.ts
  - services/organization-graph/internal/app/gs3a_cross_language_test.go
  - .github/workflows/notification-delivery-service.yml
---

# GS3-A MCP Organization Graph Mirror-Read Code Review

## Scope

This review covers the GS3-A default-off MCP Organization Graph mirror-read.
After a successful local TypeScript query or explanation, the implementation
sends the same bounded input to one fixed Go HTTP origin, records a bounded
differential observation, and returns only the TypeScript authority result.

This review does not authorize a canary, routing epoch, implicit cursor
translation, per-request fallback, Graph-head transfer, Go read or write
authority, an authenticated Qoder Desktop claim, a remote Connector, release,
live evidence, or production use.

## Review Summary

| Perspective  | Verdict                         | Evidence considered                                                                                                                               |
| ------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript   | APPROVED                        | Authority isolation, strict transport and response bounds, exhaustive result comparison, cursor handling, schemas, cloning, and type checking     |
| Architecture | CONCERNS; NO BLOCKING FINDINGS  | Dependency direction, authority ownership, profile invariants, origin validation, audit minimization, runtime validation, and deferred GS3-B work |
| QA           | ADEQUATE / PASS; EXECUTION NOTE | Default-off behavior, failure isolation, 12/16/17 profiles, bounded audit, real-handler gate design, and exact-head hosted qualification          |

The technical review found no remaining code-level blocking change. Follow-up
review found that the initially closed Collaboration object-kind set omitted the
existing `push`, `job`, and `notification_route` observation handles, which
would have silently dropped valid profile-sync and notification events. The set,
contract, and regression coverage now preserve those emitters while unknown
kinds still fail closed. Earlier findings were also closed by applying the
deadline to both headers and body reads, enforcing canonical-payload size
independently from the optional terminal line feed, hashing rather than
persisting raw cursors, starting a real Go handler in the cross-language gate,
and emitting a fixed stderr diagnostic when the bounded audit sink fails.

This record recommends independent human review. It neither originates nor
substitutes for the repository's independent human approval.

## Architecture and Security Boundaries

- TypeScript computes first and remains the only user-visible read authority.
  The mirror receives structured clones and cannot mutate the returned object.
- No origin means no mirror client, network request, or mirror audit. The same
  optional port is injected into the unchanged 12, 16, and 17 tool profiles.
- The origin must be an exact credential-free HTTP IP origin. Loopback is the
  default; private or link-local addressing requires explicit `internal` mode.
- The end-to-end deadline covers connection, headers, response-body streaming,
  and classification. Redirects, unexpected status/content type, oversized
  responses, duplicate keys, and non-canonical JSON fail observationally.
- Query and explanation comparison covers every bounded result field. Cursor
  absence and cursor-token drift are distinct mismatches; neither is translated.
- Collaboration persists only unique matched, mismatched, or unavailable audit
  events containing hashes, digests, closed difference codes, status, and
  timing. It excludes endpoint, request body, graph objects, evidence contents,
  source events, and raw snapshot cursors.
- Audit failure cannot affect the TypeScript result. A fixed stderr diagnostic
  makes audit-store failure distinguishable from the absence of a mismatch.
- The real cross-language gate imports the built Organization Graph distribution,
  starts the actual Go HTTP handler, exercises query and explain over loopback,
  and requires both observations to match. Its Bun child process has a 20-second
  hard deadline.

## Validation Basis

- Repository TypeScript build/type checking, including the cross-language
  client against `packages/organization-graph/dist/index.js`.
- Focused Organization Graph, Collaboration, MCP SDK, CLI, workflow-structure,
  and 12/16/17 governed-profile tests.
- Formatting, diff hygiene, graph golden-contract, distribution-build, and
  documentation/status projection gates.
- Independent TypeScript, architecture, and QA review.

The current local environment has no Go toolchain, so it cannot execute or
format-check the real-handler Go test locally. Local evidence must not be
reported as cross-language qualification. The reviewed exact PR head must pass
the mandatory hosted Go gate before approval or merge; any repair commit
invalidates the prior hosted result and must be qualified again.

The unchanged Qoder Skill PowerShell installer test also remains locally
blocked on its second idempotency run because that child PowerShell process does
not resolve the system `Get-FileHash` command. The other 101 MCP tests pass, and
the failing installer and test files are unchanged from the PR base; this is not
reported as a GS3-A pass or repaired in this batch.

## Deferred Work

- GS3-B must bind the actual Go runtime build/contract identity into
  qualification evidence before introducing a scenario or tenant canary.
- GS3-B owns the reviewed routing decision, routing epoch, rollback, and the
  prohibition on silent per-request fallback.
- GS3-C alone may transfer Graph head/query/explain read authority after its
  own differential and canary evidence gates.

## Verdict

**READY FOR INDEPENDENT HUMAN REVIEW.** The implementation review found no
code-level blocker. This verdict does not claim independent approval, PRMS
readiness, merge completion, read cutover, Qoder qualification, release, live
evidence, or production verification.
