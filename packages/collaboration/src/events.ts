import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { resolve } from 'node:path';
import { join } from 'node:path';
import type {
  CollaborationEvent,
  CollaborationEventType,
  EventFilter,
  ObjectKind,
  SourceKind,
} from './types.js';
import { sanitizeEvent } from './redact.js';

const ALLOWED_SCHEMA = 'openslack.collaboration_event.v1';
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const BOUND_APPENDER_FINALIZER = new FinalizationRegistry<number>((descriptor) => {
  try {
    closeSync(descriptor);
  } catch {
    // The process may already be tearing down; the descriptor is otherwise
    // owned for exactly the lifetime of the bound appender.
  }
});

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
  'operator.plan.previewed',
  'operator.plan.confirmed',
  'operator.plan.confirmation_rejected',
  'operator.plan.cancelled',
  'operator.plan.expired',
  'operator.plan.blocked',
  'operator.execution.started',
  'operator.execution.completed',
  'operator.execution.blocked',
  'operator.execution.failed',
  'operator.execution.reconciliation_required',
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
  'workflow.approval.decided',
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
  'graph.read_mirror.matched',
  'graph.read_mirror.mismatched',
  'graph.read_mirror.unavailable',
  'agent.conversation.started',
  'agent.conversation.completed',
  'agent.conversation.failed',
];
const ALL_OBJECT_KINDS: readonly ObjectKind[] = [
  'issue',
  'pr',
  'plan',
  'module',
  'agent',
  'handoff',
  'decision',
  'workspace',
  'workflow',
  'graph',
];
const ALL_SOURCE_KINDS: readonly SourceKind[] = [
  'github',
  'openslack',
  'chat',
  'prms',
  'operator',
  'governance',
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
  if (!obj.kind || !ALL_OBJECT_KINDS.includes(obj.kind as ObjectKind)) {
    return { valid: false, reason: 'Object must have a valid kind' };
  }
  if (!obj.id || typeof obj.id !== 'string') {
    return { valid: false, reason: 'Object must have a string id' };
  }

  if (!e.source || typeof e.source !== 'object') {
    return { valid: false, reason: 'Event must have a source object' };
  }

  const source = e.source as Record<string, unknown>;
  if (!source.kind || !ALL_SOURCE_KINDS.includes(source.kind as SourceKind)) {
    return { valid: false, reason: 'Source must have a valid kind' };
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

export function appendEvent(event: CollaborationEvent, rootDir = process.cwd()): void {
  const path = getEventsPath(rootDir);
  const directoryPath = join(rootDir, '.openslack.local', 'collaboration');
  const directoryBefore = statSync(directoryPath);
  const directorySymbolic = lstatSync(directoryPath);
  if (
    directorySymbolic.isSymbolicLink() ||
    !directorySymbolic.isDirectory() ||
    !directoryBefore.isDirectory() ||
    realpathSync(directoryPath) !== resolve(directoryPath)
  ) {
    throw new Error('Collaboration event directory is unsafe.');
  }
  if (existsSync(path)) {
    const initial = lstatSync(path);
    if (
      initial.isSymbolicLink() ||
      !initial.isFile() ||
      initial.nlink !== 1 ||
      realpathSync(path) !== resolve(path)
    ) {
      throw new Error('Collaboration event file is unsafe.');
    }
  }
  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW,
    0o600,
  );
  try {
    const before = fstatSync(descriptor);
    const namedBefore = lstatSync(path);
    if (
      !before.isFile() ||
      !namedBefore.isFile() ||
      namedBefore.isSymbolicLink() ||
      before.nlink !== 1 ||
      namedBefore.nlink !== 1 ||
      !sameFileIdentity(before, namedBefore)
    ) {
      throw new Error('Collaboration event file identity is unsafe.');
    }
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (written < 1) throw new Error('Collaboration event append made no progress.');
      offset += written;
    }
    fsyncSync(descriptor);
    const after = fstatSync(descriptor);
    const namedAfter = lstatSync(path);
    const directoryAfter = statSync(directoryPath);
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, namedAfter) ||
      after.nlink !== 1 ||
      namedAfter.nlink !== 1 ||
      directoryBefore.dev !== directoryAfter.dev ||
      directoryBefore.ino !== directoryAfter.ino ||
      realpathSync(directoryPath) !== resolve(directoryPath)
    ) {
      throw new Error('Collaboration event file or directory identity changed.');
    }
  } finally {
    closeSync(descriptor);
  }
}

export interface BoundCollaborationEventAppender {
  append(event: CollaborationEvent): void;
}

/**
 * Bind governed audit writes to one already-verified event-log inode for the
 * lifetime of the appender. Reopening `events.jsonl` by path on every call
 * would allow a directory replacement between an outer identity check and the
 * open. A fixed O_APPEND descriptor makes a later rename unable to redirect
 * bytes; path checks then decide whether the call may report success.
 */
export function createBoundEventAppender(rootDir = process.cwd()): BoundCollaborationEventAppender {
  const path = getEventsPath(rootDir);
  const directoryPath = join(rootDir, '.openslack.local', 'collaboration');
  const directory = checkedDirectoryIdentity(directoryPath);
  if (existsSync(path)) assertSafeNamedEventFile(path);

  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW,
    0o600,
  );
  const opened = fstatSync(descriptor);
  try {
    assertBoundEventTarget(path, directoryPath, directory, descriptor, opened);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }

  const appender = Object.freeze({
    append(event: CollaborationEvent): void {
      assertBoundEventTarget(path, directoryPath, directory, descriptor, opened);
      appendEventBytes(descriptor, event);
      fsyncSync(descriptor);
      assertBoundEventTarget(path, directoryPath, directory, descriptor, opened);
    },
  });
  BOUND_APPENDER_FINALIZER.register(appender, descriptor);
  return appender;
}

interface DirectoryFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function checkedDirectoryIdentity(path: string): DirectoryFileIdentity {
  const symbolic = lstatSync(path);
  const stat = statSync(path);
  if (
    symbolic.isSymbolicLink() ||
    !symbolic.isDirectory() ||
    !stat.isDirectory() ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error('Collaboration event directory is unsafe.');
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function assertSafeNamedEventFile(path: string): void {
  const named = lstatSync(path);
  if (
    named.isSymbolicLink() ||
    !named.isFile() ||
    named.nlink !== 1 ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error('Collaboration event file is unsafe.');
  }
}

function assertBoundEventTarget(
  path: string,
  directoryPath: string,
  directory: DirectoryFileIdentity,
  descriptor: number,
  opened: Stats,
): void {
  const currentDirectory = checkedDirectoryIdentity(directoryPath);
  const currentDescriptor = fstatSync(descriptor);
  const named = lstatSync(path);
  if (
    currentDirectory.dev !== directory.dev ||
    currentDirectory.ino !== directory.ino ||
    !opened.isFile() ||
    !currentDescriptor.isFile() ||
    !named.isFile() ||
    named.isSymbolicLink() ||
    opened.nlink !== 1 ||
    currentDescriptor.nlink !== 1 ||
    named.nlink !== 1 ||
    !sameFileIdentity(opened, currentDescriptor) ||
    !sameFileIdentity(currentDescriptor, named) ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error('Bound Collaboration event file or directory identity changed.');
  }
}

function appendEventBytes(descriptor: number, event: CollaborationEvent): void {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    if (written < 1) throw new Error('Collaboration event append made no progress.');
    offset += written;
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function recordEvent(
  partial: Omit<CollaborationEvent, 'id' | 'timestamp' | 'schema'>,
  rootDir = process.cwd(),
): CollaborationEvent {
  const event = createEvent(partial);
  appendEvent(event, rootDir);
  return event;
}

export function readEvents(rootDir = process.cwd()): CollaborationEvent[] {
  const path = getEventsPath(rootDir);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  const events: CollaborationEvent[] = [];
  const seenIds = new Set<string>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as CollaborationEvent;
      if (validateEvent(parsed).valid && !seenIds.has(parsed.id)) {
        seenIds.add(parsed.id);
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
