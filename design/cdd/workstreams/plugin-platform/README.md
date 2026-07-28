---
schema: openslack.document.v1
id: cdd-workstream-plugin-platform
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: plugin-platform
updated: 2026-07-28
sources:
  - docs/contributor/plugins/manifest.md
  - docs/security/plugin-trust-model.md
---

# Plugin Platform Workstream CDD

## Overview

The Plugin Platform provides bounded manifests, host integration, authoring
guidance, and a testkit for OpenSlack extensions.

## User Promise

Extensions declare capabilities and trust requirements before loading, and can
be validated without granting undeclared authority.

## Core Specification

The workstream owns the public plugin contract, manifest validation, host
boundary, embedding contract, authoring flow, and reusable testkit.

## Data Model

Plugin identity, version, entrypoint, declared capabilities, trust tier, host
bindings, validation results, and test evidence.

## Edge Cases

Unknown capabilities, path escape, version mismatch, or untrusted host bindings
fail closed.

## Dependencies

`@openslack/plugin-api`, `@openslack/plugin-host`, and
`@openslack/plugin-testkit`.

## Configuration

Hosts explicitly select and bind plugins; discovery does not imply activation.

## Acceptance Criteria

- Manifests are schema-valid and deterministic.
- Tests cover invalid capabilities and trust transitions.
- Embedding never bypasses host or project governance.
