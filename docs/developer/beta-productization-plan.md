---
schema: openslack.developer_doc.v1
created: 2026-05-31
status: active
title: Beta Productization Implementation Plan
source: workflow beta-productization (9 agents, 4-phase audit + design + synthesize)
---

# Beta Productization Implementation Plan

OpenSlack has reached **Developer Preview / Beta** quality. Core loops are complete,
governance and test foundations are solid, but user-facing entry points, TUI information
architecture, Profile Sync onboarding, and documentation consistency need productization
convergence before broader adoption.

**Scope:** 25 specs across 14 implementation batches, covering P0–P3 priorities.

**Principle:** Do not expand underlying capability. Compress existing complexity into
user-comprehensible paths.

---

## Canonical User Paths (Target State)

1. Open TUI → see what needs attention today
2. Create or pick up a GitHub Issue task
3. Start or check a Workflow
4. Review PR and merge through PRMS
5. Sync organization profile (Profile Sync Robot)
6. View collaboration memory and audit trail

---

## Batch Execution Order

Batches are ordered by: no cross-dependencies → highest user value → lowest risk.
A developer or agent can pick up any batch whose dependencies have landed.

### Batch Dependency Graph

```
B1 ──┐
B2 ──┤
B3 ──┼── B5          B10 ──┐
B4 ──┤                B11 ──┤
B6 ──┤                B12 ──┼── B13
B7 ──┤                      └── B14
B8 ──┼── B9
     └─ (no further deps)
```

---

## Batch Details

### B1 — Documentation: Profile Sync in user-guide and README

| Field           | Value                          |
| --------------- | ------------------------------ |
| Priority        | P0                             |
| Spec IDs        | P0-1, P0-2                     |
| Risk Zone       | **Green** — pure documentation |
| Human Approval  | No                             |
| Complexity      | Low                            |
| Dependencies    | None                           |
| Estimated Tests | 0                              |

**Description:** Add Profile Sync Robot command table and explanation to
`docs/user-guide.md` (between Collaboration Layer and Workflow Engine sections).
Add "Maintain organization profile" row to README quick-start table and Profile Sync
bullet to Module 05 description.

**Files:**

- `docs/user-guide.md` — insert "Profile Sync Robot" section with command table:
  `check`, `preview`, `run`, `status`, each with description, options, and examples
- `README.md` — add quick-start path for profile maintenance, add Profile Sync to
  Module 05 description

---

### B2 — Status count methodology clarification

| Field           | Value                       |
| --------------- | --------------------------- |
| Priority        | P0                          |
| Spec IDs        | P0-4                        |
| Risk Zone       | **Green** — CLI output text |
| Human Approval  | No                          |
| Complexity      | Low                         |
| Dependencies    | None                        |
| Estimated Tests | 2                           |

**Description:** Add a disambiguation note after the Test Suite section in the generated
status output explaining the difference between the raw Vitest deduplicated count and the
per-module sum from `modules.yaml`.

**Files:**

- `apps/cli/src/commands/status.ts` — add methodology note to generated output

---

### B3 — TUI Home view model: task-oriented goal items

| Field           | Value                       |
| --------------- | --------------------------- |
| Priority        | P0                          |
| Spec IDs        | P0-3                        |
| Risk Zone       | **Yellow** — TUI view model |
| Human Approval  | No                          |
| Complexity      | Medium                      |
| Dependencies    | None                        |
| Estimated Tests | 5                           |

**Description:** Replace the five `goalItems` with four task-oriented items:

- Start Work (task create/claim)
- Review Work (PR queue + doctor)
- Govern Actions (approvals + governance)
- Maintain Profile (profile sync workbench)

Remove Profile from `navItems` (now covered by goal item). Update footer shortcut
hint from `1-9, w/p/r/a` to `1-9, w/r/a`. Update coordinate diagnostic test expectations.

**Must land before B5** (B5 extends this foundation).

**Files:**

- `packages/tui/src/view-models/home.ts` — replace `goalItems` array, remove Profile from `navItems`
- `packages/tui/src/views/HomeView.tsx` — update footer shortcut text
- `packages/tui/src/__tests__/homeview-coordinate-diagnostic.test.tsx` — update expected labels

---

### B4 — TUI Doctor view: compressed mode + Profile Sync gate

| Field           | Value                               |
| --------------- | ----------------------------------- |
| Priority        | P1 + P2                             |
| Spec IDs        | P1-2, P2-5                          |
| Risk Zone       | **Yellow** — TUI views + CLI wiring |
| Human Approval  | No                                  |
| Complexity      | Medium                              |
| Dependencies    | None                                |
| Estimated Tests | 10                                  |

**Description:** Two related Doctor view improvements batched because they touch the same files:

1. **Compressed view mode:** Toggle with `c` key. Shows 4-line summary:
   - Can merge? (yes/no + reason)
   - Blocker (gate name + owner)
   - Why (one-line explanation)
   - Next action (CLI command to run)
     Full view remains default.

2. **Profile Sync Gate pane:** Conditional Pane rendered when `profileSyncGate` is defined
   and the PR touches profile sync paths. Extends `DoctorViewModel` with optional
   `profileSyncGate` field.

**Files:**

- `packages/tui/src/view-models/doctor.ts` — add `compressed` toggle, `profileSyncGate` field
- `packages/tui/src/views/DoctorView.tsx` — add compressed mode rendering, Profile Sync Gate pane
- `packages/tui/src/__tests__/DoctorView.test.tsx` — compressed mode and gate tests
- `packages/tui/src/__tests__/doctor-viewmodel.test.ts` — new fields in view model tests
- `apps/cli/src/commands/tui.ts` — forward `profileSyncGate` from doctor result

---

### B5 — TUI Home full task-oriented redesign

| Field           | Value                              |
| --------------- | ---------------------------------- |
| Priority        | P1                                 |
| Spec IDs        | P1-1                               |
| Risk Zone       | **Yellow** — TUI view + view model |
| Human Approval  | No                                 |
| Complexity      | Medium                             |
| Dependencies    | **B3**                             |
| Estimated Tests | 8                                  |

**Description:** Replace 4-section home layout with 2-section layout:

**Section 1: "What do you want to do?"** — 6 canonical tasks with shortcuts:

1. See what needs attention (`1`)
2. Start or continue work (`2`)
3. Run or check a workflow (`3`)
4. Review and merge PRs (`4`)
5. Approve pending items (`5`)
6. Maintain organization profile (`6`)

**Section 2: "Quick Navigation"** — shortcuts `7-9/0/p`

Add `TaskItem` interface with `attentionBadge` for dynamic count overlay on tasks.

**Files:**

- `packages/tui/src/view-models/home.ts` — `TaskItem` interface, new task/nav arrays
- `packages/tui/src/views/HomeView.tsx` — 2-section layout, `TaskItem` rendering
- `packages/tui/src/__tests__/homeview-coordinate-diagnostic.test.tsx` — updated expectations
- `packages/tui/src/__tests__/home-render-debug.test.tsx` — updated render assertions
- `packages/tui/src/__tests__/render-smoke.test.tsx` — smoke test for new layout

---

### B6 — Workflow Lifecycle Board: horizontal linear progress

| Field           | Value                              |
| --------------- | ---------------------------------- |
| Priority        | P1                                 |
| Spec IDs        | P1-3                               |
| Risk Zone       | **Yellow** — TUI view + view model |
| Human Approval  | No                                 |
| Complexity      | Medium                             |
| Dependencies    | None                               |
| Estimated Tests | 5                                  |

**Description:** Replace vertical stage list in `WorkflowLifecycleView` stages mode with
horizontal linear progress bar showing 5 canonical stages:

```
● proposal ─── ○ review ─── ○ run ─── ○ PR ─── ○ merged
```

Each stage node displays `StatusIcon` and label; current stage highlighted with accent.
Click/Enter on stage node enters existing detail mode. Does **not** modify detail or
action-result modes.

**Files:**

- `packages/tui/src/view-models/workflow-lifecycle.ts` — `CanonicalStageSlot` interface, `mapCanonicalStages` helper
- `packages/tui/src/views/WorkflowLifecycleView.tsx` — horizontal progress bar in stages mode
- `packages/tui/src/__tests__/WorkflowPreviewView.test.tsx` — lifecycle progress assertions

---

### B7 — Approval Center: profile-sync category + group reorder

| Field           | Value                              |
| --------------- | ---------------------------------- |
| Priority        | P1                                 |
| Spec IDs        | P1-4                               |
| Risk Zone       | **Yellow** — TUI view model + view |
| Human Approval  | No                                 |
| Complexity      | Low                                |
| Dependencies    | None                               |
| Estimated Tests | 4                                  |

**Description:** Add `profile-sync` as new `ApprovalCategory`. Reorder groups to
user-facing priority:

1. merge-request
2. workflow-effect
3. **profile-sync** (new)
4. plan
5. github-review

Add `profileSyncAction` field to `ApprovalItem`. Update all switch statements in
`ApprovalCenterView`.

**Files:**

- `packages/tui/src/view-models/approval-center.ts` — new category, new field
- `packages/tui/src/views/ApprovalCenterView.tsx` — new cases in switch statements
- `packages/tui/src/__tests__/render-smoke.test.tsx` — approval center smoke test

---

### B8 — Profile view: failure panel, sync details, mode display

| Field           | Value                                   |
| --------------- | --------------------------------------- |
| Priority        | P1 + P2                                 |
| Spec IDs        | P1-5, P2-2, P2-3                        |
| Risk Zone       | **Yellow** — TUI + CLI + GitHub package |
| Human Approval  | No                                      |
| Complexity      | Medium                                  |
| Dependencies    | None                                    |
| Estimated Tests | 8                                       |

**Description:** Three profile-related improvements batched because they all extend
`ProfileViewModel` and `ProfileView`:

1. **Failure panel:** When `syncStatus` is `failed`, render prominent panel with:
   red icon, reason summary, next-action CLI command, failure-issue shortcut hint.

2. **Sync Details pane:** New pane showing:
   - Source: latest commit hash + date
   - Target: current profile content hash
   - Pending PR: number + status
   - Last sync: timestamp + result
   - Mode: manual / watch / auto-pr

3. **Mode display in header:** Show `Mode: {mode}` with color coding.

**Files:**

- `packages/tui/src/view-models/profile.ts` — `syncDetails` field, `mode` field
- `packages/tui/src/views/ProfileView.tsx` — failure panel, sync details pane, mode header
- `packages/tui/src/__tests__/render-smoke.test.tsx` — profile view smoke
- `apps/cli/src/commands/tui.ts` — populate `syncDetails` from check result + config
- `packages/github/src/profile-sync-check.ts` — return `sourceCommit` and `sourceCommitDate`

---

### B9 — Profile Sync preview defaults to diff output

| Field           | Value                                  |
| --------------- | -------------------------------------- |
| Priority        | P2                                     |
| Spec IDs        | P2-1                                   |
| Risk Zone       | **Green** — CLI default + TUI additive |
| Human Approval  | No                                     |
| Complexity      | Medium                                 |
| Dependencies    | **B8**                                 |
| Estimated Tests | 5                                      |

**Description:** Change `profile-sync preview --format` default from `json` to `diff`.
Add Diff Output Pane in `ProfileView` that renders after successful preview action:

- Color-code diff lines (`+` green, `-` red, `@@` info)
- Truncate to 30 lines with trailer

Extend `ProfileViewModel` with `diffOutput` field. Update `tui-executors.ts` to return
diff text in `TuiActionResult`.

**Files:**

- `apps/cli/src/commands/collaboration.ts` — change default format to `diff`
- `apps/cli/src/commands/tui-executors.ts` — return diff text in action result
- `packages/tui/src/views/ProfileView.tsx` — diff output pane
- `packages/tui/src/view-models/profile.ts` — `diffOutput` field

---

### B10 — Profile Sync auto-pr smoke tests

| Field           | Value                       |
| --------------- | --------------------------- |
| Priority        | P2                          |
| Spec IDs        | P2-4                        |
| Risk Zone       | **Green** — pure test files |
| Human Approval  | No                          |
| Complexity      | High                        |
| Dependencies    | None                        |
| Estimated Tests | 10                          |

**Description:** Create two new smoke test files:

1. **CLI-level e2e** with mocked GitHub API:
   - `checkProfileSync` → detects change
   - `previewProfileSync` → shows diff
   - `runProfileSync` with `mode=auto-pr` → verifies PR creation
   - Verifies branch naming, metadata, cleanup

2. **Package-level test** for `runProfileSync` with mocked GitHub calls:
   - Auto-pr branch + PR creation
   - `on_existing_pr: skip`
   - `dryRun: true` no-branch

**Files:**

- `apps/cli/src/__tests__/profile-sync-smoke.test.ts` — new file
- `packages/github/src/__tests__/profile-sync-run-smoke.test.ts` — new file

---

### B11 — TUI style guide enforcement: ESLint rule + doc update

| Field           | Value                          |
| --------------- | ------------------------------ |
| Priority        | P3                             |
| Spec IDs        | P3-1a, P3-1b                   |
| Risk Zone       | **Green** — docs + lint config |
| Human Approval  | No                             |
| Complexity      | Low                            |
| Dependencies    | None                           |
| Estimated Tests | 3                              |

**Description:** Strengthen `tui-style-guide.md` with:

- Column width matrix requirement (80/100/120)
- CJK/emoji/ANSI link/long URL test requirements
- Async loading redraw test requirements
- Plain-safe fallback section

Add ESLint `no-restricted-properties` rule scoped to `packages/tui/src/**` that forbids
`padEnd`/`padStart` with a message pointing to `stringWidth`.

Add belt-and-suspenders source-scan test asserting no TUI source file contains
`padEnd(` or `padStart(`.

**Files:**

- `docs/developer/tui-style-guide.md` — add sections
- `eslint.config.js` — add no-restricted-properties rule
- `packages/tui/src/__tests__/tui-style-lint.test.ts` — new file

---

### B12 — Column snapshot matrix: test infrastructure

| Field           | Value                                |
| --------------- | ------------------------------------ |
| Priority        | P3                                   |
| Spec IDs        | P3-2a, P3-2b                         |
| Risk Zone       | **Green** — pure test infrastructure |
| Human Approval  | No                                   |
| Complexity      | Medium                               |
| Dependencies    | None                                 |
| Estimated Tests | 21                                   |

**Description:** Create shared test helpers and column snapshot matrix test.

**Helpers:**

- `renderAtColumns(component, widths[])` — render at multiple column widths
- `assertNoLineExceedsWidth(output, width)` — width assertion
- View-model factories for all 7 views (minimal valid view models)

**Matrix test:** Render all 7 key views at 80, 100, 120 columns using `describe.each`:

- HomeView, DoctorView, PrQueueView, ProfileView
- WorkflowLifecycleView, WorkflowWorkbenchView, DashboardView

Assert output contains expected markers and no line exceeds column width.

**Must land before B13 and B14** which depend on these helpers.

**Files:**

- `packages/tui/src/__tests__/helpers/render-at-columns.ts` — new file
- `packages/tui/src/__tests__/helpers/view-model-factories.ts` — new file
- `packages/tui/src/__tests__/column-snapshot-matrix.test.tsx` — new file

---

### B13 — CJK/emoji/ANSI/long URL coverage tests

| Field           | Value                       |
| --------------- | --------------------------- |
| Priority        | P3                          |
| Spec IDs        | P3-3a, P3-3b                |
| Risk Zone       | **Green** — pure test files |
| Human Approval  | No                          |
| Complexity      | Medium                      |
| Dependencies    | **B12**                     |
| Estimated Tests | 15                          |

**Description:** Coverage tests across all 7 views for:

- CJK labels and descriptions (Chinese, Japanese, Korean)
- Emoji in PR titles, workflow names, status text
- ANSI escape sanitization in external strings
- URLs longer than container width
- Mixed ASCII + CJK + emoji on same line

Plus view-model sanitization unit tests for `sanitizeTerminalText` with CJK/emoji
inputs and mapper sanitization.

**Files:**

- `packages/tui/src/__tests__/cjk-emoji-ansi-coverage.test.tsx` — new file
- `packages/tui/src/__tests__/sanitize-unicode.test.ts` — new file

---

### B14 — Plain-safe fallback renderer

| Field           | Value                          |
| --------------- | ------------------------------ |
| Priority        | P3                             |
| Spec IDs        | P3-4a, P3-4b, P3-4c            |
| Risk Zone       | **Green** — new rendering path |
| Human Approval  | No                             |
| Complexity      | High                           |
| Dependencies    | **B12**                        |
| Estimated Tests | 12                             |

**Description:** Create `plain-render.ts` implementing plain-text rendering as fallback
when `isTuiSupported()` returns false.

- ASCII-only output (no box-drawing characters)
- Word-wrap at 80 columns
- Text labels for state (instead of color)
- Covers all 7 views
- Update `render.ts` error message to mention plain fallback
- Wire into CLI `tui.ts` so `--format standard` uses plain renderer when TUI unsupported

**Files:**

- `packages/tui/src/plain-render.ts` — new file (main renderer)
- `packages/tui/src/index.ts` — export `renderPlain`
- `packages/tui/src/render.ts` — update error message
- `packages/tui/src/__tests__/plain-render.test.ts` — new file
- `apps/cli/src/commands/tui.ts` — wire plain fallback

---

## Summary Statistics

| Metric                       | Value                              |
| ---------------------------- | ---------------------------------- |
| Total specs                  | 25                                 |
| Total batches                | 14                                 |
| Green zone batches           | 7                                  |
| Yellow zone batches          | 7                                  |
| Red zone batches             | 0                                  |
| Estimated total new tests    | ~98                                |
| Batches with no dependencies | 10                                 |
| Batches with dependencies    | 4 (B5→B3, B9→B8, B13→B12, B14→B12) |
| Human approval required      | 0 (all green/yellow)               |

## Recommended Execution Wave

**Wave 1 (parallel, no deps):** B1, B2, B3, B4, B6, B7, B8, B10, B11, B12
**Wave 2 (after deps land):** B5 (after B3), B9 (after B8), B13 (after B12), B14 (after B12)

All Wave 1 batches can be worked on simultaneously by different agents or developers.
Wave 2 batches unlock as their single dependency lands.

## Validation After Each Batch

```bash
bun run typecheck
bun run test
bun run openslack status verify
```

For batches touching TUI views, additionally verify:

```bash
bun run openslack collaboration dashboard --format tui
```

---

## Follow-up — PR Doctor Live Evidence Hardening

**Purpose:** Fix the UX/governance gap where `bun run openslack pr doctor <n>`
silently falls back to dry-run when OpenSlack credentials are missing, producing
a misleading PRMS report. The command must fail closed unless the user explicitly
asks for dry-run.

### Key Changes

- Make `pr doctor` require live GitHub evidence by default.
  - No GitHub App env, `GITHUB_TOKEN`, or explicit auth mode means exit non-zero
    with `AUTH_REQUIRED`.
  - Do not generate `READY_TO_MERGE`, `BLOCKED_POLICY`, or other governance
    decisions from dry-run placeholder data.
  - Add an evidence banner to every output format: `GitHub evidence: LIVE |
DRY-RUN`, `Repo`, and `Auth`.

- Add explicit CLI options.
  - `--dry-run`: simulation only; decision must be `NOT_EVALUATED`.
  - `--repo owner/name`: override target repo.
  - `--auth auto|app|token|dry-run`: explicit credential mode.
  - `--auth app` may use the wrapper/PEM path; normal package code should still
    avoid implicit secret-file reads.

- Fix repository resolution.
  - Precedence: `--repo` → `GITHUB_OWNER/GITHUB_REPO` → `git remote origin` →
    configured workspace repo → fail.
  - Remove unsafe default behavior that resolves to `wsman/OpenSlack` for this
    checkout.

- Preserve mutation safety.
  - Read-only `pr doctor` may use live read credentials.
  - `--comment`, `pr merge`, and PR mutations still require bot/app auth, not a
    human PAT.
  - Wrapper commands remain supported:

    ```powershell
    powershell -ExecutionPolicy Bypass -File scripts\openslack-bot.ps1 pr doctor <PR_NUMBER>
    ```

- Update docs.
  - `docs/user-guide.md`: document `--dry-run`, `--repo`, `--auth`, and the
    `AUTH_REQUIRED` failure.
  - `docs/developer/github-automation.md`: clarify that direct
    `bun run openslack pr doctor` does not read `.openslack.local/github-app.pem`;
    wrapper or explicit app auth is required.
  - Do not hand-edit `docs/status/current.md`; regenerate only if command
    ownership or generated status changes.

### Test Plan

- CLI behavior:
  - No credential + no `--dry-run` exits non-zero with `AUTH_REQUIRED`.
  - No credential + `--dry-run` outputs `GitHub evidence: DRY-RUN` and
    `Decision: NOT_EVALUATED`.
  - `--repo Negentropy-Laby/OpenSlack` targets that repo.
  - Git remote origin is parsed when `--repo` and env vars are absent.
  - `--comment` rejects token/human auth and requires app/bot auth.

- Output formats:
  - `standard`, `plain`, and `tui` all show evidence mode and repo.
  - Dry-run output never shows merge-ready or blocked-policy decisions.

- Validation:

  ```powershell
  bun run typecheck
  bun run test
  bun run openslack status verify
  git diff --check
  ```

### Assumptions

- This is a follow-up plan, not part of the already-completed 14 Beta
  productization batches.
- Secret boundary stays intact: package code should not silently read or print
  PEM contents.
- Human approval and PRMS merge gates remain unchanged.
