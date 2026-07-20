import { describe, it, expect } from 'vitest';
import { mapDigestToViewModel } from '../view-models/digest.js';
import type { DigestSummary, CollaborationEvent } from '@openslack/collaboration';

function makeEvent(overrides?: Partial<CollaborationEvent>): CollaborationEvent {
  return {
    id: 'evt-1',
    schema: 'openslack.collaboration_event.v1',
    timestamp: '2026-05-27T12:00:00Z',
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

function makeDigest(overrides?: Partial<DigestSummary>): DigestSummary {
  return {
    periodHours: 24,
    totalEvents: 3,
    groups: [
      {
        label: 'Completed',
        events: [makeEvent({ type: 'task.done', summary: 'Task completed' })],
      },
      {
        label: 'Needs Human',
        events: [
          makeEvent({
            type: 'pr.merge.requested',
            summary: 'PR needs merge',
            nextAction: { owner: 'human', action: 'Approve merge' },
          }),
        ],
      },
      {
        label: 'Blocked',
        events: [makeEvent({ type: 'task.blocked', summary: 'Task blocked' })],
      },
    ],
    recommendedNext: [
      makeEvent({
        type: 'pr.merge.requested',
        nextAction: { owner: 'human', action: 'Approve PR #42' },
      }),
    ],
    ...overrides,
  };
}

describe('mapDigestToViewModel', () => {
  it('maps a full digest to view model', () => {
    const model = mapDigestToViewModel(makeDigest());
    expect(model.title).toBe('OpenSlack Digest');
    expect(model.periodHours).toBe(24);
    expect(model.totalEvents).toBe(3);
    expect(model.groups).toHaveLength(3);
    expect(model.groups[0].label).toBe('Completed');
    expect(model.groups[0].status).toBe('pass');
    expect(model.groups[1].label).toBe('Needs Human');
    expect(model.groups[1].status).toBe('warn');
    expect(model.groups[2].label).toBe('Blocked');
    expect(model.groups[2].status).toBe('fail');
  });

  it('maps recommended next actions', () => {
    const model = mapDigestToViewModel(makeDigest());
    expect(model.recommendedNext).toHaveLength(1);
    expect(model.recommendedNext[0].action).toBe('Approve PR #42');
  });

  it('handles empty digest', () => {
    const model = mapDigestToViewModel({
      periodHours: 24,
      totalEvents: 0,
      groups: [],
      recommendedNext: [],
    });
    expect(model.groups).toHaveLength(0);
    expect(model.recommendedNext).toHaveLength(0);
  });

  it('sanitizes escape sequences', () => {
    const model = mapDigestToViewModel(
      makeDigest({
        groups: [
          {
            label: 'Completed',
            events: [makeEvent({ summary: 'Bad\x1b[31m inject' })],
          },
        ],
        recommendedNext: [],
      }),
    );
    expect(model.groups[0].events[0].summary).toBe('Bad inject');
  });
});
