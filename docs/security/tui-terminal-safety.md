---
schema: openslack.security_doc.v1
created: 2026-05-27
status: draft
---

# TUI Terminal Safety: Escape Sequence Sanitization

## Threat Model

When the TUI renders text from external sources (GitHub issue titles, PR titles,
agent names, handoff context, decision text, event summaries), untrusted content
may contain terminal escape sequences that could:

1. **Clipboard injection** — OSC 52 sequences (`\x1b]52;...`) can write
   arbitrary content to the system clipboard without user interaction.
2. **Screen manipulation** — CSI sequences like `\x1b[2J` (clear screen),
   `\x1b[H` (cursor home), or `\x1b[r` (set scroll region) can disrupt the
   terminal display.
3. **Title/icon manipulation** — OSC 0/1/2 sequences can change the terminal
   window title.
4. **Control character injection** — C0 controls (bell, backspace, form feed)
   can produce unexpected terminal behavior.

## Sanitization Policy

All external text must pass through `sanitizeTerminalText()` before reaching any
TUI Text component. The sanitization function:

1. Strips all ANSI CSI sequences (`\x1b[...` followed by a final byte in
   `0x40-0x7E`).
2. Strips all OSC sequences (`\x1b]...` terminated by `\x07` or `\x1b\\`).
3. Strips C0 control characters except `\n` (newline) and `\t` (tab).
4. Preserves printable characters, whitespace, and Unicode.

The only styled text in the TUI is generated internally by the design system
(ThemeProvider, StatusIcon, etc.). External text is always rendered as plain
text.

## Implementation

The sanitization function lives in `packages/tui/src/sanitize.ts` and is applied
at the view-model boundary:

```typescript
export function sanitizeTerminalText(input: string): string {
  return (
    input
      // CSI sequences: ECMA-48 form covers private/intermediate bytes
      // \x1b [ <0-?>* <space-/>* <@-~>
      // Matches: \x1b[2J, \x1b[?1049h, \x1b[?25l, \x1b[31m, \x1b[>c, etc.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // OSC sequences: \x1b] ... terminated by BEL(\x07) or ST(\x1b\\)
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      // C0 controls except \n(\x0a) and \t(\x09)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  );
}
```

All view-model mappers apply `sanitizeTerminalText()` to every string field
derived from external sources before returning the view model.

## Required Tests

| Test case                       | Input                                 | Expected         |
| ------------------------------- | ------------------------------------- | ---------------- |
| Clipboard OSC injection         | `"hello\x1b]52;c;$(whoami)\x07world"` | `"helloworld"`   |
| Screen clear                    | `"title\x1b[2Jtext"`                  | `"titletext"`    |
| Cursor home                     | `"foo\x1b[Hbar"`                      | `"foobar"`       |
| ANSI color injection            | `"\x1b[31mred\x1b[0m"`                | `"red"`          |
| Window title                    | `"\x1b]0;evil\x07text"`               | `"text"`         |
| C0 bell                         | `"alert\x07text"`                     | `"alerttext"`    |
| Alternate screen enter          | `"\x1b[?1049h"`                       | `""`             |
| Cursor hide                     | `"\x1b[?25l"`                         | `""`             |
| Device attributes (private CSI) | `"\x1b[>c"`                           | `""`             |
| CSI with intermediate           | `"\x1b[ ?2004h"`                      | `""`             |
| Preserves newlines              | `"line1\nline2"`                      | `"line1\nline2"` |
| Preserves tabs                  | `"col1\tcol2"`                        | `"col1\tcol2"`   |
| Preserves Unicode               | `"日本語テスト"`                      | `"日本語テスト"` |
| Empty string                    | `""`                                  | `""`             |

## Scope of Application

Sanitization applies to all string fields in view models that originate from:

- GitHub API responses (issue titles, PR titles, body text, labels, user names)
- Collaboration events (event summaries, actor names, context text)
- Handoff context text
- Decision topics and rationale
- Room metadata (blockers, next actions)
- Agent registry entries (display names, descriptions)
- Dashboard section items

It does NOT apply to:

- TUI-generated labels and headers
- Theme color/style sequences (generated internally)
- Keyboard shortcut hints (generated internally)

## Enforcement

The sanitization is enforced at the view-model mapper layer, not at the
component level. This ensures that:

1. No TUI component can accidentally render unsanitized text.
2. The sanitization boundary is testable independently of rendering.
3. Future non-TUI consumers of view models receive pre-sanitized data.

## Related Documents

- `docs/developer/tui-porting-notes.md` — what is ported, coupling resolution
- `docs/product/tui.md` — product definition and constraints
