# Third-Party Notices — OpenSlack

This document records repository third-party code and provenance. Each
attribution must be reviewed before the affected bytes are released;
repository-only source inclusion is not a release claim, and release
packaging must still describe only the bytes that it ships.

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

## 4. OpenSlack Design System Components

**Source:** `packages/tui/src/design-system/` in this repository, introduced
by OpenSlack commit `082be66f5fb604b7ad4c16828ea3f1ac5fd30590`.

**Use:** ThemeProvider, ThemedBox, ThemedText, ProgressBar, StatusIcon,
KeyboardShortcutHint, ListItem, Divider, and Pane.

**Status:** The current components are OpenSlack-native implementations. They
are not copies of Aby's excluded `src/components/design-system/` files. This
statement does not relicense, import, or make any claim about that excluded
Aby-authored code.

## 5. Notification Delivery Service

**Current source:** `services/notification-delivery/` in this repository.

**Historical source:** [wsman/rc_wsman](https://github.com/wsman/rc_wsman),
frozen at commit `982db466b2ba2c20bec150b7688bd398e4f52714`
and tree `7ac5144aeab9d453f39e2b6d2fbea828e7a89017`, then imported with
history preserved by PR #301.

**License and production dependency notices:** The service retains its
byte-preserved Apache-2.0 `LICENSE` and `NOTICE`. Its exact production Go
module attribution and complete upstream license texts are recorded in
`services/notification-delivery/THIRD_PARTY_NOTICES.md`; its deterministic
repository source/build-input inventory is recorded in
`services/notification-delivery/SBOM.cdx.json`.

**Release status:** Repository membership is not a release claim. The service
is not included in the current OpenSlack CLI archive or CLI CycloneDX SBOM.

## TUI License Gate

For the TUI port governed by `docs/developer/tui-porting-notes.md`, no ported
code PR (PR 1+) merges until the license status of all ported code is
confirmed. This document serves as the tracking file for that confirmation.

**Status:** CONFIRMED (2026-05-27) for the Ink engine, yoga-layout TS port,
and pretext-derived code. The current design-system components are
OpenSlack-native and do not consume the excluded Aby design-system source.
