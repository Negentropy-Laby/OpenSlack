---
schema: openslack.document.v1
id: architecture-pr-review-merge
status: In Review
authority: canonical
audience:
  - contributors
  - reviewers
owner: pr-review-merge
updated: 2026-07-28
sources:
  - design/cdd/modules/pr-review-merge.md
  - docs/security/human-approval.md
---

# PR Review and Merge Architecture

`@openslack/pr` fetches and evaluates current-head PR evidence. Policy comes
from `@openslack/kernel`; GitHub data comes from `@openslack/github`. Analysis,
approval, thread resolution, mergeability, and merge execution are independent
gates. Only an authorized human can originate approval.
