# Collaboration Events

## Event Schema

Collaboration events follow the schema `openslack.collaboration_event.v1`.

```typescript
export interface CollaborationEvent {
  id: string;
  schema: 'openslack.collaboration_event.v1';
  timestamp: string;
  type: CollaborationEventType;
  actor: {
    id: string;
    kind: 'human' | 'agent' | 'system' | 'github' | 'chat';
    provider?: 'cli' | 'slack' | 'webhook' | 'github';
  };
  object: {
    kind: 'issue' | 'pr' | 'plan' | 'module' | 'agent' | 'handoff' | 'decision' | 'workspace';
    id: string;
    url?: string;
  };
  source: {
    kind: 'github' | 'openslack' | 'chat' | 'prms' | 'operator' | 'governance';
    ref: string;
  };
  summary: string;
  owner?: {
    id: string;
    kind: 'human' | 'agent' | 'system';
  };
  nextAction?: {
    owner: string;
    action: string;
    command?: string;
    url?: string;
  };
  risk?: 'none' | 'low' | 'medium' | 'high';
  severity?: 'info' | 'notice' | 'warning' | 'critical';
  visibility: 'local' | 'workspace' | 'chat';
  correlationId?: string;
  parentEventId?: string;
  redacted: boolean;
  containsSensitiveData: false;
  metadata?: Record<string, unknown>;
}
```

## Event Type Groups

### Task Events

- `task.created` — A new task was created
- `task.claimed` — An agent claimed a task
- `task.blocked` — A task is blocked
- `task.done` — A task is completed
- `task.released` — An agent released a task
- `task.expired` — A task claim expired

### PRMS Events

- `pr.opened` — A PR was opened
- `pr.doctor.ready` — PRMS doctor reported ready to merge
- `pr.doctor.blocked` — PRMS doctor reported blockers
- `pr.review.commented` — A review comment was added
- `pr.watch.started` — PR watch began
- `pr.watch.completed` — PR watch completed
- `pr.merge.requested` — Merge was requested
- `pr.merge.confirmed` — Merge plan was confirmed
- `pr.merge.completed` — Merge succeeded
- `pr.merge.blocked` — Merge was blocked

### Operator Events

- `operator.intent.parsed` — Intent was extracted from user text
- `operator.plan.created` — An action plan was generated
- `operator.plan.blocked` — Plan creation failed
- `operator.execution.started` — Plan execution began
- `operator.execution.completed` — Plan execution succeeded
- `operator.execution.failed` — Plan execution failed

### Chat Events

- `chat.message.received` — A chat message was received
- `chat.message.duplicate_dropped` — A duplicate message was dropped
- `chat.plan.confirmation_requested` — User asked to confirm a plan
- `chat.plan.confirmed` — User confirmed a plan
- `chat.plan.cancelled` — User cancelled a plan
- `chat.plan.expired` — A plan expired without confirmation

### Governance Events

- `governance.audit.passed` — Governance audit passed
- `governance.audit.failed` — Governance audit failed
- `governance.direct_commit.explained` — A direct commit was explained
- `governance.direct_commit.unexplained` — An unexplained direct commit was detected

### Collaboration Object Events

- `handoff.created` — A handoff was created
- `handoff.accepted` — A handoff was accepted
- `handoff.closed` — A handoff was closed
- `decision.recorded` — A decision was recorded
- `decision.superseded` — A decision was superseded
- `room.summarized` — A room summary was generated
- `digest.generated` — A digest was generated

## Storage

### Local Runtime Projection

Path: `.openslack.local/collaboration/events.jsonl`

Purpose: Chat traces, operator execution traces, runtime audit.

Not committed to Git.

Format: One JSON object per line (JSONL).

### Workspace Collaboration Objects

Path: `.openslack/collaboration/`

Subdirectories:

- `handoffs/` — Handoff YAML files
- `decisions/` — Decision record YAML files

These are first-class workspace objects, committed to Git.

### Derived Reports

Path: `.openslack.local/collaboration/`

Subdirectories:

- `digests/` — Regenerable from events
- `rooms/` — Regenerable from events + objects

## Source Links

Every event should reference its source of truth:

| Object kind | Source link example                            |
| ----------- | ---------------------------------------------- |
| `issue`     | `https://github.com/{owner}/{repo}/issues/{n}` |
| `pr`        | `https://github.com/{owner}/{repo}/pull/{n}`   |
| `plan`      | Internal plan ID (`PLAN-2026...`)              |
| `module`    | `.openslack/modules.yaml`                      |
| `handoff`   | `.openslack/collaboration/handoffs/{id}.yaml`  |
| `decision`  | `.openslack/collaboration/decisions/{id}.yaml` |

## Redaction

Before any event is written, its metadata passes through `sanitizeEvent()`.

Secret patterns detected:

- Slack tokens: `xox[baprs]-...`
- GitHub tokens: `gh[pousr]_...`
- Private keys: `-----BEGIN ... PRIVATE KEY-----`
- AWS secrets: `AWS_SECRET_ACCESS_KEY=...`
- OpenSlack secrets: `OPENSLACK_*SECRET=...`

If a secret pattern is detected, the **write is rejected**, not silently redacted.

Safe summaries may be redacted. Raw metadata containing secrets is always rejected.

## Integration Hooks

Events are emitted from existing components in three batches:

### Batch 1: Read-Only / Low-Risk

- `governance audit` → `governance.audit.passed/failed`
- `@openslack/pr` doctor → `pr.doctor.ready/blocked`
- `@openslack/operator` planActions → `operator.plan.created`

### Batch 2: Chat Runtime

- `interaction-store.ts` → `chat.message.received/duplicate_dropped`
- `plan-store.ts` → `plan.created/confirmed/expired`

### Batch 3: Side-Effect

- Merge operations → `merge.started/completed/blocked`
- Task completion → `task.done`
- Handoff acceptance → `handoff.accepted`
- Decision recording → `decision.recorded`

## Testing Strategy

- Event validation: test valid events are accepted, invalid events are rejected
- JSONL storage: test append, read, and filter operations
- Redaction: test secret patterns are detected and writes are rejected
- Activity feed: test grouping and filtering by actor, object, time, type
- Source links: test URL generation for all object kinds
