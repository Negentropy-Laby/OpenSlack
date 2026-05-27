---
schema: openslack.developer_doc.v1
created: 2026-05-27
status: draft
---

# TUI Porting Notes

This document records what is ported from the Aby project's forked Ink terminal
UI engine into OpenSlack's `@openslack/tui` package, what is excluded, how
coupling is resolved, and the license status.

## Source

The source project is Aby (`@open-code/aby-assistant`), a private package
marked `"license": "UNLICENSED"` in its `package.json`. The ink engine lives at
`src/ink/` and is a heavily customized fork of the MIT-licensed
[vadimdemedes/ink](https://github.com/vadimdemedes/ink) (Ink 4.x).

The yoga-layout implementation at `src/native-ts/yoga-layout/` is a pure
TypeScript reimplementation of Meta's yoga-layout flexbox engine. It is not a
native binary wrapper. The upstream yoga-layout is MIT-licensed.

## License Status

| Component | Upstream license | Aby status | OpenSlack status |
|-----------|-----------------|------------|------------------|
| Ink engine (`src/ink/`) | MIT (vadimdemedes/ink) | Forked, heavily modified | **Pending confirmation** |
| yoga-layout TS (`src/native-ts/yoga-layout/`) | MIT (Meta yoga-layout) | Pure TS port | **Pending confirmation** |
| Design system components (`src/components/design-system/`) | Aby-authored | `"UNLICENSED"` | **Pending confirmation** |
| pretext-derived code (`terminal-text-layout.ts`) | MIT (nicolo-ribaudo/pretext) | Used with attribution | **Pending confirmation** |

### Required Before Merge

Before any code PR merges, the following must be confirmed:

1. Whether Aby's ink engine fork can be used in OpenSlack (requires Aby author
   permission or a compatible license grant).
2. Whether the yoga-layout TS port has its own license terms or follows upstream
   MIT.
3. Whether design-system components can be extracted and relicensed.
4. All copied files must retain original license headers where they exist.
5. `THIRD_PARTY_NOTICES.md` at repository root must document all third-party
   code provenance and license status.

License tracking file: `THIRD_PARTY_NOTICES.md` (repository root).

This is a **merge gate**: no code PR (PR 1+) merges until license is resolved.

## What Gets Ported

### Ink Engine Core (~20 files from `src/ink/`)

- `ink.tsx` — Core rendering engine
- `reconciler.ts` — React reconciler setup
- `screen.ts` — Virtual screen buffer
- `render-node-to-output.ts` — React elements to terminal output
- `renderer.ts` — Rendering coordinator
- `dom.ts` — Virtual DOM helpers
- `focus.ts` — Focus management
- `output.ts` — Terminal output abstraction
- `terminal.ts` — Terminal control
- `log-update.ts` — Log update batching
- `styles.ts` — Style processing
- `colorize.ts` — Color application
- `instances.ts` — Instance tracking
- `root.ts` — Root creation
- `frame.ts` — Frame management
- `constants.ts` — Engine constants
- `cursor.ts` — Cursor control
- `clearTerminal.ts` — Terminal clearing
- `squash-text-nodes.ts` — Text node optimization
- `stringWidth.ts` — String width measurement
- `widest-line.ts` — Line width calculation
- `wrap-text.ts` — Text wrapping
- `wrapAnsi.ts` — ANSI-aware wrapping
- `bidi.ts` — Bidirectional text
- `measure-element.ts`, `measure-text.ts` — Measurement
- `node-cache.ts` — Node caching
- `optimizer.ts` — Render optimization
- `render-border.ts` — Border rendering
- `parse-keypress.ts` — Keypress parsing
- `line-width-cache.ts` — Line width caching
- `searchHighlight.ts` — Search highlighting
- `terminal-text-layout.ts` — Terminal text layout
- `terminal-control-sequences.ts` — Terminal control sequences

### Ink Components (from `src/ink/components/`)

- `Box`, `Text`, `App`, `Button`, `Newline`, `Spacer`, `StdinContext`

### Ink Hooks (from `src/ink/hooks/`)

- `use-app`, `use-input`, `use-stdin`, `use-interval`

### Ink Termio (from `src/ink/termio/`)

- `ansi`, `csi`, `dec`, `parser`, `sgr`, `tokenize`, `types`
- `osc.ts` — **inert/trimmed shim** (see below)

### OSC Handling: Inert Shim

`terminal.ts` and `ink.tsx` import OSC helpers from `src/ink/termio/osc.ts`.
Rather than excluding `osc.ts` entirely, a **trimmed shim** is ported that:

- Provides the exported function signatures so `terminal.ts` / `ink.tsx` compile.
- Disables all side-effecting OSC operations:
  - `setClipboard` — no-op (OSC 52 clipboard injection prevented)
  - Tab status / progress reporting — no-op
  - OSC 8 hyperlink generation — no-op
- Retains only read-only OSC parsing needed for terminal capability queries.

Tests must prove the shim never outputs OSC sequences to stdout/stderr.

### Ink Layout (from `src/ink/layout/`)

- `yoga.ts`, `geometry.ts`, `node.ts`

### Ink Events (from `src/ink/events/`)

- `dispatcher`, `event-handlers`, `keyboard-event`, `input-event`

### Yoga Layout (from `src/native-ts/yoga-layout/`)

- `index.ts` — Pure TypeScript flexbox engine (~2579 lines)
- `enums.ts` — Layout enums

### Design System (from `src/components/design-system/`)

Tier 1 (ported directly):
- `ThemeProvider`, `ThemedBox`, `ThemedText`, `ProgressBar`, `StatusIcon`,
  `Byline`, `KeyboardShortcutHint`

Tier 2 (adapted):
- `ListItem`, `Divider`, `Pane` (modal context dependency removed)

### Utilities (kept subset)

- `env.ts` — Platform detection
- `env-utils.ts` — Environment utilities (`isEnvTruthy`)
- `intl.ts` — Standard Intl API wrappers

## What Gets Excluded

| Component | Reason |
|-----------|--------|
| Aby REPL.tsx (953KB chat interface) | Not needed; OpenSlack has its own chat gateway |
| Aby Doctor.tsx | Not needed; OpenSlack has PRMS |
| Aby ResumeConversation.tsx | Not needed; no conversation sessions |
| Aby global state store (AppState, AppStateStore) | Not needed; TUI is render-and-exit |
| Aby conversation/session runtime | Not needed; no REPL |
| Aby telemetry/logging infrastructure | Not needed; replaced by no-ops |
| Aby clipboard/OSC extras | Disabled for security |
| ScrollBox | No scroll regions in v1 |
| AlternateScreen | No alternate screen mode in v1 |
| ErrorOverview | Not needed; errors handled by CLI |
| Link component (OSC 8) | No hyperlinks in v1 |
| Mouse selection (use-selection) | No mouse interaction in v1 |
| Terminal focus detection (use-terminal-focus) | Not needed for render-and-exit |
| Terminal viewport (use-terminal-viewport) | Not needed for bounded views |
| Tab status (use-tab-status) | Not needed; no tab navigation |
| Animation frames (use-animation-frame) | Not needed; no animations |
| `osc.ts` (termio) | Replaced with inert/trimmed shim; see OSC Handling section above |

## Coupling Resolution: Stubs

The Aby ink engine imports from several Aby-specific modules. Each is replaced
with a no-op or safe default. Every stub file includes a comment explaining why
the replacement is safe.

| Stub | Original Import | Replacement | Justification |
|------|----------------|-------------|---------------|
| `stubs/bootstrap-state.ts` | `src/bootstrap/state.js` (`flushInteractionTime`, `markScrollActivity`, `updateLastInteractionTime`) | No-op functions | Aby REPL performance hooks. OpenSlack TUI is render-and-exit or bounded interactive — no scroll tracking or interaction timing needed. |
| `stubs/debug.ts` | `src/utils/debug.js` (`logForDebugging`) | No-op function | Aby developer-only debug facility. Not wired in production OpenSlack. |
| `stubs/log.ts` | `src/utils/log.js` (`logError`) | No-op function | Aby telemetry error logger. OpenSlack uses its own error handling. |
| `stubs/early-input.ts` | `src/utils/early-input.js` (`stopCapturingEarlyInput`) | No-op function | Pre-REPL keystroke capture buffer. Not needed for render-and-exit views. |
| `stubs/fullscreen.ts` | `src/utils/fullscreen.js` (`isMouseClicksDisabled`) | Returns `false` | Terminal fullscreen mode check. Not used in v1 — no fullscreen mode. |
| `stubs/exec-file.ts` | `src/utils/exec-file.js` (`execFileNoThrow`) | Returns `{stdout:'',stderr:'',code:1}` | Clipboard subprocess execution. Disabled for security — TUI never spawns subprocesses. |

### Bun-specific Replacement

`ThemeProvider.tsx` uses `feature()` from `bun:bundle` for theme detection.
This is replaced with:

```typescript
const autoTheme = process.env.OPENSLACK_AUTO_THEME !== 'false';
```

### Stub Verification

After porting, no import in `@openslack/tui` should reach:
- Aby `src/bootstrap/`
- Aby `src/server/`
- `bun:bundle`
- Aby global state (AppState, AppStateStore)

This is verified by grep in CI.

## Import Path Migration

All Aby import paths using `src/...` aliases are rewritten to relative paths
within `packages/tui/src/`. Example:

```
Before: import { logForDebugging } from 'src/utils/debug.js'
After:  import { logForDebugging } from '../stubs/debug.js'
```

## Package Structure

```
packages/tui/
  package.json
  tsconfig.json
  src/
    index.ts                    — public exports
    render.ts                   — renderTui(), isTuiSupported()
    capabilities.ts             — terminal capability detection
    sanitize.ts                 — terminal escape sanitization

    ink/                        — ported Aby ink engine (internal)
      stubs/                    — no-op replacements
        bootstrap-state.ts
        debug.ts
        log.ts
        early-input.ts
        fullscreen.ts
        exec-file.ts
      (engine files with updated import paths)

    yoga-layout/                — pure TS flexbox engine (internal)
      index.ts
      enums.ts

    utils/                      — kept subset
      env.ts
      env-utils.ts
      intl.ts

    design-system/              — ported + adapted primitives
      ThemeProvider.tsx
      theme.ts
      ThemedBox.tsx
      ThemedText.tsx
      StatusIcon.tsx
      ProgressBar.tsx
      Divider.tsx
      ListItem.tsx
      Pane.tsx
      KeyboardShortcutHint.tsx

    view-models/                — stable view model types
      dashboard.ts
      room.ts
      pr-doctor.ts
      health.ts

    views/                      — OpenSlack-specific TUI views
      DashboardView.tsx
      RoomView.tsx
      PRDoctorView.tsx
      HealthPanel.tsx
      SetupWizardView.tsx

    __tests__/
```

## Package Boundary Rules

- `@openslack/tui` may import **types only** from `@openslack/collaboration`,
  `@openslack/runtime`, `@openslack/chat-gateway`, `@openslack/pr` — consumed
  via view model mappers.
- `@openslack/tui` does NOT depend on `@openslack/kernel`, `@openslack/github`,
  `@openslack/operator`.
- `@openslack/tui` does NOT read from `.openslack` or `.openslack.local`.
- `@openslack/tui` does NOT call GitHub API, merge PRs, claim tasks, or write
  workspace state.
- `apps/cli` lazy-imports `@openslack/tui` only in `tui` format branch, with
  try/catch fallback.
- No other package imports from `@openslack/tui`.
- View model mappers live in `@openslack/tui` (not in data packages) — the
  mapping is a TUI concern.
