import { describe, it, expect } from 'vitest';
import { mapDashboardToViewModel } from '../view-models/dashboard.js';
import type { DashboardProjection } from '@openslack/collaboration';

function makeProjection(overrides?: Partial<DashboardProjection>): DashboardProjection {
  return {
    generatedAt: '2026-05-27T12:00:00Z',
    sinceHours: 24,
    taskCounts: { 'task.claimed': 5 },
    prCounts: { 'pr.doctor.passed': 3 },
    blockerCount: 2,
    blockers: [
      {
        object: 'pr:42',
        summary: 'Missing reviews',
        owner: 'alice',
        nextAction: 'Request review',
        severity: 'high',
      },
      { object: 'pr:99', summary: 'Merge conflict' },
    ],
    openHandoffs: 1,
    activeDecisions: 1,
    recentEvents: [
      {
        id: 'evt-1',
        schema: 'openslack.collaboration_event.v1',
        timestamp: '2026-05-27T11:00:00Z',
        type: 'task.claimed',
        actor: { id: 'agent-1', kind: 'agent' },
        object: { kind: 'issue', id: '101' },
        source: { kind: 'operator', ref: 'op-1' },
        summary: 'Agent claimed issue #101',
        visibility: 'workspace',
        redacted: false,
        containsSensitiveData: false,
      },
    ],
    openHandoffDetails: [
      {
        schema: 'openslack.handoff.v1',
        id: 'h-1',
        status: 'open',
        from: 'agent-1',
        to: 'agent-2',
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        context: 'Handoff for PR review',
        nextSteps: ['Review PR'],
      },
    ],
    activeDecisionDetails: [
      {
        schema: 'openslack.decision.v1',
        id: 'd-1',
        topic: 'Use React for TUI',
        decision: 'Adopted React + Ink',
        rationale: 'Better ecosystem',
        decidedBy: 'alice',
        createdAt: '2026-05-20T10:00:00Z',
        status: 'active',
      },
    ],
    appliedFilters: {},
    ...overrides,
  };
}

describe('mapDashboardToViewModel', () => {
  it('maps a full projection to a view model', () => {
    const model = mapDashboardToViewModel(makeProjection());
    expect(model.title).toBe('OpenSlack Team Dashboard');
    expect(model.summary.blockers).toBe(2);
    expect(model.summary.handoffs).toBe(1);
    expect(model.summary.decisions).toBe(1);
    expect(model.blockers).toHaveLength(2);
    expect(model.handoffs).toHaveLength(1);
    expect(model.decisions).toHaveLength(1);
    expect(model.recentActivity).toHaveLength(1);
  });

  it('sanitizes escape sequences from blocker summary', () => {
    const model = mapDashboardToViewModel(
      makeProjection({
        blockers: [{ object: 'pr:1', summary: 'Bad\x1b[31m inject' }],
      }),
    );
    expect(model.blockers[0].summary).toBe('Bad inject');
  });

  it('handles empty projection', () => {
    const model = mapDashboardToViewModel(
      makeProjection({
        blockerCount: 0,
        blockers: [],
        openHandoffs: 0,
        activeDecisions: 0,
        recentEvents: [],
        openHandoffDetails: [],
        activeDecisionDetails: [],
        taskCounts: {},
        prCounts: {},
      }),
    );
    expect(model.blockers).toHaveLength(0);
    expect(model.handoffs).toHaveLength(0);
    expect(model.decisions).toHaveLength(0);
    expect(model.recentActivity).toHaveLength(0);
  });

  it('maps blocker with all optional fields', () => {
    const model = mapDashboardToViewModel(
      makeProjection({
        blockers: [
          { object: 'pr:1', summary: 's', owner: 'bob', nextAction: 'Fix it', severity: 'high' },
        ],
      }),
    );
    expect(model.blockers[0].owner).toBe('bob');
    expect(model.blockers[0].nextAction).toBe('Fix it');
    expect(model.blockers[0].severity).toBe('high');
  });

  it('calculates handoff age', () => {
    const model = mapDashboardToViewModel(makeProjection());
    expect(model.handoffs[0].age).toBe('1h');
  });
});
