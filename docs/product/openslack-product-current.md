---
schema: openslack.product_index.v1
status: index
updated: 2026-05-28
---

# OpenSlack Product Current

This file is a product documentation index. It is not a hand-maintained
current-state document.

## Canonical Sources

| Need | Source |
|------|--------|
| Current module status, commands, packages, and test counts | `docs/status/current.md` |
| Product module registry | `.openslack/modules.yaml` |
| User-facing overview and quick start | `README.md` |
| Complete CLI reference | `docs/user-guide.md` |
| UX/productization roadmap | `docs/product/user-experience-roadmap.md` |
| Technical debt register | `docs/developer/technical-debt.md` |

## User Journey Map

| User Journey | Primary Docs | Main Commands |
|--------------|--------------|---------------|
| First run and health checks | `README.md`, `docs/user-guide.md` | `openslack setup`, `openslack status`, `openslack doctor` |
| GitHub setup and repair | `docs/developer/github-automation.md`, `docs/user-guide.md` | `openslack setup github`, `openslack github repair ...` |
| Create and run tasks | `docs/developer/github-issues-loop.md`, `docs/user-guide.md` | `openslack task create`, `openslack agent tick`, `openslack task checkout`, `openslack task sync` |
| Monitor selected repos for new Issues | `docs/developer/github-watch-daemon.md`, `docs/product/user-experience-roadmap.md` | Phase 1/2/3/4 active: `openslack github watch ...` (auto-claim optional) |
| Review and merge PRs | `docs/product/module-04-pr-review-merge-steward.md`, `docs/user-guide.md` | `openslack pr doctor`, `openslack pr queue`, `openslack pr merge` |
| Run agent workflows | `docs/product/workflow-modules.md`, `docs/developer/workflow-runtime.md`, `docs/security/workflow-execution.md` | `openslack workflow preview`, `openslack workflow run`, `openslack workflow resume` |
| Coordinate humans and agents | `docs/product/collaboration-layer.md`, `docs/developer/collaboration-events.md` | `openslack collaboration dashboard`, `handoff`, `decision`, `room`, `workflow` |
| Onboard or authorize agents | `docs/developer/agent-registry-schema.md`, `docs/developer/new-agent-onboarding.md` | `openslack agent hire`, `openslack agent bootstrap` |
| Understand guardrails | `AGENTS.md`, `docs/security/self-evolution-guardrails.md`, `docs/security/collaboration-audit.md` | `openslack self classify-pr`, `openslack governance audit` |

## Module Design Docs

| Module | Design / Developer Docs |
|--------|--------------------------|
| Self-Evolution Kernel | `docs/product/phase-1.md`, `docs/developer/self-evolution-kernel.md` |
| GitHub Issues Task Loop | `docs/developer/github-issues-loop.md` |
| GitHub Watch Daemon (Phase 1/2/3/4 active) | `docs/developer/github-watch-daemon.md`, `docs/product/user-experience-roadmap.md` |
| Operator Interface | `docs/user-guide.md`, `docs/product/user-experience-roadmap.md` |
| PR Review & Merge Steward | `docs/product/module-04-pr-review-merge-steward.md` |
| Collaboration Layer | `docs/product/collaboration-layer.md`, `docs/developer/collaboration-events.md` |
| Workflow Engine | `docs/product/workflow-modules.md`, `docs/developer/workflow-runtime.md`, `docs/security/workflow-execution.md` |

## Product Reviews

| Date | Document | Purpose |
|------|----------|---------|
| 2026-05-28 | `docs/product/progress-review-2026-05-28.md` | Full progress and productization review after TUI integration and governance hardening |
| 2026-05-28 | `docs/product/workflow-format-analysis.md` | Analysis of Anthropic JS workflow format and OpenSlack integration path |
| 2026-05-28 | `docs/product/workflow-modules.md` | Complete workflow system product design — DSL, execution modes, permissions, integration |
| 2026-05-28 | `docs/developer/workflow-runtime.md` | Technical runtime design for `@openslack/workflows` package |
| 2026-05-28 | `docs/security/workflow-execution.md` | Workflow security model — trust levels, sandboxing, audit logging |

## Maintenance Rules

- Do not duplicate live module status, test counts, CLI ownership, branch
  protection status, or deferred feature status in this file.
- Update `.openslack/modules.yaml` when module ownership or test counts change,
  then run `openslack status generate` and `openslack status verify`.
- Keep `README.md` optimized for first-time users.
- Keep `docs/user-guide.md` as the complete command reference.
- Historical product narratives belong in `docs/archive/` or in dated product
  plans.
