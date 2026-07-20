import { describe, it, expect } from 'vitest';
import { mapDecisionListToViewModel, mapDecisionToViewModel } from '../view-models/decision.js';
import type { Decision } from '@openslack/collaboration';

function makeDecision(overrides?: Partial<Decision>): Decision {
  return {
    schema: 'openslack.decision.v1',
    id: 'DEC-20260527-ABCD',
    topic: 'Use React for TUI',
    decision: 'Adopted React + Ink',
    rationale: 'Better ecosystem',
    decidedBy: 'alice',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    status: 'active',
    alternatives: ['Vue', 'Svelte'],
    consequences: ['Learning curve', 'Rich ecosystem'],
    tags: ['frontend', 'architecture'],
    ...overrides,
  };
}

describe('mapDecisionListToViewModel', () => {
  it('maps decisions with correct counts', () => {
    const decisions = [
      makeDecision(),
      makeDecision({
        status: 'superseded',
        id: 'DEC-20260527-EFGH',
        supersededBy: 'DEC-20260527-IJKL',
      }),
    ];
    const model = mapDecisionListToViewModel(decisions);
    expect(model.title).toBe('Decisions');
    expect(model.totalCount).toBe(2);
    expect(model.activeCount).toBe(1);
    expect(model.items).toHaveLength(2);
    // Active should come first
    expect(model.items[0].status).toBe('active');
    expect(model.items[0].age).toBe('1h');
  });

  it('handles empty list', () => {
    const model = mapDecisionListToViewModel([]);
    expect(model.totalCount).toBe(0);
    expect(model.activeCount).toBe(0);
    expect(model.items).toHaveLength(0);
  });

  it('sanitizes escape sequences', () => {
    const model = mapDecisionListToViewModel([makeDecision({ topic: 'Bad\x1b[31m inject' })]);
    expect(model.items[0].topic).toBe('Bad inject');
  });
});

describe('mapDecisionToViewModel', () => {
  it('maps full decision detail', () => {
    const decision = makeDecision();
    const model = mapDecisionToViewModel(decision);
    expect(model.id).toBe('DEC-20260527-ABCD');
    expect(model.topic).toBe('Use React for TUI');
    expect(model.decision).toBe('Adopted React + Ink');
    expect(model.rationale).toBe('Better ecosystem');
    expect(model.decidedBy).toBe('alice');
    expect(model.status).toBe('active');
    expect(model.alternatives).toEqual(['Vue', 'Svelte']);
    expect(model.consequences).toEqual(['Learning curve', 'Rich ecosystem']);
    expect(model.tags).toEqual(['frontend', 'architecture']);
  });

  it('maps superseded decision', () => {
    const model = mapDecisionToViewModel(
      makeDecision({
        status: 'superseded',
        supersededBy: 'DEC-NEW',
        supersededAt: '2026-05-28T10:00:00Z',
      }),
    );
    expect(model.status).toBe('superseded');
    expect(model.supersededBy).toBe('DEC-NEW');
    expect(model.supersededAt).toBe('2026-05-28T10:00:00Z');
  });

  it('handles empty alternatives and consequences', () => {
    const model = mapDecisionToViewModel(
      makeDecision({ alternatives: undefined, consequences: undefined }),
    );
    expect(model.alternatives).toEqual([]);
    expect(model.consequences).toEqual([]);
  });

  it('sanitizes escape sequences', () => {
    const model = mapDecisionToViewModel(makeDecision({ rationale: 'Bad\x1b[31m inject' }));
    expect(model.rationale).toBe('Bad inject');
  });
});
