---
schema: openslack.document.v1
id: cdd-module-operator
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: operator
updated: 2026-07-28
sources:
  - .openslack/modules.yaml
  - docs/user/cli-reference.md
---

# Operator Module CDD

## Overview

Operator is the safe human-facing router for setup, status, diagnosis, and
intent-to-action planning.

## User Promise

Natural-language and direct commands resolve to typed registered actions with
visible parameters, risk, and confirmation requirements.

## Core Specification

Keyword routing is the zero-cost first layer. Optional model fallback may
recommend only typed registered actions and cannot bypass validation or
executor gates.

## Data Model

Intent, candidate action, confidence, typed parameters, risk zone, confirmation
state, executor binding, and result evidence.

## Edge Cases

Unknown or ambiguous intent remains a plan or error. Missing parameters,
identity, permission, or executor binding fails closed.

## Dependencies

`@openslack/operator`, CLI command registry, and bounded runtime providers.

## Configuration

Provider configuration is optional; the safe keyword path remains available.

## Acceptance Criteria

- Unknown model output cannot become an arbitrary command.
- High-risk actions show exact scope before confirmation.
- Status keeps portfolio, module, release, and approval claims separate.
