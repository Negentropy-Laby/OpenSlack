import { describe, expect, it } from 'vitest';
import {
  buildDashboardProjection,
  renderDashboardProjection,
  renderDashboardMarkdown,
} from '../dashboard.js';
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
        event({
          type: 'task.created',
          object: { kind: 'issue', id: '7' },
          summary: 'Task created',
        }),
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
      events: [
        event({
          type: 'task.created',
          object: { kind: 'issue', id: '1' },
          summary: 'Task created',
        }),
      ],
    });
    const rendered = renderDashboardProjection(dashboard);
    expect(rendered).not.toContain('Getting Started');
  });

  it('filters by actor ID', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({
          type: 'task.created',
          actor: { id: 'agent_a', kind: 'agent', provider: 'cli' },
          object: { kind: 'issue', id: '1' },
        }),
        event({
          type: 'task.created',
          actor: { id: 'agent_b', kind: 'agent', provider: 'cli' },
          object: { kind: 'issue', id: '2' },
        }),
      ],
      filters: { actorId: 'agent_a' },
    });
    expect(dashboard.taskCounts['task.created']).toBe(1);
  });

  it('filters by source kind', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({
          type: 'task.created',
          source: { kind: 'operator', ref: 'test' },
          object: { kind: 'issue', id: '1' },
        }),
        event({
          type: 'task.created',
          source: { kind: 'prms', ref: 'test' },
          object: { kind: 'issue', id: '2' },
        }),
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
    const dashboard = buildDashboardProjection({
      events: [event({ type: 'task.created', object: { kind: 'issue', id: '1' } })],
    });
    expect(Array.isArray(dashboard.openHandoffDetails)).toBe(true);
    expect(Array.isArray(dashboard.activeDecisionDetails)).toBe(true);
  });
});

describe('renderDashboardMarkdown', () => {
  it('renders markdown with top-level heading', () => {
    const dashboard = buildDashboardProjection({ events: [] });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('# OpenSlack Team Dashboard');
  });

  it('renders summary as a markdown table', () => {
    const dashboard = buildDashboardProjection({ events: [] });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('## Summary');
    expect(md).toContain('| Metric | Count |');
    expect(md).toContain('| Blockers |');
    expect(md).toContain('| Open handoffs |');
    expect(md).toContain('| Active decisions |');
  });

  it('renders task counts as a markdown table', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({
          type: 'task.created',
          object: { kind: 'issue', id: '1' },
          summary: 'Task created',
        }),
        event({
          type: 'task.created',
          object: { kind: 'issue', id: '2' },
          summary: 'Another task',
        }),
      ],
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('## Tasks');
    expect(md).toContain('| Type | Count |');
    expect(md).toContain('| task.created | 2 |');
  });

  it('renders PR counts as a markdown table', () => {
    const dashboard = buildDashboardProjection({
      events: [event({ type: 'pr.opened' })],
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('## PRs');
    expect(md).toContain('| pr.opened | 1 |');
  });

  it('renders blockers with bold object and severity', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({ type: 'pr.doctor.blocked', severity: 'critical', summary: 'Tests failing' }),
      ],
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('## Blockers');
    expect(md).toContain('**pr:42**');
    expect(md).toContain('**[critical]**');
    expect(md).toContain('Tests failing');
  });

  it('renders blockers without severity', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({
          type: 'task.blocked',
          object: { kind: 'issue', id: '5' },
          summary: 'Blocked task',
        }),
      ],
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('**issue:5**');
    expect(md).not.toContain('[undefined]');
  });

  it('shows no blockers message when none exist', () => {
    const dashboard = buildDashboardProjection({ events: [] });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('*No blockers found.*');
  });

  it('renders recent activity as a markdown table', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({
          type: 'task.created',
          object: { kind: 'issue', id: '1' },
          summary: 'Created task',
        }),
      ],
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('## Recent Activity');
    expect(md).toContain('| Time | Type | Object | Summary | Actor |');
  });

  it('shows no recent activity message when empty', () => {
    const dashboard = buildDashboardProjection({ events: [] });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('*No recent activity.*');
  });

  it('shows getting started section when all sections empty', () => {
    const dashboard = buildDashboardProjection({ events: [] });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('## Getting Started');
    expect(md).toContain('```bash');
    expect(md).toContain('openslack pr doctor');
    expect(md).toContain('openslack status');
  });

  it('does not show getting started when events exist', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({ type: 'task.created', object: { kind: 'issue', id: '1' }, summary: 'Task' }),
      ],
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).not.toContain('## Getting Started');
  });

  it('includes window info in blockquote', () => {
    const dashboard = buildDashboardProjection({ events: [], sinceHours: 48 });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('> **Window:** 48h');
  });

  it('includes filter info when filters applied', () => {
    const dashboard = buildDashboardProjection({
      events: [],
      filters: { actorId: 'agent_a' },
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('> **Filters:**');
    expect(md).toContain('`actorId=agent_a`');
  });

  it('renders blocker owner and next action', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({
          type: 'pr.doctor.blocked',
          summary: 'PR blocked',
          nextAction: { owner: 'human', action: 'Fix tests' },
        }),
      ],
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).toContain('Owner:');
    expect(md).toContain('Next: Fix tests');
  });

  it('omits Tasks section when no task events', () => {
    const dashboard = buildDashboardProjection({
      events: [event({ type: 'pr.opened', summary: 'PR opened' })],
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).not.toContain('## Tasks');
  });

  it('omits PRs section when no PR events', () => {
    const dashboard = buildDashboardProjection({
      events: [
        event({ type: 'task.created', object: { kind: 'issue', id: '1' }, summary: 'Task' }),
      ],
    });
    const md = renderDashboardMarkdown(dashboard);
    expect(md).not.toContain('## PRs');
  });
});
