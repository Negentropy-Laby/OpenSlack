import { describe, it, expect } from 'vitest';
import type { CollaborationEvent } from '../types.js';
import { groupEvents, getRecommendedNext, buildDigest, renderDigest } from '../digest.js';

function makeEvent(partial: Partial<CollaborationEvent>): CollaborationEvent {
  return {
    id: 'test-id',
    schema: 'openslack.collaboration_event.v1' as const,
    timestamp: '2026-05-24T10:00:00Z',
    type: 'task.created',
    actor: { id: 'test-actor', kind: 'system' as const },
    object: { kind: 'issue', id: 'TASK-1' },
    source: { kind: 'openslack' as const, ref: 'test' },
    summary: 'Test event',
    visibility: 'local' as const,
    redacted: false,
    containsSensitiveData: false,
    ...partial,
  } as CollaborationEvent;
}

describe('groupEvents', () => {
  it('groups completed events', () => {
    const events = [
      makeEvent({ type: 'task.done', summary: 'Task completed' }),
      makeEvent({ type: 'pr.doctor.ready', summary: 'PR ready' }),
      makeEvent({ type: 'task.created', summary: 'Other' }),
    ];

    const groups = groupEvents(events);
    const completed = groups.find((g) => g.label === 'Completed');

    expect(completed).toBeDefined();
    expect(completed!.events.length).toBe(2);
    expect(completed!.events.map((e) => e.type)).toContain('task.done');
    expect(completed!.events.map((e) => e.type)).toContain('pr.doctor.ready');
  });

  it('groups blocked events', () => {
    const events = [
      makeEvent({ type: 'task.blocked', summary: 'Blocked' }),
      makeEvent({ type: 'pr.doctor.blocked', summary: 'PR blocked' }),
      makeEvent({ type: 'task.done', summary: 'Done' }),
    ];

    const groups = groupEvents(events);
    const blocked = groups.find((g) => g.label === 'Blocked');

    expect(blocked).toBeDefined();
    expect(blocked!.events.length).toBe(2);
  });

  it('groups needs-human events', () => {
    const events = [
      makeEvent({
        type: 'pr.merge.requested',
        summary: 'Merge requested',
        nextAction: { owner: 'human', action: 'Review and merge' },
      }),
      makeEvent({ type: 'task.done', summary: 'Done' }),
    ];

    const groups = groupEvents(events);
    const needsHuman = groups.find((g) => g.label === 'Needs Human');

    expect(needsHuman).toBeDefined();
    expect(needsHuman!.events.length).toBe(1);
    expect(needsHuman!.events[0].type).toBe('pr.merge.requested');
  });

  it('groups agent activity', () => {
    const events = [
      makeEvent({ actor: { id: 'claude', kind: 'agent' }, summary: 'Agent did something' }),
      makeEvent({ actor: { id: 'user', kind: 'human' }, summary: 'Human did something' }),
    ];

    const groups = groupEvents(events);
    const agent = groups.find((g) => g.label === 'Agent Activity');

    expect(agent).toBeDefined();
    expect(agent!.events.length).toBe(1);
    expect(agent!.events[0].actor.kind).toBe('agent');
  });

  it('groups governance events', () => {
    const events = [
      makeEvent({ type: 'governance.audit.passed', summary: 'Audit passed' }),
      makeEvent({ type: 'governance.audit.failed', summary: 'Audit failed' }),
      makeEvent({ type: 'task.done', summary: 'Done' }),
    ];

    const groups = groupEvents(events);
    const gov = groups.find((g) => g.label === 'Governance');

    expect(gov).toBeDefined();
    expect(gov!.events.length).toBe(1);
    expect(gov!.events[0].type).toBe('governance.audit.passed');
  });

  it('blocked takes precedence over governance', () => {
    const events = [makeEvent({ type: 'governance.audit.failed', summary: 'Audit failed' })];

    const groups = groupEvents(events);
    const blocked = groups.find((g) => g.label === 'Blocked');
    const gov = groups.find((g) => g.label === 'Governance');

    expect(blocked).toBeDefined();
    expect(gov).toBeUndefined();
  });

  it('needs-human takes precedence over blocked', () => {
    const events = [
      makeEvent({
        type: 'task.blocked',
        summary: 'Blocked',
        nextAction: { owner: 'human', action: 'Fix it' },
      }),
    ];

    const groups = groupEvents(events);
    const needsHuman = groups.find((g) => g.label === 'Needs Human');
    const blocked = groups.find((g) => g.label === 'Blocked');

    expect(needsHuman).toBeDefined();
    expect(blocked).toBeUndefined();
  });

  it('returns empty array for no events', () => {
    expect(groupEvents([])).toEqual([]);
  });
});

describe('getRecommendedNext', () => {
  it('returns events with nextAction', () => {
    const events = [
      makeEvent({ nextAction: { owner: 'human', action: 'Do X' } }),
      makeEvent({}),
      makeEvent({ nextAction: { owner: 'agent', action: 'Do Y' } }),
    ];

    const next = getRecommendedNext(events);
    expect(next.length).toBe(2);
  });

  it('returns empty for no nextAction', () => {
    expect(getRecommendedNext([makeEvent({})])).toEqual([]);
  });
});

describe('buildDigest', () => {
  it('builds a complete digest', () => {
    const events = [
      makeEvent({ type: 'task.done', summary: 'Task completed' }),
      makeEvent({
        type: 'pr.merge.requested',
        summary: 'Merge requested',
        nextAction: { owner: 'human', action: 'Review and merge' },
      }),
    ];

    const digest = buildDigest(events, 24);
    expect(digest.periodHours).toBe(24);
    expect(digest.totalEvents).toBe(2);
    expect(digest.groups.length).toBeGreaterThan(0);
    expect(digest.recommendedNext.length).toBe(1);
  });
});

describe('renderDigest', () => {
  it('renders empty digest', () => {
    const digest = buildDigest([], 24);
    const output = renderDigest(digest);
    expect(output).toContain('No activity in this period');
  });

  it('renders digest with groups', () => {
    const events = [
      makeEvent({
        type: 'task.done',
        summary: 'Task completed',
        object: { kind: 'issue', id: 'TASK-1' },
      }),
      makeEvent({
        type: 'pr.merge.requested',
        summary: 'Merge requested',
        object: { kind: 'pr', id: '42' },
        nextAction: { owner: 'human', action: 'Review and merge' },
      }),
    ];

    const digest = buildDigest(events, 24);
    const output = renderDigest(digest);
    expect(output).toContain('OpenSlack Digest');
    expect(output).toContain('Completed');
    expect(output).toContain('Needs Human');
    expect(output).toContain('Recommended Next Actions');
    expect(output).toContain('Review and merge');
  });

  it('omits recommended next when empty', () => {
    const events = [makeEvent({ type: 'task.done', summary: 'Task completed' })];

    const digest = buildDigest(events, 24);
    const output = renderDigest(digest);
    expect(output).not.toContain('Recommended Next Actions');
  });
});
