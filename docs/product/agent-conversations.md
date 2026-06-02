---
schema: openslack.product_spec.v1
status: active
created: 2026-06-02
source: Agent Conversation Phase AC Design
canonical_status: docs/status/current.md
---

# Agent Conversations — Phase AC Design Document

## Executive Summary

Agent Conversations bring structured, observable multi-turn agent-human
interaction to OpenSlack.  A conversation is a thread of typed messages
(user messages, agent responses, tool events, plans, approval requests,
decisions, handoffs) stored in `.openslack.local/conversations/` with
JSONL persistence.  Conversations integrate with the existing
Collaboration Layer event model, activity feed, digest, and room views,
making agent interactions as traceable as PR reviews and task claims.

This document defines the data model, CLI surface, TUI views, workflow
integration, security model, and acceptance criteria for Agent
Conversations.

## Problem Statement

OpenSlack already has a rich collaboration model: issues, PRs, handoffs,
decisions, workflow runs, and governance events.  But agent interactions
with humans happen in ad-hoc ways — chat messages, CLI output, comments
on PRs — and there is no unified, typed record of what was asked, what
was planned, what tools were invoked, what approvals were requested, and
what decisions were made.

Without Agent Conversations:

- Humans cannot replay or audit a past agent interaction.
- Agents cannot carry structured context across subagent handoffs.
- The activity feed has no canonical representation of multi-turn agent
  work.
- Room views cannot show which agent conversations affected a given
  issue or PR.

Agent Conversations solve this by introducing a first-class
`AgentConversationThread` type with typed messages, lifecycle events,
and full integration with the collaboration event model.

## Data Model

### AgentConversationThread

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | `CONV-YYYYMMDD-XXXX` format |
| `schema` | `string` | `openslack.agent_conversation_thread.v1` |
| `title` | `string` | Human-readable thread title |
| `status` | `enum` | `open`, `active`, `paused`, `completed`, `archived` |
| `createdAt` | `ISO 8601` | Creation timestamp |
| `updatedAt` | `ISO 8601` | Last update timestamp |
| `participants` | `AgentParticipant[]` | Human, agent, subagent, system actors |
| `linkedObjects` | `ConversationLinkedObject[]` | Issues, PRs, workflows, rooms, handoffs, decisions |
| `memoryPolicy` | `enum` | `local`, `project`, `none` |
| `summary` | `string?` | Optional summary of the conversation |
| `nextAction` | `NextAction?` | Owner and action for the next step |

### AgentParticipant

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique participant identifier |
| `kind` | `enum` | `human`, `agent`, `subagent`, `system` |
| `provider` | `string?` | `openslack`, `claude-code`, `codex`, `github`, `slack` |
| `displayName` | `string` | Human-readable name |
| `role` | `string?` | `operator`, `reviewer`, `implementer`, `researcher`, `planner` |
| `permissions` | `string[]?` | Granted permissions |
| `model` | `string?` | Model identifier (for agents) |
| `color` | `string?` | Display color for TUI |

### AgentConversationMessage (7 Kinds)

Messages are discriminated unions on the `kind` field:

| Kind | Purpose | Key Fields |
|------|---------|------------|
| `user_message` | Human input | `text`, `source` |
| `agent_response` | Agent reply | `text`, `structured` |
| `tool_event` | Tool invocation | `toolName`, `input`, `output` |
| `plan` | Multi-step plan | `planId`, `steps` |
| `approval_request` | Approval gate | `targetAction`, `riskLevel` |
| `decision` | Decision recorded | `decisionId`, `summary` |
| `handoff` | Context transfer | `handoffId`, `toParticipant`, `summary` |

Every message has `id` (`MSG-YYYYMMDD-XXXXXX`), `threadId`,
`timestamp`, and `authorId`.

## Subagent Definition Format

Agent Conversations are compatible with Claude Code's `.claude/agents/`
subagent definitions.  The resolver follows this priority order:

1. OpenSlack registry: `.openslack/agents/registry/*.yaml`
2. Claude Code project-level: `.claude/agents/*.md`
3. Claude Code user-level: `~/.claude/agents/*.md`

Resolved agents produce a `ResolvedAgentConfig` with `agentId`, `source`,
`model`, `tools`, `disallowedTools`, `permissionMode`, `isolation`, and
`prompt` fields.

## CLI Commands

All conversation commands live under the `openslack conversation` group:

| Command | Description |
|---------|-------------|
| `openslack conversation start --title "..."` | Create a new conversation thread |
| `openslack conversation list [--status active]` | List conversation threads |
| `openslack conversation show <threadId>` | Show thread details and messages |
| `openslack conversation send <threadId> <message>` | Append a message to a thread |
| `openslack conversation summarize <threadId>` | Show thread summary and next action |
| `openslack conversation archive <threadId>` | Archive a thread |

### start

```bash
openslack conversation start --title "Review PR #42" [--pr 42] [--issue 15] [--workflow RUN-123]
```

Flags:

- `--title <string>` (required) — thread title
- `--pr <number>` — link to a PR
- `--issue <number>` — link to an issue
- `--workflow <string>` — link to a workflow run

### list

```bash
openslack conversation list [--status active]
```

### show

```bash
openslack conversation show CONV-20260602-ABCD1234
```

### send

```bash
openslack conversation send CONV-20260602-ABCD1234 "Hello, this is my message"
```

### summarize

```bash
openslack conversation summarize CONV-20260602-ABCD1234
```

### archive

```bash
openslack conversation archive CONV-20260602-ABCD1234
```

## TUI Views

### ConversationListView

Displays all threads with status filters, sort by updated date,
color-coded status badges, and participant avatars.

### ThreadView

Shows a single thread with message timeline, kind badges (plan, tool,
approval, decision), participant identification, and linked object
navigation.

### SubagentDetailView

Shows resolved agent configuration for a participant: source registry,
model, tools, permission mode, isolation level.

## Workflow Integration

### Agent Type Resolution

When a workflow step involves an agent conversation, the runtime resolves
the agent type through the `resolveAgentType` function in
`@openslack/workflows`.  This function checks:

1. OpenSlack agent registry (`.openslack/agents/registry/`)
2. Claude Code subagent definitions (`.claude/agents/`)

The resolved config determines the model, tools, permissions, and
isolation level for the conversation participant.

### Lifecycle Events

Planned collaboration events at conversation lifecycle boundaries:

| Event | When | Status |
|-------|------|--------|
| `agent.conversation.started` | Agent call begins in execute mode | ✅ Implemented |
| `agent.conversation.completed` | Agent finishes successfully | ✅ Implemented |
| `agent.conversation.failed` | Agent encounters an error | ✅ Implemented |

These events are stored in the standard collaboration event log
(`.openslack.local/collaboration/events.jsonl`) and appear in the
activity feed, digest, and room views. The bridge is wired through
`executeRun()` / `executeResume()` via `agentEventEmitter` which converts
`AgentConversationEvent` into `CollaborationEvent` via `recordEvent()`.

### Correlation

Every workflow-agent conversation carries a `correlationId` (set to the
workflow `runId`) linking the started, completed/failed events, and the
parent workflow run.

## Security Model

### Constitutional Compliance

Agent Conversations obey all Constitutional Constraints:

- No self-review: agents cannot approve their own PRs through
  conversation approval requests.
- No auto-approval: `approval_request` messages record the request but
  do not originate approval decisions.
- No secret access: conversation messages are sanitized by the existing
  redaction pipeline before event emission.
- Risk zones: conversations touching Red Zone paths require human
  approval through the standard gate.

### Permission Mapping

Current state: conversation CLI commands are registered in the operator
tool registry with risk levels and side-effect flags. Fine-grained
permission names (`conversation.create`, etc.) are planned but not yet
implemented.

| Conversation Action | Operator Registry ID | Risk Level | Side Effects |
|---------------------|---------------------|------------|--------------|
| Create thread | `conversation.start` | low | yes |
| List threads | `conversation.list` | none | no |
| Show thread | `conversation.show` | none | no |
| Send message | `conversation.send` | medium | yes |
| Summarize thread | `conversation.summarize` | none | no |
| Archive thread | `conversation.archive` | medium | yes |

### Memory Policy

- `local`: Messages stored in `.openslack.local/` (gitignored)
- `project`: Messages stored in `.openslack/` (committed)
- `none`: No persistent storage (ephemeral only)

## Scope Boundaries

### In Scope

- Thread creation, listing, retrieval, archiving
- Seven typed message kinds with full validation
- JSONL persistence with atomic appends
- Secret scanning and redaction on all messages
- Agent type resolution through registry and Claude Code compat
- Memory policy control (`local`, `project`, `none`)
- Pruning of expired threads with policy-aware TTL
- Operator tool registry for all six conversation commands

### Planned (Not Yet Implemented)

- Collaboration event emission at lifecycle boundaries (AC-3)
- Activity feed, digest, and room view integration for conversations
- Correlation IDs linking conversations to workflow runs
- Subagent dispatch runner with permission enforcement
- `openslack subagent` CLI command group

### Out of Scope

- Real-time streaming of agent responses (future)
- Multi-agent conversation orchestration (future)
- Conversation branching or forking (future)
- Cross-workspace conversation sharing (future)
- LLM-powered summarization (future enhancement)
- Conversation search / full-text indexing (future)

## Acceptance Criteria

| AC | Criterion |
|----|-----------|
| AC-1 | Data model defined with typed messages and validation |
| AC-2 | Conversation store with JSONL persistence |
| AC-3 | Collaboration event integration (started/completed/failed) |
| AC-4 | Agent resolver integration with Claude Code compat |
| AC-5 | CLI commands and TUI views |
| AC-6 | Integration validation, module registry update, documentation |

## Implementation PR Breakdown

### PR AC-1 — Data Model and Type Definitions

- `conversation-types.ts` with `AgentConversationThread`,
  `AgentConversationMessage` (7 kinds), `AgentParticipant`,
  `ConversationLinkedObject`, type guards
- Unit tests for type validation and guards

### PR AC-2 — Conversation Store

- `conversation-store.ts` with `createThread`, `listThreads`,
  `getThread`, `appendMessage`, `archiveThread`, `pruneExpiredThreads`
- JSONL persistence, filesystem layout, thread status transitions
- Unit tests for all store operations

### PR AC-3 — Collaboration Event Integration

- Add `agent.conversation.started`, `.completed`, `.failed` event types
  to the collaboration event model
- Event emission at conversation lifecycle boundaries
- Activity feed and room view inclusion
- Unit tests for event emission and filtering

### PR AC-4 — Agent Resolver Integration

- `agent-resolver.ts` in `@openslack/workflows` resolving agent types
  from OpenSlack registry and Claude Code `.claude/agents/` definitions
- `ResolvedAgentConfig` type with model, tools, permissions
- Unit tests for resolution priority and fallback

### PR AC-5 — CLI Commands and TUI Views

- `openslack conversation start/list/show/send/summarize/archive`
  commands in `apps/cli`
- Conversation render functions for text, JSON, and TUI formats
- `ConversationListView`, `ThreadView`, `SubagentDetailView` TUI
  components

### PR AC-6 — Integration Validation, Module Registry, Documentation

- Integration tests covering end-to-end conversation-workflow lifecycle
- Error path testing (conversation.failed events)
- Activity feed and room binding verification
- Multi-message workflow test (plans, tools, decisions, handoffs)
- `docs/product/agent-conversations.md` product design document
- `.openslack/modules.yaml` update with conversation capability
- Full validation suite (typecheck, tests, workspace validate,
  status verify)
