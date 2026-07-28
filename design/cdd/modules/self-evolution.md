---
schema: openslack.document.v1
id: cdd-module-self-evolution
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: self-evolution
updated: 2026-07-28
sources:
  - .openslack/modules.yaml
  - docs/architecture/components/self-evolution-kernel.md
---

# Self-Evolution Module CDD

## Overview

Self-Evolution governs how OpenSlack changes itself without bypassing repository
policy.

## User Promise

Every proposed change is classified, tested, reviewable, reversible, and unable
to manufacture approval.

## Core Specification

The module owns risk zones, workspace validation, policy decisions, golden
evaluations, genesis validation, rollback, observation, triage, and scorecards.

## Data Model

Inputs are changed paths, policy/invariant records, evaluation results, audit
events, and PR metadata. Outputs are bounded classifications and gate results.

## Edge Cases

Black Zone content is never mergeable. Missing policy or identity fails closed.
A green evaluation does not grant approval or release authority.

## Dependencies

`@openslack/kernel`, `@openslack/workspace`, and `@openslack/runtime`.

## Configuration

Constitutional and policy files remain protected Red Zone authorities.

## Acceptance Criteria

- Direct main pushes and validation bypass remain forbidden.
- Risk classification is deterministic for the same path set.
- Merge execution requires independently valid human approval.
