import { describe, expect, it } from 'vitest';
import {
  buildBusinessOutcomeProjection,
  renderBusinessOutcomeMarkdown,
  renderBusinessOutcomeProjection,
  validateBusinessOutcomeSourceSnapshot,
  validateBusinessOutcomeProjection,
} from '../business-outcomes.js';
import type { BusinessOutcomeSourceSnapshot } from '../business-outcomes.js';
import type { CollaborationEvent, CollaborationEventType } from '../types.js';

const FROM = '2026-07-01T00:00:00.000Z';
const TO = '2026-07-31T23:59:59.999Z';

function event(
  id: string,
  type: CollaborationEventType | 'task.completed',
  objectId: string,
  timestamp: string,
  overrides: Partial<CollaborationEvent> = {},
): CollaborationEvent {
  return {
    id,
    schema: 'openslack.collaboration_event.v1',
    timestamp,
    type,
    actor: { id: 'system', kind: 'system', provider: 'cli' },
    object: { kind: 'issue', id: objectId },
    source: { kind: 'openslack', ref: id },
    summary: type,
    visibility: 'local',
    redacted: false,
    containsSensitiveData: false,
    ...overrides,
  } as CollaborationEvent;
}

function snapshot(
  overrides: Partial<BusinessOutcomeSourceSnapshot> = {},
): BusinessOutcomeSourceSnapshot {
  return {
    generatedAt: TO,
    period: { from: FROM, to: TO },
    events: [],
    evidenceRefs: ['events:test-fixture#2026-07'],
    ...overrides,
  };
}

describe('buildBusinessOutcomeProjection', () => {
  it('aggregates observed task, PRMS, agent, workflow, and direct-notification evidence', () => {
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        events: [
          event('created-1', 'task.created', '1', '2026-07-02T00:00:00.000Z'),
          event('done-1', 'task.done', '1', '2026-07-02T06:00:00.000Z'),
          event('created-2', 'task.created', '2', '2026-07-03T00:00:00.000Z'),
          event('pr-ready', 'pr.doctor.ready', '42', '2026-07-04T00:00:00.000Z', {
            object: { kind: 'pr', id: '42' },
            source: { kind: 'prms', ref: 'doctor:42' },
          }),
          event(
            'agent-start',
            'agent.conversation.started',
            'roi-analyst',
            '2026-07-05T00:00:00.000Z',
            { actor: { id: 'roi-analyst', kind: 'agent' }, object: { kind: 'agent', id: 'run-1' } },
          ),
          event(
            'agent-action',
            'operator.execution.completed',
            'plan-1',
            '2026-07-05T01:00:00.000Z',
            { actor: { id: 'roi-analyst', kind: 'agent' }, object: { kind: 'plan', id: 'plan-1' } },
          ),
          event('workflow-start', 'workflow.started', 'run-1', '2026-07-05T00:00:00.000Z', {
            object: { kind: 'workflow', id: 'run-1' },
          }),
          event(
            'notification-approval',
            'notification.sent',
            'approval-1',
            '2026-07-06T00:00:00.000Z',
            {
              metadata: { subject: 'approval.required' },
              object: { kind: 'workflow', id: 'run-1' },
            },
          ),
        ],
        observed: {
          currentHeadHumanApprovals: {
            value: 1,
            evidenceRefs: ['prms:pr-42@head-abcd#approval-human'],
          },
          reviewsExcludingApprovals: {
            value: 2,
            evidenceRefs: ['prms:pr-42@head-abcd#reviews-excluding-approvals'],
          },
          activeAgents: {
            value: 6,
            evidenceRefs: ['registry:snapshot@2026-07-31T23:59:59.999Z'],
          },
        },
      }),
    );

    expect(projection.schema).toBe('openslack.business_outcome.v1');
    expect(projection.work.created.value).toBe(2);
    expect(projection.work.completed.value).toBe(1);
    expect(projection.work.completionRate.value).toBe(0.5);
    expect(projection.work.averageCycleHours.value).toBe(6);
    expect(projection.governance.humanApprovals.value).toBe(1);
    expect(projection.governance.humanInterventions.value).toBe(3);
    expect(projection.governance.prFirstPassRate.value).toBe(1);
    expect(projection.agents.agentRuns.value).toBe(1);
    expect(projection.agents.agentActions.value).toBe(1);
    expect(projection.agents.activeAgents.value).toBe(6);
    expect(projection.reuse.workflowRuns.value).toBe(1);
    expect(projection.notifications.approvalNotifications.value).toBe(1);
    expect(projection.notifications.accepted.value).toBeNull();
    expect(projection.notifications.accepted.basis).toBe('unknown');
  });

  it('preserves configured-estimate basis and propagates it to cost per completed item', () => {
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        events: [
          event('created-1', 'task.created', '1', '2026-07-02T00:00:00.000Z'),
          event('done-1', 'task.done', '1', '2026-07-02T04:00:00.000Z'),
        ],
        estimates: {
          agentRuntimeCost: {
            value: 20,
            unit: 'USD',
            assumptionRef: 'repo:examples/assumptions.yaml#agentRuntimeCost',
            assumptionVersion: '2026-07-26',
          },
          estimatedManualHours: {
            value: 120,
            unit: 'hours',
            assumptionRef: 'repo:examples/assumptions.yaml#estimatedManualHours',
            assumptionVersion: '2026-07-26',
          },
        },
      }),
    );

    expect(projection.economics.agentRuntimeCost.basis).toBe('configured_estimate');
    expect(projection.economics.estimatedManualHours.value).toBe(120);
    expect(projection.economics.costPerCompletedItem.value).toBe(20);
    expect(projection.economics.costPerCompletedItem.basis).toBe('configured_estimate');
    expect(projection.economics.costPerCompletedItem.evidenceRefs).toContain(
      'repo:examples/assumptions.yaml#agentRuntimeCost@2026-07-26',
    );
  });

  it('marks unsupported facts unknown instead of inferring approvals, acceptance, or delivery', () => {
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        events: [
          event('comment', 'pr.review.commented', '42', '2026-07-02T00:00:00.000Z', {
            actor: { id: 'reviewer', kind: 'human', provider: 'github' },
            object: { kind: 'pr', id: '42' },
            source: { kind: 'prms', ref: 'review:42' },
          }),
          event('notification', 'notification.sent', 'approval', '2026-07-02T01:00:00.000Z', {
            metadata: { subject: 'approval.required' },
          }),
        ],
      }),
    );

    expect(projection.governance.humanApprovals.value).toBeNull();
    expect(projection.governance.humanApprovals.basis).toBe('unknown');
    expect(projection.notifications.approvalNotifications.value).toBe(1);
    expect(projection.notifications.accepted.value).toBeNull();
    expect(projection.notifications.delivered.value).toBeNull();
    expect(projection.gaps).toContain('governance.humanApprovals');
    expect(projection.gaps).toContain('notifications.accepted');
    expect(projection.gaps).toContain('notifications.delivered');
  });

  it('only aggregates separately valid evidence-backed human intervention counts', () => {
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        observed: {
          currentHeadHumanApprovals: {
            value: 4,
            evidenceRefs: [],
          },
          reviewsExcludingApprovals: {
            value: 2,
            evidenceRefs: ['prms:pr-42@head-abcd#reviews-excluding-approvals'],
          },
        },
      }),
    );

    expect(projection.governance.humanApprovals).toMatchObject({
      value: null,
      basis: 'unknown',
      evidenceRefs: [],
    });
    expect(projection.governance.humanInterventions).toMatchObject({
      value: 2,
      basis: 'observed',
      evidenceRefs: ['prms:pr-42@head-abcd#reviews-excluding-approvals'],
    });
    expect(projection.governance.humanInterventions.note).toContain('approval input was excluded');

    const allInvalid = buildBusinessOutcomeProjection(
      snapshot({
        observed: {
          currentHeadHumanApprovals: {
            value: -1,
            evidenceRefs: ['prms:pr-42@head-abcd#approval-human'],
          },
          reviewsExcludingApprovals: {
            value: 1.5,
            evidenceRefs: ['prms:pr-42@head-abcd#reviews-excluding-approvals'],
          },
        },
      }),
    );
    expect(allInvalid.governance.humanApprovals.basis).toBe('unknown');
    expect(allInvalid.governance.humanInterventions).toMatchObject({
      value: null,
      basis: 'unknown',
      evidenceRefs: [],
    });
  });

  it('excludes an otherwise valid review count when its evidence overlaps approval evidence', () => {
    const sharedEvidence = 'prms:pr-42@head-abcd#human-review';
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        observed: {
          currentHeadHumanApprovals: {
            value: 1,
            evidenceRefs: [sharedEvidence],
          },
          reviewsExcludingApprovals: {
            value: 3,
            evidenceRefs: [` ${sharedEvidence} `],
          },
        },
      }),
    );

    expect(projection.governance.humanApprovals.value).toBe(1);
    expect(projection.governance.humanInterventions).toMatchObject({
      value: 1,
      basis: 'observed',
      evidenceRefs: [sharedEvidence],
    });
    expect(projection.governance.humanInterventions.note).toContain(
      'review intervention input was excluded',
    );
  });

  it('does not accept task.completed and leaves a missing task.done pair incomplete', () => {
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        events: [
          event('created', 'task.created', '1', '2026-07-02T00:00:00.000Z'),
          event('invalid-complete', 'task.completed', '1', '2026-07-02T02:00:00.000Z'),
          event('orphan-done', 'task.done', '2', '2026-07-02T03:00:00.000Z'),
        ],
      }),
    );

    expect(projection.work.created.value).toBe(1);
    expect(projection.work.completed.value).toBe(0);
    expect(projection.work.completionRate.value).toBe(0);
    expect(projection.work.averageCycleHours.value).toBeNull();
  });

  it('reports an empty period without inventing nullable values', () => {
    const projection = buildBusinessOutcomeProjection(snapshot());

    expect(projection.work.created).toMatchObject({ value: 0, basis: 'observed' });
    expect(projection.work.completed).toMatchObject({ value: 0, basis: 'observed' });
    expect(projection.work.completionRate).toMatchObject({ value: null, basis: 'unknown' });
    expect(projection.agents.agentRuns).toMatchObject({ value: 0, basis: 'observed' });
    expect(projection.economics.agentRuntimeCost).toMatchObject({
      value: null,
      basis: 'unknown',
    });
    expect(projection.evidenceRefs).toContain('events:test-fixture#2026-07');
  });

  it('isolates events by explicit scenario metadata', () => {
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        scenario: 'manufacturing-ai-90-day-pilot',
        events: [
          event('wanted', 'task.created', '1', '2026-07-02T00:00:00.000Z', {
            metadata: { scenarioId: 'manufacturing-ai-90-day-pilot' },
          }),
          event('other', 'task.created', '2', '2026-07-02T00:00:00.000Z', {
            metadata: { scenarioId: 'another-scenario' },
          }),
          event('unscoped', 'task.created', '3', '2026-07-02T00:00:00.000Z'),
        ],
      }),
    );

    expect(projection.work.created.value).toBe(1);
    expect(projection.work.created.evidenceRefs).toContain('event:wanted');
    expect(projection.work.created.evidenceRefs).not.toContain('event:other');
    expect(projection.work.created.evidenceRefs).not.toContain('event:unscoped');
  });

  it('deduplicates repeated event IDs before aggregating metrics', () => {
    const duplicate = event('same-id', 'task.created', '1', '2026-07-02T00:00:00.000Z');
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        events: [duplicate, { ...duplicate }],
      }),
    );

    expect(projection.work.created.value).toBe(1);
    expect(
      projection.work.created.evidenceRefs.filter((ref) => ref === 'event:same-id'),
    ).toHaveLength(1);
  });

  it('filters by period and scenario before deduplicating event IDs', () => {
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        scenario: 'manufacturing-ai-90-day-pilot',
        events: [
          event('same-id', 'task.created', 'outside-period', '2026-06-30T23:59:59.999Z', {
            metadata: { scenarioId: 'manufacturing-ai-90-day-pilot' },
          }),
          event('same-id', 'task.created', 'other-scenario', '2026-07-02T00:00:00.000Z', {
            metadata: { scenarioId: 'other-scenario' },
          }),
          event('same-id', 'task.created', 'wanted', '2026-07-03T00:00:00.000Z', {
            metadata: { scenarioId: 'manufacturing-ai-90-day-pilot' },
          }),
        ],
      }),
    );

    expect(projection.work.created.value).toBe(1);
    expect(projection.work.created.evidenceRefs).toContain('event:same-id');
  });

  it('fails closed when timestamps, period ordering, or bounded query evidence are invalid', () => {
    expect(
      validateBusinessOutcomeSourceSnapshot(
        snapshot({ generatedAt: 'not-a-date', evidenceRefs: [] }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'generatedAt must be a canonical ISO-8601 UTC timestamp.',
        'evidenceRefs must contain at least one non-empty bounded source-query reference.',
      ]),
    );

    expect(() =>
      buildBusinessOutcomeProjection(
        snapshot({
          period: { from: TO, to: FROM },
        }),
      ),
    ).toThrow('period.from must be before or equal to period.to');

    expect(() =>
      buildBusinessOutcomeProjection(
        snapshot({
          generatedAt: '2026-07-31T23:59:59.998Z',
        }),
      ),
    ).toThrow('period.to must be before or equal to generatedAt');
  });

  it('uses injected durable notification evidence without treating direct send as acceptance', () => {
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        observed: {
          notificationAccepted: {
            value: 3,
            evidenceRefs: ['notification-receipt:queue-1'],
          },
          notificationDelivered: {
            value: 2,
            evidenceRefs: ['notification-reconcile:queue-1'],
          },
        },
      }),
    );
    expect(projection.notifications.accepted).toMatchObject({ value: 3, basis: 'observed' });
    expect(projection.notifications.delivered).toMatchObject({ value: 2, basis: 'observed' });
  });

  it('deduplicates reuse IDs and rejects empty reuse identifiers', () => {
    const projection = buildBusinessOutcomeProjection(
      snapshot({
        reuse: {
          reusedWorkflowRunIds: {
            value: ['run-2', 'run-1', 'run-2', ' run-1 '],
            evidenceRefs: ['workflow-store:runs'],
          },
          exportedSkillIds: {
            value: ['skill-1', ''],
            evidenceRefs: ['workflow-store:skills'],
          },
        },
      }),
    );

    expect(projection.reuse.workflowReuseCount).toMatchObject({
      value: 2,
      basis: 'observed',
    });
    expect(projection.reuse.exportedSkills).toMatchObject({
      value: 0,
      basis: 'unknown',
      evidenceRefs: [],
    });
  });

  it('renders plain and Markdown output with basis and evidence references', () => {
    const projection = buildBusinessOutcomeProjection(snapshot());
    const plain = renderBusinessOutcomeProjection(projection);
    const markdown = renderBusinessOutcomeMarkdown(projection);

    expect(plain).toContain('OpenSlack Business Outcomes');
    expect(plain).toContain('[observed]');
    expect(plain).toContain('Evidence gaps:');
    expect(plain).toContain('events:test-fixture#2026-07');
    expect(markdown).toContain('# OpenSlack Business Outcomes');
    expect(markdown).toContain('| Metric | Value | Basis | Evidence |');
    expect(markdown).toContain('`events:test-fixture#2026-07`');
    expect(markdown).not.toContain('configured_estimate');
  });

  it('runtime-validates the full v1 projection contract and its evidence invariant', () => {
    const projection = buildBusinessOutcomeProjection(snapshot());
    expect(validateBusinessOutcomeProjection(JSON.parse(JSON.stringify(projection)))).toEqual({
      valid: true,
      errors: [],
    });

    const invalid = structuredClone(projection) as unknown as {
      schema: string;
      work: { created: { evidenceRefs: string[] } };
    };
    invalid.schema = 'openslack.business_outcome.v2';
    invalid.work.created.evidenceRefs = [];
    (invalid as unknown as { generatedAt: string }).generatedAt = '2026-07-31T23:59:59.998Z';
    const validation = validateBusinessOutcomeProjection(invalid);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        'schema must be openslack.business_outcome.v1.',
        'work.created requires evidence for observed basis.',
        'period.to must be before or equal to generatedAt.',
      ]),
    );
  });
});
