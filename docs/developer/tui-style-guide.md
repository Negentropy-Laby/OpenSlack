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

## Column Width Matrix

Every TUI view must be tested at 80, 100, and 120 columns using shared
render helpers. These three widths cover the minimum practical terminal, the
common default, and a generous wide layout.

- Shared helpers must accept a `columns` parameter (default 100) and pass it
  to the Ink test renderer.
- Test suites for each view should include a `describe.each([80, 100, 120])`
  (or equivalent loop) that renders the view and asserts:
  - no line exceeds the column width,
  - no content is silently clipped without an ellipsis or truncation indicator,
  - bordered panes and progress bars remain structurally intact.
- Views that use a two-column layout must verify that the split point does not
  cause text overflow at 80 columns.
- If a view degrades to a single-column stack at narrow widths, the test must
  assert the stacked layout explicitly.

## CJK, Emoji, and ANSI Coverage

Test inputs must exercise the full range of content that reaches TUI views:

- **CJK text**: Chinese (`你好世界`), Japanese (`こんにちは`), Korean (`안녕하세요`),
  and mixed CJK/Latin strings. CJK characters occupy 2 terminal cells each.
- **Emoji**: single codepoint emoji (`✅`, `⚠️`), multi-codepoint sequences
  (`👨‍💻`), flag sequences (`🇯🇵`), and skin-tone modifiers.
- **ANSI escapes**: colored text (`\x1b[31mred\x1b[0m`), hyperlinks
  (`\x1b]8;;url\x1b\\text\x1b]8;;\x1b\\`), cursor moves, and OSC sequences.
- **Long URLs**: unbroken strings of 200+ characters that must wrap or truncate.
- **Mixed content**: lines that combine ASCII labels, CJK values, emoji status
  glyphs, and ANSI-colored segments in a single row.

Each view's test suite should include at least one test case per category
above, asserting that layout remains stable and that `stringWidth()` reports
the correct cell count.

## Async Redraw Regression

Loading states and async data fetches are a common source of visual glitches:

- **Loading state must fit terminal**: the loading frame (spinner, skeleton,
  placeholder) must not exceed the terminal column width. Test by rendering the
  loading state at 80 columns and asserting no overflow.
- **No ghost rows after redraw**: when the loaded frame has fewer visual rows
  than the loading frame, the renderer must clear stale rows. Test by rendering
  the loading state, then the loaded state, and asserting that the final output
  has no trailing blank lines or leftover skeleton fragments.
- **Frame-size transitions**: test that transitioning from a long list (many
  items) to a short list (few items) does not leave orphaned rows from the
  previous frame.
- Every view with an async loading path must include a dedicated redraw
  regression test.

## Plain-Safe Fallback

When `isTuiSupported()` returns `false`, the CLI must produce usable plain-text
output instead of a broken interactive view:

- **Trigger conditions**: non-TTY stdout, CI environment (`CI=true`),
  explicitly disabled TUI (`OPENSLACK_NO_TUI=1`), terminal too small (fewer
  than 40 columns or 10 rows), or missing terminal capabilities.
- **Fallback behavior**: the command must print a human-readable plain-text
  summary to stdout and exit cleanly with code 0. No Ink rendering, no mouse
  tracking, no alternate screen buffer.
- **Test requirement**: each TUI view must have a corresponding plain-text
  fallback test that runs with `isTuiSupported()` mocked to `false` and asserts
  that stdout contains the expected text summary with no ANSI escape sequences
  (other than optional basic color if the output stream is a TTY).
- **Feature parity**: the plain-text fallback must convey the same critical
  information as the TUI view. It may omit interactive elements (navigation,
  keyboard shortcuts, selection) but must not silently drop status, error, or
  result data.

## Common Failure Modes

| Symptom                             | Cause                                 | Fix                                           |
| ----------------------------------- | ------------------------------------- | --------------------------------------------- |
| Columns drift with Chinese text     | `padEnd()` counted code units         | Use `stringWidth()` and bounded layout        |
| Emoji overlaps following text       | slicing split a wide grapheme         | Use `slice-ansi.ts` and assert width          |
| Old rows remain after async refresh | shorter frame did not clear tail rows | Add redraw regression test                    |
| CI snapshot differs from terminal   | ANSI/control output leaked            | Sanitize external text and render through Ink |
| Monochrome view loses meaning       | status was color-only                 | Add explicit text labels                      |
| View overflows at 80 columns        | layout assumes 100+ columns           | Add Column Width Matrix test                  |
| Plain output is empty               | TUI-only path with no fallback        | Add plain-safe fallback path                  |
