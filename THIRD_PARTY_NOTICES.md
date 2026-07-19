# Third-Party Notices — @openslack/tui

This document lists third-party code used in `packages/tui/` and its
provenance. Each entry must be confirmed before the corresponding code
can be merged.

## 1. Ink Terminal UI Engine

**Source:** [vadimdemedes/ink](https://github.com/vadimdemedes/ink)
(v4.x, MIT License)

**Use:** Core rendering engine (reconciler, screen, output, dom, layout,
terminal I/O, components, hooks). Ported via Aby's forked and heavily
modified copy at `src/ink/`.

**Upstream license:**

```
MIT License

Copyright (c) Vadim Demedes <vadimdemedes@protonmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Aby fork status:** Aby (`@open-code/aby-assistant`) is a private package
marked `"license": "UNLICENSED"`. The ink engine files in Aby's `src/ink/`
are derived from the MIT-licensed Ink project with substantial modifications.
**Confirmed (2026-05-27):** Aby author has granted permission to use the
forked Ink engine code in OpenSlack under the original MIT license terms.

## 2. yoga-layout Pure TypeScript Implementation

**Source:** `src/native-ts/yoga-layout/` in Aby's repository

**Use:** Pure TypeScript reimplementation of Meta's yoga-layout flexbox
engine. Used by Ink for layout computation. No native binaries or WASM.

**Upstream reference:** Meta's yoga-layout is MIT-licensed. The TypeScript
port in Aby is a clean-room reimplementation (not a derivative of the C++
source).

**Confirmed (2026-05-27):** The pure TypeScript yoga-layout port follows
upstream MIT license terms. Permission to use in OpenSlack granted by
Aby author.

## 3. pretext Terminal Text Layout

**Source:** [nicolo-ribaudo/pretext](https://github.com/nicolo-ribaudo/pretext)
(MIT License)

**Use:** Portions of `terminal-text-layout.ts` are derived from pretext for
grapheme-aware terminal text wrapping.

**Attribution in source:**

```
Portions derived from pretext (https://github.com/nicolo-ribaudo/pretext)
are used under the MIT License.
```

**Confirmed (2026-05-27):** Attribution is correct and compatible. MIT
license terms satisfied.

## 4. Aby Design System Components

**Source:** `src/components/design-system/` in Aby's repository

**Use:** ThemeProvider, ThemedBox, ThemedText, ProgressBar, StatusIcon,
Byline, KeyboardShortcutHint, ListItem, Divider, Pane. Planned for porting
in PR 2.

**Status:** Aby-authored code, `"license": "UNLICENSED"`.
**Not included in PR #93.** License gate deferred to PR 2 (design-system
port). Permission for design-system components will be confirmed separately
before PR 2 merges.

## License Gate

Per `docs/developer/tui-porting-notes.md`, no code PR (PR 1+) merges until
the license status of all ported code is confirmed. This document serves as
the tracking file for that confirmation.

**Status:** CONFIRMED (2026-05-27) for Ink engine, yoga-layout TS port, and pretext-derived code. Design-system components gated for PR 2.
