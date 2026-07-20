import { describe, it, expect } from 'vitest';
import { mapActivityToViewModel } from '../view-models/activity.js';
import type { CollaborationEvent } from '@openslack/collaboration';

function makeEvent(overrides?: Partial<CollaborationEvent>): CollaborationEvent {
  return {
    id: 'evt-1',
    schema: 'openslack.collaboration_event.v1',
    timestamp: new Date().toISOString(),
    type: 'task.claimed',
    actor: { id: 'agent-1', kind: 'agent' },
    object: { kind: 'issue', id: '101' },
    source: { kind: 'operator', ref: 'op-1' },
    summary: 'Agent claimed issue #101',
    visibility: 'workspace',
    redacted: false,
    containsSensitiveData: false,
    ...overrides,
  };
}

describe('mapActivityToViewModel', () => {
  it('maps events with all fields', () => {
    const now = new Date();
    const events: CollaborationEvent[] = [
      makeEvent({
        timestamp: now.toISOString(),
        type: 'task.claimed',
        summary: 'Claimed issue',
        actor: { id: 'codex-dev', kind: 'agent' },
        object: { kind: 'issue', id: '42' },
        owner: { id: 'codex-dev', kind: 'agent' },
        nextAction: { owner: 'human', action: 'Review PR' },
        risk: 'medium',
      }),
    ];
    const model = mapActivityToViewModel(events, 24);
    expect(model.title).toBe('Activity Feed');
    expect(model.periodHours).toBe(24);
    expect(model.totalEvents).toBe(1);
    expect(model.events).toHaveLength(1);
    expect(model.events[0].type).toBe('task.claimed');
    expect(model.events[0].summary).toBe('Claimed issue');
    expect(model.events[0].actor).toBe('codex-dev');
    expect(model.events[0].objectKind).toBe('issue');
    expect(model.events[0].objectId).toBe('42');
    expect(model.events[0].owner).toBe('codex-dev');
    expect(model.events[0].nextAction).toBe('Review PR');
    expect(model.events[0].risk).toBe('medium');
  });

  it('groups events by time bucket', () => {
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    const older = new Date(Date.now() - 3 * 86400000);

    const events: CollaborationEvent[] = [
      makeEvent({ timestamp: today.toISOString(), type: 'task.claimed' }),
      makeEvent({ timestamp: yesterday.toISOString(), type: 'pr.opened' }),
      makeEvent({ timestamp: older.toISOString(), type: 'handoff.created' }),
    ];
    const model = mapActivityToViewModel(events, 72);
    expect(model.today).toHaveLength(1);
    expect(model.yesterday).toHaveLength(1);
    expect(model.older).toHaveLength(1);
  });

  it('handles empty events', () => {
    const model = mapActivityToViewModel([], 24);
    expect(model.totalEvents).toBe(0);
    expect(model.events).toHaveLength(0);
    expect(model.today).toHaveLength(0);
  });

  it('sanitizes escape sequences', () => {
    const events: CollaborationEvent[] = [makeEvent({ summary: 'Bad\x1b[31m inject' })];
    const model = mapActivityToViewModel(events, 24);
    expect(model.events[0].summary).toBe('Bad inject');
  });
});
