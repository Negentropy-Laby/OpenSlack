# Human Approval

Human approval in OpenSlack means a real human with the required authority makes the approval decision. It does not require that the human personally browse GitHub or manually inspect every raw diff in the GitHub UI.

## Definition

A valid human approval has three parts:

1. **Human decision** — an authorized human explicitly says the PR is approved or not approved.
2. **Evidence basis** — the human may rely on PRMS, agent review summaries, CI results, changed-file lists, and risk classification instead of manually opening the PR page.
3. **GitHub enforcement record** — when GitHub branch protection or CODEOWNERS requires approval, the decision must be recorded as a GitHub review from the required human GitHub identity.

Chat, CLI, or agent conversation can carry the human decision, but those messages are not by themselves a GitHub CODEOWNER approval.

## PR Author Identity

OpenSlack PRs created by agents or delegated automation should be authored by the configured bot/agent GitHub identity. The human GitHub identity should be reserved for review and approval.

This rule is about authorship, not approval authority:

- bot/agent identity may author the PR, push commits, update the branch, comment, diagnose, and merge only after gates pass;
- bot/app/agent identity must not submit approval or be counted as human approval;
- the human reviewer must not be the PR author when their approval is required;
- if the only valid human CODEOWNER authored the PR, recreate the PR as bot/agent-authored or add a different independent human CODEOWNER.

This prevents author/CODEOWNER deadlocks without weakening no-auto-approval, CODEOWNERS, branch protection, PRMS, or rulesets.

## Allowed Agent Role

An agent may:

- analyze a PR and summarize the changed files, risk zone, CI status, blockers, and recommendation;
- ask the human for an explicit approve or reject decision;
- prepare review text that records the human's decision and the evidence used;
- mechanically relay an explicit human decision only when using a human-authorized GitHub identity and preserving attribution.

An agent must not:

- decide approval on behalf of a human;
- submit approval under a bot, app, or agent identity;
- infer approval from silence, vague assent, or prior context;
- approve its own PR or a PR authored by the same human identity;
- bypass CODEOWNERS, branch protection, PRMS, or rulesets.

## Required Human Decision Format

For delegated approval handling, the human decision must be explicit and scoped:

```text
Approve PR #62.
Reason: PRMS report reviewed; CI passed; changed files are limited to packages/kernel/src/**.
```

or:

```text
Do not approve PR #62.
Reason: request changes for <specific issue>.
```

The agent should treat anything less specific as clarification, not approval.

## CODEOWNER Gate

For Red Zone PRs, the GitHub review must come from a valid human CODEOWNER who is not the PR author. Bot or app approvals are ignored even if they were triggered by a human instruction.

