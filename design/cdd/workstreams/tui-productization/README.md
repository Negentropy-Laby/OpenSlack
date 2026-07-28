---
schema: openslack.document.v1
id: cdd-workstream-tui-productization
status: In Review
authority: canonical
audience:
  - contributors
owner: product
updated: 2026-07-28
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# TUI: Optional Terminal UI Views

## Product Definition

`@openslack/tui` provides interactive terminal views as a **progressive
enhancement** over the existing CLI output. It does not replace any CLI command,
introduce new business logic, or create a new product module.

## Positioning

| Layer                  | Role                                         | Source of truth                     |
| ---------------------- | -------------------------------------------- | ----------------------------------- |
| CLI (`apps/cli`)       | Command surface, format routing              | `--format tui` triggers lazy import |
| TUI (`@openslack/tui`) | Renders interactive views, produces no state | Receives data through view models   |
| Packages               | Business logic, projections, governance      | Unchanged                           |

TUI is activated only when a user passes `--format tui`. All existing output
formats (`standard`, `plain`, `json`, `chat`) remain unchanged and are the
default.

## Core Constraints

1. **CLI-first** — default output remains `standard`. TUI is opt-in.
2. **Data receiver, not fetcher** — no GitHub API calls, no workspace writes, no
   state mutations from within TUI.
3. **Lazy import** — CLI dynamically imports `@openslack/tui` only when
   `--format tui` is requested. Non-TUI commands pay zero cost.
4. **Render-and-exit or bounded interactive** — views display then exit on
   `q`/`Esc`. No REPL, no persistent sessions.
5. **All actions route through existing gates** — TUI can suggest commands but
   never bypasses Operator / PRMS / governance.
6. **Terminal escape sanitization** — all external text is stripped of
   ANSI/OSC/CSI before rendering.
7. **Stable view models** — TUI consumes typed view models, not raw internal
   objects.

## Commands Affected

| Command                                                | TUI view      | PR  |
| ------------------------------------------------------ | ------------- | --- |
| `openslack collaboration dashboard --format tui`       | DashboardView | #96 |
| `openslack collaboration room show <ref> --format tui` | RoomView      | #97 |
| `openslack pr doctor <n> --format tui`                 | DoctorView    | #98 |
| `openslack setup interactive --format tui`             | SetupView     | #99 |

## Module Registration

`@openslack/tui` is registered under existing modules (operator, collaboration),
not as a new Module 06. It is a presentation-layer package, not a product module.

## v1 Scope

- Render-and-exit views; `q`/`Esc` to exit
- Scrolling and item selection are future enhancements
- No mouse interaction, no alternate screen mode, no OSC clipboard, no live
  refresh

## Out of Scope

- Browser-based UI
- REPL or chat interface
- Live data polling
- Mouse or touch interaction
- Alternate screen buffers
- Clipboard access

## Overview

TUI Productization provides the conversation, workflow, task, PR, graph, and
diagnostic workbench in a terminal-safe interface.

## User Promise

Keyboard users can inspect and act on the same governed state available in the
CLI without hidden side effects or color-only status.

## Data Model

Typed view models, focus state, key bindings, selected entity, preview,
confirmation, diagnostics, and textual status.

## Edge Cases

Small terminals, unsupported input, non-interactive sessions, stale
projections, and sensitive terminal content degrade safely.

## Dependencies

`@openslack/tui` and typed projections from product packages.

## Configuration

The TUI does not require alternate screen, mouse, clipboard, or live polling.

## Acceptance Criteria

- Core flows are keyboard accessible.
- Status is available in text, not color alone.
- Side effects pass the same typed gates as CLI actions.
