---
schema: openslack.document.v1
id: cdd-product-concept
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: product
updated: 2026-07-28
sources:
  - README.md
  - .openslack/modules.yaml
---

# OpenSlack Product Concept

## Overview

OpenSlack is a local-first, Git-backed operating system for human-agent software
teams. It turns chat and CLI interactions into governed work without allowing
an agent-facing interface to replace GitHub, Git, or human approval authority.

## User Promise

Users can discover, assign, execute, review, and understand work through one
observable workflow while retaining explicit control over identity, side
effects, approval, release, and live verification.

## Core Specification

The product has five modules: Self-Evolution, GitHub Task Loop, Operator, PR
Review and Merge, and Collaboration. Services and integrations are workstreams
that support these modules; they are not additional product modules.

## Data Model

Project plans and portfolio status use the root Memory Bank. Runtime module
telemetry uses `.openslack/modules.yaml`. Work execution uses Issues, claim
refs, branches, pull requests, reviews, checks, and audit evidence.

## Edge Cases

- Conflicting authorities fail closed.
- Missing owner is `unassigned`.
- A merged PR with an open governance Issue requires reconciliation.
- Local readiness never implies production or live verification.

## Dependencies

Git, GitHub, Node.js 22+, Bun, and the bounded runtime/service dependencies
declared by each module and workstream.

## Configuration

Project configuration is repository-scoped. Credentials and developer-local
runtime state are excluded from the project documentation authority.

## Acceptance Criteria

- Every active module and workstream traces to architecture, assignments,
  blockers, and evidence.
- Human approval remains independent from agent authorship and analysis.
- Generated status views reproduce deterministically from canonical YAML.
