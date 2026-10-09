---
schema: openslack.document.v1
id: cdd-module-github-task-loop
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: github-task-loop
updated: 2026-09-21
sources:
  - .openslack/modules.yaml
  - docs/contributor/github-issues-loop.md
---

# GitHub Task Loop Module CDD

## Overview

The GitHub Task Loop discovers, creates, claims, executes, and closes work
through GitHub Issues.

## User Promise

Humans and agents can see who has claimed a task, where the isolated work lives,
and which pull request or evidence completes it.

## Core Specification

Claims use deterministic refs, heartbeats, expiry, repair, isolated worktrees,
task sync, and PR-to-Issue lifecycle reconciliation.

## Data Model

Issue number, labels, claim ref, claimant identity, heartbeat, branch, worktree,
pull request, and final Issue state.

## Edge Cases

Concurrent claims have one winner. Expired claims require repair. A merged pull
request with an open Issue is not silently considered done.

## Dependencies

`@openslack/github`, `@openslack/runtime`, and `@openslack/core`.

## Configuration

Repository, label, watcher, and claim settings are explicit workspace config.

## Acceptance Criteria

- Claims are atomic and identity-bound.
- Work executes outside the canonical checkout.
- Completion reconciles Issue and PR evidence.

## Task Claim v2: C0 Contract Workstream

Task Claim v2 is a separate, future Go/PostgreSQL authority workstream. Its
current deliverable is the [C0 contract](../../../docs/architecture/contracts/task-claim-v2-c0.md),
not a migration or an implemented claim service. Existing refs, comments and
labels remain the current Task Loop protocol; their existence alone does not
prove the strong ownership and lease binding required by a future v2 consumer.

The cleanup broker's Permit-only route is independent of this workstream.
A permit task reference is an administrative scope binding, not a live claim
or lease attestation. Do not infer task ownership from it or add an implicit
legacy-claim fallback. Future Claim v2 consumers must require the independently
qualified authority contract.

C0 must define task-definition digests separately from lifecycle projections,
epoch/revision-bound ownership, atomic lease transitions, writer fencing,
unknown-result reconciliation and staged migration. No dual authoritative
writes are allowed. Rollback closes new admission, drains admitted work and
preserves reconciliation; it never re-enables an unfenced old writer.
