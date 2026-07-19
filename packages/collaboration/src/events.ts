import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollaborationEvent, CollaborationEventType, EventFilter } from './types.js';
import { sanitizeEvent } from './redact.js';

const ALLOWED_SCHEMA = 'openslack.collaboration_event.v1';

const ALL_EVENT_TYPES: CollaborationEventType[] = [
  'task.created',
  'task.claimed',
  'task.blocked',
  'task.done',
  'task.released',
  'task.expired',
  'pr.opened',
  'pr.doctor.ready',
  'pr.doctor.blocked',
  'pr.review.commented',
  'pr.watch.started',
  'pr.watch.completed',
  'pr.merge.requested',
  'pr.merge.confirmed',
  'pr.merge.completed',
  'pr.merge.blocked',
  'operator.intent.parsed',
  'operator.plan.created',
  'operator.plan.blocked',
  'operator.execution.started',
  'operator.execution.completed',
  'operator.execution.failed',
  'chat.message.received',
  'chat.message.duplicate_dropped',
  'chat.plan.confirmation_requested',
  'chat.plan.confirmed',
  'chat.plan.cancelled',
  'chat.plan.expired',
  'governance.audit.passed',
  'governance.audit.failed',
  'governance.direct_commit.explained',
  'governance.direct_commit.unexplained',
  'handoff.created',
  'handoff.accepted',
  'handoff.closed',
  'decision.recorded',
  'decision.superseded',
  'room.summarized',
  'digest.generated',
  'workflow.previewed',
  'workflow.started',
  'workflow.completed',
  'workflow.blocked',
  'profile_sync.triggered',
  'profile_sync.queued',
  'profile_sync.started',
  'profile_sync.completed',
  'profile_sync.failed',
  'repair.previewed',
  'repair.applied',
  'repair.failed',
  'notification.sent',
  'notification.failed',
  'agent.conversation.started',
  'agent.conversation.completed',
  'agent.conversation.failed',
];

function getEventsDir(rootDir = process.cwd()): string {
  const dir = join(rootDir, '.openslack.local', 'collaboration');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getEventsPath(rootDir = process.cwd()): string {
  return join(getEventsDir(rootDir), 'events.jsonl');
}

function generateEventId(): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `EV-${ts}-${rand}`;
}

export function validateEvent(event: unknown): { valid: boolean; reason?: string } {
  if (!event || typeof event !== 'object') {
    return { valid: false, reason: 'Event must be an object' };
  }

  const e = event as Record<string, unknown>;

  if (e.schema !== ALLOWED_SCHEMA) {
    return { valid: false, reason: `Schema must be "${ALLOWED_SCHEMA}"` };
  }

  if (!e.id || typeof e.id !== 'string') {
    return { valid: false, reason: 'Event must have a string id' };
  }

  if (!e.timestamp || typeof e.timestamp !== 'string') {
    return { valid: false, reason: 'Event must have a string timestamp' };
  }

  if (!e.type || typeof e.type !== 'string') {
    return { valid: false, reason: 'Event must have a string type' };
  }

  if (!ALL_EVENT_TYPES.includes(e.type as CollaborationEventType)) {
    return { valid: false, reason: `Unknown event type: ${e.type}` };
  }

  if (!e.actor || typeof e.actor !== 'object') {
    return { valid: false, reason: 'Event must have an actor object' };
  }

  const actor = e.actor as Record<string, unknown>;
  if (!actor.id || typeof actor.id !== 'string') {
    return { valid: false, reason: 'Actor must have a string id' };
  }

  const validActorKinds = ['human', 'agent', 'system', 'github', 'chat'];
  if (!actor.kind || !validActorKinds.includes(actor.kind as string)) {
    return { valid: false, reason: 'Actor must have a valid kind' };
  }

  if (!e.object || typeof e.object !== 'object') {
    return { valid: false, reason: 'Event must have an object' };
  }

  const obj = e.object as Record<string, unknown>;
  if (!obj.id || typeof obj.id !== 'string') {
    return { valid: false, reason: 'Object must have a string id' };
  }

  if (!e.source || typeof e.source !== 'object') {
    return { valid: false, reason: 'Event must have a source object' };
  }

  const source = e.source as Record<string, unknown>;
  if (!source.kind || typeof source.kind !== 'string') {
    return { valid: false, reason: 'Source must have a string kind' };
  }

  if (!e.summary || typeof e.summary !== 'string') {
    return { valid: false, reason: 'Event must have a string summary' };
  }

  if (typeof e.redacted !== 'boolean') {
    return { valid: false, reason: 'Event must have a boolean redacted field' };
  }

  if (e.containsSensitiveData !== false) {
    return { valid: false, reason: 'Event must have containsSensitiveData: false' };
  }

  if (!e.visibility || !['local', 'workspace', 'chat'].includes(e.visibility as string)) {
    return { valid: false, reason: 'Event must have a valid visibility' };
  }

  return { valid: true };
}

export function createEvent(
  partial: Omit<CollaborationEvent, 'id' | 'timestamp' | 'schema'>,
): CollaborationEvent {
  const event: CollaborationEvent = {
    id: generateEventId(),
    schema: ALLOWED_SCHEMA,
    timestamp: new Date().toISOString(),
    ...partial,
  } as CollaborationEvent;

  const validation = validateEvent(event);
  if (!validation.valid) {
    throw new Error(`Invalid event: ${validation.reason}`);
  }

  const redaction = sanitizeEvent(event);
  if (!redaction.safe) {
    throw new Error(`Event rejected: contains sensitive data — ${redaction.reason}`);
  }

  return event;
}

export function appendEvent(event: CollaborationEvent): void {
  const path = getEventsPath();
  const line = JSON.stringify(event) + '\n';
  appendFileSync(path, line, 'utf-8');
}

export function recordEvent(
  partial: Omit<CollaborationEvent, 'id' | 'timestamp' | 'schema'>,
): CollaborationEvent {
  const event = createEvent(partial);
  appendEvent(event);
  return event;
}

export function readEvents(rootDir = process.cwd()): CollaborationEvent[] {
  const path = getEventsPath(rootDir);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  const events: CollaborationEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as CollaborationEvent;
      if (validateEvent(parsed).valid) {
        events.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

export function filterEvents(
  events: CollaborationEvent[],
  filter: EventFilter,
): CollaborationEvent[] {
  return events.filter((e) => {
    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      if (!types.includes(e.type)) return false;
    }
    if (filter.actorId && e.actor.id !== filter.actorId) return false;
    if (filter.actorKind && e.actor.kind !== filter.actorKind) return false;
    if (filter.objectKind && e.object.kind !== filter.objectKind) return false;
    if (filter.objectId && e.object.id !== filter.objectId) return false;
    if (filter.sourceKind && e.source.kind !== filter.sourceKind) return false;
    if (filter.correlationId && e.correlationId !== filter.correlationId) return false;
    if (filter.risk && e.risk !== filter.risk) return false;
    if (filter.severity && e.severity !== filter.severity) return false;
    if (filter.visibility && e.visibility !== filter.visibility) return false;
    if (filter.since) {
      const eventTime = new Date(e.timestamp);
      if (eventTime < filter.since) return false;
    }
    if (filter.until) {
      const eventTime = new Date(e.timestamp);
      if (eventTime > filter.until) return false;
    }
    return true;
  });
}

export function getEventsPathForTesting(): string {
  return getEventsPath();
}

export function getEventsDirForTesting(): string {
  return getEventsDir();
}
