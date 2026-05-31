---
schema: openslack.developer_doc.v1
created: 2026-05-31
status: active
---

# TUI Style Guide

OpenSlack TUI views run in real terminals with mixed ASCII, CJK, emoji, ANSI,
and asynchronous redraws. Layout code must treat terminal cell width as the
source of truth, not JavaScript string length.

## Width And Text

- Use `packages/tui/src/ink/stringWidth.ts` for terminal cell width.
- Use `wrap-text.ts`, `wrapAnsi.ts`, and `slice-ansi.ts` for wrap, truncate,
  and visual-column slicing.
- Do not use `padEnd()` or `padStart()` for visual alignment in TUI components.
  They count UTF-16 code units, not terminal cells.
- Prefer fixed Box width, wrap, truncate, or column components over hand-built
  spacing.
- Treat ambiguous symbols such as `⚠`, status glyphs such as `✓`, emoji, and
  CJK text as normal test inputs.

## Component Layout

- Every list, pane, and board must define a bounded width strategy: fixed
  width, flex width, truncate, wrap, or ellipsis.
- Avoid deeply nested `Box` trees that do not constrain width or shrink behavior.
- Do not print from React components with `console.log`, `console.warn`, or
  `console.error`. Render all UI through Ink `<Text>` and design-system
  components.
- External strings must be sanitized at the view-model boundary with
  `sanitizeTerminalText()` before reaching a view.
- Design-system glyphs and colors must be generated internally; external data
  is rendered as plain text.

## Async Redraw

- Async data loading must update React state and let the root renderer redraw.
- Do not mix async loaders with direct terminal writes.
- Loading states must be shorter-safe: when the next frame has fewer rows, old
  rows must be cleared by the renderer.
- CLI commands may fetch GitHub/workflow data, but `@openslack/tui` should
  receive prepared view models or injected loaders.

## Terminal Compatibility

- `isTuiSupported()` is the entry gate for interactive mode.
- If the terminal is too small, non-interactive, CI, or explicitly disabled,
  use standard text output instead.
- TUI tests should exercise 80, 100, and 120 column widths.
- Low-color or monochrome environments must still communicate state through
  text labels, not color alone.

## Required Tests For New TUI Views

Each new view or layout primitive should include:

- Render tests at 80, 100, and 120 columns.
- Mixed ASCII, Unicode, emoji, and CJK inputs.
- Wrap/truncate/ellipsis assertions where text can exceed the container.
- Async redraw coverage when a view has a loading state.
- Sanitization tests for external strings with ANSI/OSC/control characters.
- No direct console output from tests unless explicitly debug-gated.

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Columns drift with Chinese text | `padEnd()` counted code units | Use `stringWidth()` and bounded layout |
| Emoji overlaps following text | slicing split a wide grapheme | Use `slice-ansi.ts` and assert width |
| Old rows remain after async refresh | shorter frame did not clear tail rows | Add redraw regression test |
| CI snapshot differs from terminal | ANSI/control output leaked | Sanitize external text and render through Ink |
| Monochrome view loses meaning | status was color-only | Add explicit text labels |

