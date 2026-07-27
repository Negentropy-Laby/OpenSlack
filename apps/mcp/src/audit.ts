import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createBoundEventAppender,
  sanitizeEvent,
  validateEvent,
  type CollaborationEvent,
  type CollaborationEventType,
  type ObjectKind,
} from '@openslack/collaboration';
import {
  canonicalizeGovernedJson,
  type GovernedJsonValue,
  type GovernedPlanAuditEvent,
  type GovernedPlanAuditSink,
} from '@openslack/operator';

const EVENT_TYPES = Object.freeze({
  'plan.previewed': 'operator.plan.previewed',
  'plan.confirmed': 'operator.plan.confirmed',
  'plan.confirmation_rejected': 'operator.plan.confirmation_rejected',
  'plan.cancelled': 'operator.plan.cancelled',
  'plan.expired': 'operator.plan.expired',
  'plan.execution_started': 'operator.execution.started',
  'plan.execution_completed': 'operator.execution.completed',
  'plan.execution_blocked': 'operator.execution.blocked',
  'plan.execution_failed': 'operator.execution.failed',
  'plan.reconciliation_required': 'operator.execution.reconciliation_required',
  'workflow.approval_decided': 'workflow.approval.decided',
}) satisfies Readonly<Record<GovernedPlanAuditEvent['type'], CollaborationEventType>>;

interface DirectoryIdentity {
  readonly path: string;
  readonly real: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

function directory(path: string, create: boolean): DirectoryIdentity {
  if (create && !existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 });
  const symbolic = lstatSync(path, { bigint: true });
  const stat = statSync(path, { bigint: true });
  const real = realpathSync(path);
  if (
    symbolic.isSymbolicLink() ||
    !symbolic.isDirectory() ||
    !stat.isDirectory() ||
    real !== resolve(path)
  ) {
    throw new TypeError('Governed audit path must be a real canonical directory.');
  }
  return Object.freeze({ path, real, dev: stat.dev, ino: stat.ino });
}

function sameDirectory(identity: DirectoryIdentity): boolean {
  try {
    const symbolic = lstatSync(identity.path, { bigint: true });
    const stat = statSync(identity.path, { bigint: true });
    return (
      !symbolic.isSymbolicLink() &&
      symbolic.isDirectory() &&
      stat.isDirectory() &&
      realpathSync(identity.path) === identity.real &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    );
  } catch {
    return false;
  }
}

interface SafeAuditRecord {
  readonly type: GovernedPlanAuditEvent['type'];
  readonly eventId: string;
  readonly occurredAt: string;
  readonly planId: string;
  readonly kind: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly state: string;
  readonly revision: number;
  readonly evidenceRefs: readonly GovernedJsonValue[];
}

function auditRecord(value: GovernedPlanAuditEvent): SafeAuditRecord {
  const event = canonicalizeGovernedJson(value);
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Governed audit event is invalid.');
  }
  const object = event as { readonly [key: string]: GovernedJsonValue };
  const allowed = new Set([
    'schema',
    'eventId',
    'type',
    'occurredAt',
    'planId',
    'kind',
    'actorId',
    'workspaceId',
    'correlationId',
    'state',
    'revision',
    'evidenceRefs',
    'details',
  ]);
  if (
    Object.keys(object).some((key) => !allowed.has(key)) ||
    object.schema !== 'openslack.governed_plan_audit.v1' ||
    typeof object.type !== 'string' ||
    !Object.hasOwn(EVENT_TYPES, object.type) ||
    typeof object.eventId !== 'string' ||
    typeof object.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(object.occurredAt)) ||
    typeof object.planId !== 'string' ||
    typeof object.kind !== 'string' ||
    typeof object.actorId !== 'string' ||
    typeof object.workspaceId !== 'string' ||
    typeof object.correlationId !== 'string' ||
    typeof object.state !== 'string' ||
    typeof object.revision !== 'number' ||
    !Number.isSafeInteger(object.revision) ||
    !Array.isArray(object.evidenceRefs)
  ) {
    throw new TypeError('Governed audit event failed its closed sink contract.');
  }
  return object as unknown as SafeAuditRecord;
}

export function createGovernedPlanCollaborationAuditSink(
  workspaceRootValue: string,
): GovernedPlanAuditSink {
  if (
    typeof workspaceRootValue !== 'string' ||
    resolve(workspaceRootValue) !== workspaceRootValue
  ) {
    throw new TypeError('Governed audit workspace root must be absolute and normalized.');
  }
  const root = directory(workspaceRootValue, false);
  const localPath = join(root.real, '.openslack.local');
  const local = directory(localPath, true);
  const collaboration = directory(join(local.real, 'collaboration'), true);
  const eventAppender = createBoundEventAppender(root.real);

  return async (value): Promise<void> => {
    if (!sameDirectory(root) || !sameDirectory(local) || !sameDirectory(collaboration)) {
      throw new TypeError('Governed audit directory identity changed.');
    }
    const event = auditRecord(value);
    const type = EVENT_TYPES[event.type];
    const objectKind: ObjectKind = event.type === 'workflow.approval_decided' ? 'workflow' : 'plan';
    const collaborationEvent: CollaborationEvent = {
      schema: 'openslack.collaboration_event.v1',
      id: event.eventId,
      timestamp: event.occurredAt,
      type,
      actor: {
        id: event.actorId,
        kind: event.type === 'workflow.approval_decided' ? 'human' : 'system',
      },
      object: { kind: objectKind, id: event.planId },
      source: { kind: 'operator', ref: 'qoder-governed-plan' },
      summary: `Recorded governed ${event.kind} transition ${event.type}.`,
      owner: {
        id: event.actorId,
        kind: event.type === 'workflow.approval_decided' ? 'human' : 'system',
      },
      severity:
        event.type === 'plan.execution_failed' || event.type === 'plan.reconciliation_required'
          ? 'warning'
          : 'info',
      visibility: 'workspace',
      correlationId: event.correlationId,
      redacted: true,
      containsSensitiveData: false,
      metadata: {
        auditEventId: event.eventId,
        workspaceId: event.workspaceId,
        state: event.state,
        revision: event.revision,
        evidenceRefs: event.evidenceRefs,
      },
    };
    const validation = validateEvent(collaborationEvent);
    const redaction = sanitizeEvent(collaborationEvent);
    if (!validation.valid || !redaction.safe) {
      throw new TypeError('Governed audit event failed Collaboration validation.');
    }
    eventAppender.append(collaborationEvent);
  };
}
