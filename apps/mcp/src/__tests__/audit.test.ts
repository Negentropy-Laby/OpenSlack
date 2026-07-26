import {
  mkdirSync,
  mkdtempSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readEvents } from '@openslack/collaboration';
import type { GovernedPlanAuditEvent } from '@openslack/operator';
import { createGovernedPlanCollaborationAuditSink } from '../audit.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'openslack-governed-audit-'));
  roots.push(value);
  return value;
}

function event(type: GovernedPlanAuditEvent['type'] = 'plan.previewed'): GovernedPlanAuditEvent {
  return {
    schema: 'openslack.governed_plan_audit.v1',
    eventId: `GAUDIT-${type.replace(/[^a-z0-9]+/gi, '-')}`,
    type,
    occurredAt: '2026-07-27T00:00:00.000Z',
    planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
    kind:
      type === 'workflow.approval_decided' ? 'workflow.approval.decide' : 'scenario.instantiate',
    actorId: 'qoder.human.interviewer',
    workspaceId: 'workspace.contract-demo',
    correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174000',
    state: 'pending',
    revision: 1,
    evidenceRefs: ['plan:GPLAN-123e4567-e89b-42d3-a456-426614174000'],
    details: {
      confirmationToken: 'must-never-be-persisted',
      rawBusinessPayload: 'must-never-be-persisted',
    },
  };
}

describe('governed-plan Collaboration audit sink', () => {
  it('maps every governed transition without persisting token or raw detail fields', async () => {
    const workspaceRoot = root();
    const sink = createGovernedPlanCollaborationAuditSink(workspaceRoot);
    for (const type of [
      'plan.previewed',
      'plan.confirmed',
      'plan.confirmation_rejected',
      'plan.cancelled',
      'plan.expired',
      'plan.execution_started',
      'plan.execution_completed',
      'plan.execution_blocked',
      'plan.execution_failed',
      'plan.reconciliation_required',
      'workflow.approval_decided',
    ] as const) {
      await sink(event(type));
    }

    const events = readEvents(workspaceRoot);
    expect(events).toHaveLength(11);
    expect(events.map((item) => item.type)).toEqual([
      'operator.plan.previewed',
      'operator.plan.confirmed',
      'operator.plan.confirmation_rejected',
      'operator.plan.cancelled',
      'operator.plan.expired',
      'operator.execution.started',
      'operator.execution.completed',
      'operator.execution.blocked',
      'operator.execution.failed',
      'operator.execution.reconciliation_required',
      'workflow.approval.decided',
    ]);
    expect(events.every((item) => item.correlationId?.startsWith('CORR-'))).toBe(true);
    expect(events.at(-1)?.actor).toEqual({
      id: 'qoder.human.interviewer',
      kind: 'human',
    });
    const bytes = readFileSync(
      join(workspaceRoot, '.openslack.local', 'collaboration', 'events.jsonl'),
      'utf8',
    );
    expect(bytes).not.toContain('must-never-be-persisted');
    expect(bytes).not.toContain('confirmationToken');
    expect(bytes).not.toContain('rawBusinessPayload');
  });

  it('fails closed if the prepared audit directory identity is replaced', async () => {
    const workspaceRoot = root();
    const sink = createGovernedPlanCollaborationAuditSink(workspaceRoot);
    const collaboration = join(workspaceRoot, '.openslack.local', 'collaboration');
    rmSync(collaboration, { recursive: true, force: true });
    mkdirSync(collaboration);
    await expect(sink(event())).rejects.toThrow(/directory identity changed/);
    expect(readEvents(workspaceRoot)).toEqual([]);
  });

  it('rejects a hard-linked event target and does not alter the linked file', async () => {
    const workspaceRoot = root();
    const collaboration = join(workspaceRoot, '.openslack.local', 'collaboration');
    const redirected = join(workspaceRoot, 'redirected.txt');
    const target = join(collaboration, 'events.jsonl');
    mkdirSync(collaboration, { recursive: true });
    writeFileSync(redirected, 'unchanged\n');
    linkSync(redirected, target);

    expect(() => createGovernedPlanCollaborationAuditSink(workspaceRoot)).toThrow(
      /event file is unsafe/,
    );
    expect(readFileSync(redirected, 'utf8')).toBe('unchanged\n');
  });

  it('never reopens the governed event log through a replacement directory', async () => {
    const workspaceRoot = root();
    const sink = createGovernedPlanCollaborationAuditSink(workspaceRoot);
    const collaboration = join(workspaceRoot, '.openslack.local', 'collaboration');
    const original = join(workspaceRoot, '.openslack.local', 'collaboration-original');
    let renamed = false;
    try {
      renameSync(collaboration, original);
      renamed = true;
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toMatch(/^(?:EACCES|EPERM)$/);
    }

    if (renamed) {
      mkdirSync(collaboration);
      await expect(sink(event())).rejects.toThrow(/directory identity changed/);
      expect(readEvents(workspaceRoot)).toEqual([]);
      expect(readFileSync(join(original, 'events.jsonl'), 'utf8')).toBe('');
    } else {
      await sink(event());
      expect(readEvents(workspaceRoot)).toHaveLength(1);
    }
  });

  it('uses the governed audit event ID as an idempotent projection identity', async () => {
    const workspaceRoot = root();
    const sink = createGovernedPlanCollaborationAuditSink(workspaceRoot);
    await sink(event('workflow.approval_decided'));
    await sink(event('workflow.approval_decided'));

    expect(readEvents(workspaceRoot)).toEqual([
      expect.objectContaining({
        id: 'GAUDIT-workflow-approval-decided',
        type: 'workflow.approval.decided',
      }),
    ]);
  });
});
