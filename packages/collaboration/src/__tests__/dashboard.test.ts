import { describe, expect, it } from 'vitest';
import { buildDashboardProjection, renderDashboardProjection } from '../dashboard.js';
import type { CollaborationEvent } from '../types.js';

function event(overrides: Partial<CollaborationEvent>): CollaborationEvent {
  return {
    id: `EV-${Math.random()}`,
    schema: 'openslack.collaboration_event.v1',
    timestamp: new Date().toISOString(),
    type: 'pr.doctor.blocked',
    actor: { id: 'cli', kind: 'system', provider: 'cli' },
    object: { kind: 'pr', id: '42' },
    source: { kind: 'prms', ref: 'diagnosePR' },
    summary: 'PR blocked',
    visibility: 'local',
    redacted: false,
    containsSensitiveData: false,
    nextAction: { owner: 'human', action: 'Approve on GitHub' },
    ...overrides,
  } as CollaborationEvent;
}

describe('dashboard projection', () => {
  it('builds blocker and PR summaries from events', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({ type: 'pr.doctor.blocked' }),
        event({ type: 'task.created', object: { kind: 'issue', id: '7' }, summary: 'Task created' }),
      ],
    });

    expect(dashboard.blockerCount).toBe(1);
    expect(dashboard.prCounts['pr.doctor.blocked']).toBe(1);
    expect(dashboard.taskCounts['task.created']).toBe(1);
    expect(renderDashboardProjection(dashboard)).toContain('OpenSlack Team Dashboard');
  });
});

