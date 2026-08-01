import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createBoundEventAppender,
  sanitizeEvent,
  validateEvent,
  type CollaborationEvent,
  type CollaborationEventType,
} from '@openslack/collaboration';
import {
  GraphReadMirrorHttpClient,
  type GraphReadMirrorHttpClientOptions,
  type GraphReadMirrorObservation,
  type GraphReadMirrorPort,
  type GraphServiceNetworkMode,
} from '@openslack/organization-graph';

export interface CreateOpenSlackGraphReadMirrorOptions {
  readonly workspaceRoot: string;
  readonly origin: string;
  readonly networkMode?: GraphServiceNetworkMode;
  readonly timeoutMs?: number;
  /** Test seam. Production composition uses the global bounded fetch implementation. */
  readonly fetch?: GraphReadMirrorHttpClientOptions['fetch'];
  /** Test seam. Production composition uses the system clock. */
  readonly now?: () => number;
}

function canonicalWorkspaceRoot(value: string): string {
  if (typeof value !== 'string' || resolve(value) !== value) {
    throw new TypeError('Graph read mirror workspace root must be absolute and normalized.');
  }
  const symbolic = lstatSync(value);
  const stat = statSync(value);
  const real = realpathSync.native(value);
  if (
    symbolic.isSymbolicLink() ||
    !symbolic.isDirectory() ||
    !stat.isDirectory() ||
    real !== value
  ) {
    throw new TypeError('Graph read mirror workspace root must be a real canonical directory.');
  }
  return real;
}

function eventType(observation: GraphReadMirrorObservation): CollaborationEventType {
  if (observation.outcome === 'matched') return 'graph.read_mirror.matched';
  if (observation.outcome === 'mismatched') return 'graph.read_mirror.mismatched';
  return 'graph.read_mirror.unavailable';
}

function auditEvent(observation: GraphReadMirrorObservation): CollaborationEvent {
  const type = eventType(observation);
  return {
    schema: 'openslack.collaboration_event.v1',
    id: `GRAUDIT-${randomUUID()}`,
    timestamp: observation.completedAt,
    type,
    actor: { id: 'organization-graph-read-mirror', kind: 'system' },
    object: { kind: 'graph', id: observation.scenarioInstanceId },
    source: { kind: 'openslack', ref: 'organization-graph-read-mirror' },
    summary:
      type === 'graph.read_mirror.matched'
        ? `Recorded matching ${observation.operation} mirror evidence.`
        : type === 'graph.read_mirror.mismatched'
          ? `Recorded mismatching ${observation.operation} mirror evidence.`
          : `Recorded unavailable ${observation.operation} mirror evidence.`,
    owner: { id: 'organization-graph', kind: 'system' },
    severity: type === 'graph.read_mirror.matched' ? 'info' : 'warning',
    visibility: 'workspace',
    redacted: true,
    containsSensitiveData: false,
    metadata: {
      observationSchema: observation.schema,
      operation: observation.operation,
      outcome: observation.outcome,
      parity: observation.parity,
      authority: observation.authority,
      mirror: observation.mirror,
      requestFingerprint: observation.requestFingerprint,
      authorityDigest: observation.authorityDigest,
      ...(observation.mirrorDigest === undefined ? {} : { mirrorDigest: observation.mirrorDigest }),
      ...(observation.snapshotCursorHash === undefined
        ? {}
        : { snapshotCursorHash: observation.snapshotCursorHash }),
      ...(observation.queryHash === undefined ? {} : { queryHash: observation.queryHash }),
      ...(observation.differenceCodes === undefined
        ? {}
        : { differenceCodes: [...observation.differenceCodes] }),
      ...(observation.httpStatus === undefined ? {} : { httpStatus: observation.httpStatus }),
      ...(observation.code === undefined ? {} : { code: observation.code }),
      latencyMs: observation.latencyMs,
    },
  };
}

export function createOpenSlackGraphReadMirror(
  options: CreateOpenSlackGraphReadMirrorOptions,
): GraphReadMirrorPort {
  const workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot);
  const auditTarget: {
    appender: ReturnType<typeof createBoundEventAppender> | undefined;
  } = { appender: undefined };
  const client = new GraphReadMirrorHttpClient({
    origin: options.origin,
    ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    auditSink: (observation) => {
      const event = auditEvent(observation);
      if (!validateEvent(event).valid || !sanitizeEvent(event).safe) {
        throw new TypeError('Graph read mirror observation failed its bounded audit contract.');
      }
      if (!auditTarget.appender) {
        throw new TypeError('Graph read mirror audit target is not bound.');
      }
      auditTarget.appender.append(event);
    },
    auditFailureSink: () => {
      console.error(
        'OPENSLACK_GRAPH_READ_MIRROR_AUDIT_FAILED: bounded Collaboration audit append failed.',
      );
    },
  });
  // Validate every client option before the durable audit target is created or opened.
  auditTarget.appender = createBoundEventAppender(workspaceRoot);
  return client;
}
