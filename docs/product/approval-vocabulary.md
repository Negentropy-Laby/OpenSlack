# Approval Vocabulary

This document clarifies the distinct approval actions in OpenSlack and what each one means. Using precise language prevents confusion between OpenSlack operator confirmations and GitHub-native review actions.

## Approval Actions

### Approve Plan

- **Context**: OpenSlack Operator plan review
- **Who**: Human operator using the CLI or TUI
- **What it does**: Confirms that a workflow plan (phases, side effects, budget) looks correct and may proceed to execution
- **What it does NOT**: Does not approve a GitHub PR, does not bypass rulesets, does not grant agent approval

### Confirm Operation

- **Context**: Workflow execution confirmation gate
- **Who**: Human operator at the CLI (or `--yes` for non-interactive automation)
- **What it does**: Confirms a specific side-effect operation before it runs (e.g., "create issue", "checkout branch", "request merge")
- **What it does NOT**: Does not approve a GitHub PR, does not modify repository rulesets

### Confirm Merge

- **Context**: Merge Steward (PRMS) merge request
- **Who**: Human operator confirming a merge request via OpenSlack
- **What it does**: Confirms that OpenSlack should submit a merge request for a PR through PRMS
- **What it does NOT**: Does not directly merge the PR (PRMS still enforces all rulesets), does not bypass branch protection

### GitHub Review Approval

- **Context**: Native GitHub pull request review
- **Who**: A human with GitHub write access, using their own GitHub identity
- **What it does**: Submits an actual GitHub PR review approval, recorded by GitHub
- **What it does NOT**: This is NOT something OpenSlack does on behalf of users. OpenSlack never submits GitHub review approvals. This action requires direct human interaction with GitHub.

## TUI Approval

### What TUI Approval IS

- Confirming an OpenSlack plan or operation
- Acknowledging that a workflow may proceed with its declared side effects
- A gate that prevents automated operations from running without human acknowledgment

### What TUI Approval IS NOT

- GitHub PR approval (that requires a human GitHub identity)
- Bypassing repository rulesets or branch protection
- Agent approval (agents do not approve things; humans do)
- A substitute for code review

## Execution Mode Safety

When a workflow runs in `execute` mode (real side effects), the following safety guarantees apply:

1. **Confirmation callback is required**: Every side-effect operation must pass through a confirmation gate
2. **No silent execution**: Without `--yes` or an interactive confirmation prompt, execute mode refuses to run
3. **TTY requirement**: Interactive confirmation requires a TTY. Non-TTY environments must use `--yes` explicitly
4. **Denial is immediate**: If any confirmation returns false, the operation throws `ExecuteDeniedError` and the workflow halts

## Vocabulary Reference Table

| Term                   | Scope               | Requires Human            | Persists to GitHub        |
| ---------------------- | ------------------- | ------------------------- | ------------------------- |
| Approve Plan           | OpenSlack workflow  | Yes                       | No                        |
| Confirm Operation      | OpenSlack execution | Yes (or `--yes`)          | No                        |
| Confirm Merge          | OpenSlack PRMS      | Yes (or `--yes`)          | No (PRMS submits request) |
| GitHub Review Approval | GitHub PR           | Yes, with GitHub identity | Yes                       |

## Anti-Patterns to Avoid

1. **Do not** use the word "approve" when you mean "confirm" an OpenSlack operation
2. **Do not** conflate OpenSlack confirmation with GitHub PR approval
3. **Do not** suggest that TUI approval can bypass GitHub branch protection
4. **Do not** allow agents to approve or confirm anything -- only humans can
5. **Do not** use `--yes` in production without understanding it skips all confirmation gates
