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

  it('shows getting started guidance when all sections are empty', () => {
    const dashboard = buildDashboardProjection({ events: [] });
    const rendered = renderDashboardProjection(dashboard);
    expect(rendered).toContain('Getting Started');
    expect(rendered).toContain('openslack pr doctor');
    expect(rendered).toContain('openslack collaboration handoff create');
    expect(rendered).toContain('openslack status');
  });

  it('does not show getting started guidance when events exist', () => {
    const dashboard = buildDashboardProjection({
      events: [event({ type: 'task.created', object: { kind: 'issue', id: '1' }, summary: 'Task created' })],
    });
    const rendered = renderDashboardProjection(dashboard);
    expect(rendered).not.toContain('Getting Started');
  });

  it('filters by actor ID', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({ type: 'task.created', actor: { id: 'agent_a', kind: 'agent', provider: 'cli' }, object: { kind: 'issue', id: '1' } }),
        event({ type: 'task.created', actor: { id: 'agent_b', kind: 'agent', provider: 'cli' }, object: { kind: 'issue', id: '2' } }),
      ],
      filters: { actorId: 'agent_a' },
    });
    expect(dashboard.taskCounts['task.created']).toBe(1);
  });

  it('filters by source kind', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({ type: 'task.created', source: { kind: 'operator', ref: 'test' }, object: { kind: 'issue', id: '1' } }),
        event({ type: 'task.created', source: { kind: 'prms', ref: 'test' }, object: { kind: 'issue', id: '2' } }),
      ],
      filters: { sourceKind: 'prms' },
    });
    expect(dashboard.taskCounts['task.created']).toBe(1);
  });

  it('filters by risk level', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({ type: 'pr.merge.blocked', risk: 'high' as const }),
        event({ type: 'pr.merge.blocked', risk: 'low' as const }),
      ],
      filters: { risk: 'high' },
    });
    expect(dashboard.blockerCount).toBe(1);
  });

  it('includes handoff and decision details', () => {
    const dashboard = buildDashboardProjection({ events: [event({ type: 'task.created', object: { kind: 'issue', id: '1' } })] });
    expect(Array.isArray(dashboard.openHandoffDetails)).toBe(true);
    expect(Array.isArray(dashboard.activeDecisionDetails)).toBe(true);
  });
});

