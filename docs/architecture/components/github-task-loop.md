---
schema: openslack.document.v1
id: architecture-github-task-loop
status: In Review
authority: canonical
audience:
  - contributors
owner: github-task-loop
updated: 2026-07-28
sources:
  - design/cdd/modules/github-task-loop.md
  - docs/contributor/github-issues-loop.md
---

# GitHub Task Loop Architecture

`@openslack/github` owns GitHub API interactions, `@openslack/core` owns claim
primitives, and `@openslack/runtime` owns worktree execution and synchronization.
Claims are Git refs with one-winner creation; projections cannot manufacture a
claim or completion.
