# Agent Work Units

OpenSlack uses several work units. They are intentionally separate because each
one owns planning, context, permissions, and evidence differently.

| Work Unit              | Plan Owner                           | Best For                                      | Evidence                                             |
| ---------------------- | ------------------------------------ | --------------------------------------------- | ---------------------------------------------------- |
| Direct operator action | Operator planner                     | Single-step, low fan-out tasks                | Operator plan and command output                     |
| Subagent               | Parent agent or workflow phase       | One bounded delegation                        | Agent run transcript                                 |
| Skill                  | Human-authored reusable instruction  | Repeatable methods and conventions            | Skill files and referenced artifacts                 |
| Workflow               | Workflow runtime script              | Long-running, parallel, cached, verified work | Workflow run store, phase outputs, agent transcripts |
| Agent team             | Lead agent supervising peer sessions | Long-lived collaboration                      | Deferred beyond Dynamic Workflow Parity v1           |

Dynamic workflows are not just larger subagent prompts. A workflow is a runtime
script that owns phase order, loops, fan-out, synthesis, and intermediate
results. The main agent or operator sees a structured result instead of carrying
every intermediate result in one context.

## When To Use A Workflow

Use a workflow when a task has one or more of these properties:

- It spans many files, issues, PRs, endpoints, or documents.
- It benefits from independent verification or adversarial review.
- It needs fan-out and a synthesis barrier.
- It may run for a long time and should be resumable.
- It needs explicit token, agent-count, or concurrency budgets.
- It should be saved and reused as a project workflow.

Prefer a direct operator action or a single subagent when the task is a small
docs edit, a one-file fix, a status query, or a command that already has a
deterministic OpenSlack CLI entrypoint.

## Boundaries

OpenSlack does not copy Claude Code's permission model. Workflow scripts are
still constrained by OpenSlack trust levels, side-effect manifests, agent
permission profiles, worktree isolation, transcripts, PRMS gates, and human
approval rules.

`ultracode` is a workflow draft trigger in OpenSlack. It is not a permission
bypass and does not run side-effectful work without the existing confirmation
and governance gates.
