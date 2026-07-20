import { describe, it, expect } from 'vitest';
import {
  buildDashboardCard,
  buildDigestCard,
  buildRoomCard,
  buildActivityCard,
} from '../collaboration-cards.js';
import type {
  DashboardCardData,
  DigestCardData,
  RoomCardData,
  ActivityCardData,
} from '../collaboration-cards.js';
import { cardToText } from '../cards.js';

describe('buildDashboardCard', () => {
  it('produces a valid ChatCard with no blockers', () => {
    const data: DashboardCardData = {
      sinceHours: 24,
      blockerCount: 0,
      openHandoffs: 2,
      activeDecisions: 1,
      blockers: [],
    };
    const card = buildDashboardCard(data);
    expect(card.title).toBe('OpenSlack Team Dashboard');
    expect(card.summary).toContain('No blockers');
    expect(card.fields).toHaveLength(4);
    expect(card.actions).toEqual([]);
    expect(() => cardToText(card)).not.toThrow();
  });

  it('produces a valid ChatCard with blockers', () => {
    const data: DashboardCardData = {
      sinceHours: 12,
      blockerCount: 2,
      openHandoffs: 0,
      activeDecisions: 0,
      blockers: [
        { object: 'pr:42', summary: 'Checks failing' },
        { object: 'issue:7', summary: 'Unresolved', owner: 'human' },
      ],
    };
    const card = buildDashboardCard(data);
    expect(card.summary).toContain('2 blocker(s)');
    const text = cardToText(card);
    expect(text).toContain('Blockers');
    expect(text).toContain('2');
  });
});

describe('buildDigestCard', () => {
  it('produces a valid ChatCard with groups', () => {
    const data: DigestCardData = {
      sinceHours: 24,
      totalEvents: 10,
      groups: [
        { label: 'Completed', count: 5, items: ['PR merged', 'Task done'] },
        { label: 'Blocked', count: 2, items: ['PR stuck', 'Issue unresolved'] },
      ],
    };
    const card = buildDigestCard(data);
    expect(card.title).toBe('Collaboration Digest');
    expect(card.summary).toContain('10 events');
    expect(card.fields).toHaveLength(2);
    const text = cardToText(card);
    expect(text).toContain('Completed');
    expect(text).toContain('Blocked');
  });
});

describe('buildRoomCard', () => {
  it('produces a valid ChatCard with no blockers', () => {
    const data: RoomCardData = {
      roomId: 'pr:42',
      eventCount: 8,
      blockerCount: 0,
      handoffCount: 1,
      decisionCount: 2,
      blockers: [],
    };
    const card = buildRoomCard(data);
    expect(card.title).toBe('Room: pr:42');
    expect(card.summary).toContain('no blockers');
    expect(card.fields).toHaveLength(5);
    const text = cardToText(card);
    expect(text).toContain('pr:42');
  });

  it('produces a valid ChatCard with blockers', () => {
    const data: RoomCardData = {
      roomId: 'issue:7',
      eventCount: 3,
      blockerCount: 1,
      handoffCount: 0,
      decisionCount: 0,
      blockers: [{ object: 'issue:7', summary: 'Needs human review' }],
    };
    const card = buildRoomCard(data);
    expect(card.summary).toContain('1 active blocker(s)');
  });
});

describe('buildActivityCard', () => {
  it('produces a valid ChatCard with events', () => {
    const data: ActivityCardData = {
      eventCount: 15,
      sinceHours: 8,
      events: [
        { type: 'task.claimed', object: 'issue:1', summary: 'Agent claimed issue' },
        { type: 'pr.opened', object: 'pr:5', summary: 'New pull request opened by agent' },
      ],
    };
    const card = buildActivityCard(data);
    expect(card.title).toBe('Collaboration Activity');
    expect(card.summary).toContain('15 events');
    expect(card.fields).toHaveLength(2);
    const text = cardToText(card);
    expect(text).toContain('task.claimed');
  });

  it('truncates to 5 events max', () => {
    const data: ActivityCardData = {
      eventCount: 20,
      sinceHours: 24,
      events: Array.from({ length: 10 }, (_, i) => ({
        type: 'event',
        object: `obj:${i}`,
        summary: `Event ${i}`,
      })),
    };
    const card = buildActivityCard(data);
    expect(card.fields).toHaveLength(5);
  });
});
