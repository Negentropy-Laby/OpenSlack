---
schema: openslack.document.v1
id: cdd-module-github-task-loop
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: github-task-loop
updated: 2026-07-28
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
