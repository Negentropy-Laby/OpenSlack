import { describe, it, expect } from 'vitest';
import {
  formatActivityEvent,
  renderActivityFeed,
  getRecentEvents,
  filterEvents,
} from '../activity.js';
import type { CollaborationEvent, CollaborationEventType } from '../types.js';

describe('activity', () => {
  function makeEvent(partial: Partial<CollaborationEvent> = {}): CollaborationEvent {
    const base = {
      id: 'EV-20260524-TEST0001',
      schema: 'openslack.collaboration_event.v1' as const,
      timestamp: '2026-05-24T10:30:00Z',
      type: 'pr.doctor.ready' as CollaborationEventType,
      actor: { id: 'system', kind: 'system' as const },
      object: { kind: 'pr' as const, id: '42' },
      source: { kind: 'prms' as const, ref: 'doctor' },
      summary: 'PR #42 is ready to merge',
      visibility: 'local' as const,
      redacted: false,
      containsSensitiveData: false,
    };
    return { ...base, ...partial } as unknown as CollaborationEvent;
  }

  it('formats a basic event', () => {
    const event = makeEvent();
    const formatted = formatActivityEvent(event);
    expect(formatted).toContain('10:30');
    expect(formatted).toContain('pr.doctor.ready');
    expect(formatted).toContain('PR #42 is ready to merge');
  });

  it('formats event with owner', () => {
    const event = makeEvent({ owner: { id: 'wsman', kind: 'human' } });
    const formatted = formatActivityEvent(event);
    expect(formatted).toContain('Owner: human:wsman');
  });

  it('formats event with next action', () => {
    const event = makeEvent({
      nextAction: { owner: 'wsman', action: 'Review PR on GitHub' },
    });
    const formatted = formatActivityEvent(event);
    expect(formatted).toContain('Next: wsman');
    expect(formatted).toContain('Review PR on GitHub');
  });

  it('formats event with risk', () => {
    const event = makeEvent({ risk: 'high' });
    const formatted = formatActivityEvent(event);
    expect(formatted).toContain('Risk: high');
  });

  it('formats event without risk when none', () => {
    const event = makeEvent({ risk: 'none' });
    const formatted = formatActivityEvent(event);
    expect(formatted).not.toContain('Risk:');
  });

  it('renders empty feed', () => {
    const output = renderActivityFeed([]);
    expect(output).toBe('No events found.');
  });

  it('renders activity feed with header', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.ready', summary: 'Ready' }),
      makeEvent({ type: 'pr.doctor.blocked', summary: 'Blocked' }),
    ];
    const output = renderActivityFeed(events);
    expect(output).toContain('OpenSlack Activity');
    expect(output).toContain('pr.doctor.ready');
    expect(output).toContain('pr.doctor.blocked');
  });

  it('filters recent events by hours', () => {
    const now = Date.now();
    const events = [
      makeEvent({ timestamp: new Date(now - 30 * 60 * 1000).toISOString() }), // 30 min ago
      makeEvent({ timestamp: new Date(now - 90 * 60 * 1000).toISOString() }), // 90 min ago
      makeEvent({ timestamp: new Date(now - 3 * 60 * 60 * 1000).toISOString() }), // 3 hours ago
    ];

    const recent = getRecentEvents(1, events);
    expect(recent).toHaveLength(1);
    expect(recent[0].timestamp).toBe(events[0].timestamp);
  });

  it('filters events by multiple types', () => {
    const events = [
      makeEvent({ type: 'pr.doctor.ready' }),
      makeEvent({ type: 'pr.doctor.blocked' }),
      makeEvent({ type: 'plan.created' as CollaborationEventType }),
      makeEvent({ type: 'chat.message.received' }),
    ];

    const filtered = filterEvents(events, {
      type: ['pr.doctor.ready', 'pr.doctor.blocked'],
    });
    expect(filtered).toHaveLength(2);
    expect(filtered[0].type).toBe('pr.doctor.ready');
    expect(filtered[1].type).toBe('pr.doctor.blocked');
  });

  it('filters events by source kind', () => {
    const events = [
      makeEvent({ source: { kind: 'prms', ref: 'doctor' } }),
      makeEvent({ source: { kind: 'governance', ref: 'audit' } }),
      makeEvent({ source: { kind: 'operator', ref: 'planner' } }),
    ];

    const filtered = filterEvents(events, { sourceKind: 'governance' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].source.kind).toBe('governance');
  });
});
