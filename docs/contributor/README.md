---
schema: openslack.document.v1
id: contributor-index
status: In Review
authority: index
audience:
  - contributors
owner: project-governance
updated: 2026-11-10
sources:
  - AGENTS.md
  - design/cdd/module-index.md
---

# Contributor Documentation

Start with `AGENTS.md`, the root `memory_bank/README.md`, and the CDD module
index. Use this section for implementation and onboarding guidance, then follow
the architecture control manifest and path-scoped repository policy.

- [New agent onboarding](new-agent-onboarding.md)
- [GitHub Issues task loop](github-issues-loop.md)
- [Scenario Pack development](scenario-pack.md)
- [Notification Delivery development](notification-delivery/README.md)
- [Plugin development](plugins/authoring.md)
- [Technical debt](technical-debt.md)

## Dependency installation

Follow the root [supported dependency installation](../../README.md#supported-dependency-installation)
instructions. Development and CI use `node scripts/ci/install-dependencies.mjs`
with Bun 1.4.0; `--check` is the Node-only, read-only preflight that runs before
dependency downloads. Official npm access is required, with no mirror fallback.
Do not replace the supported path with a bare installation command or pass
publishing credentials to its child process.

## Local process and storage tests

Run the repository tests under Node after `bun run typecheck`. Process fixtures
use `scripts/testing/process-fixture.mjs` to normalize Windows `Path`/`PATH` and
`PATHEXT`, verify Node/Bun executables, and select Git Bash on native Windows.
Linux and macOS use native Bash. Bash discovery runs only inside Bash-dependent
tests, so a missing shell does not prevent catalog or PowerShell test collection.
Missing tools fail their dependent tests with an actionable diagnostic;
install the named prerequisite before rerunning. Shell paths are converted by the
selected shell, including when Windows tests are launched from WSL. Git Bash
symlink tests require native symlink creation permission and verify that a link was
actually created before testing installer rejection.

The disk-backed checkpoint ordering and v2 effect authorization cases have an
explicit 120-second Windows test budget. Other platforms retain their original
business budgets. The concurrent effect fixture has a separate 30-second POSIX
setup budget (120 seconds on Windows); its barrier starts after preparation.
This accommodates real ACL checks, durable writes, and lock operations;
it does not change production deadlines or bypass those checks. Concurrency tests
use execution barriers with bounded diagnostic waits, while deadline and authority
expiry tests retain independent cancellation signals and controlled clocks.
