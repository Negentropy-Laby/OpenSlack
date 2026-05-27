---
schema: openslack.product_spec.v1
module: operator/collaboration
status: planned
created: 2026-05-27
---

# TUI: Optional Terminal UI Views

## Product Definition

`@openslack/tui` provides interactive terminal views as a **progressive
enhancement** over the existing CLI output. It does not replace any CLI command,
introduce new business logic, or create a new product module.

## Positioning

| Layer | Role | Source of truth |
|-------|------|-----------------|
| CLI (`apps/cli`) | Command surface, format routing | `--format tui` triggers lazy import |
| TUI (`@openslack/tui`) | Renders interactive views, produces no state | Receives data through view models |
| Packages | Business logic, projections, governance | Unchanged |

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

| Command | TUI view | PR |
|---------|----------|----|
| `openslack collaboration dashboard --format tui` | DashboardView | PR 4 |
| `openslack collaboration room show <ref> --format tui` | RoomView | PR 5 |
| `openslack pr doctor <n> --format tui` | PRDoctorView | PR 6 |
| `openslack doctor --format tui` | HealthPanel | PR 6 |
| `openslack setup interactive --format tui` | SetupWizardView | PR 7 |

## Module Registration

`@openslack/tui` is registered under existing modules (operator, collaboration),
not as a new Module 06. It is a presentation-layer package, not a product module.

## v1 Scope

- Render-and-exit or bounded interactive views
- Keyboard: `q`/`Esc` to exit, arrow keys to scroll within views
- No mouse interaction, no alternate screen mode, no OSC clipboard, no live
  refresh

## Out of Scope

- Browser-based UI
- REPL or chat interface
- Live data polling
- Mouse or touch interaction
- Alternate screen buffers
- Clipboard access
