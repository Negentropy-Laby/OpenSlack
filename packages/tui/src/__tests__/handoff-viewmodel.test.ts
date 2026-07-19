import { describe, it, expect } from 'vitest';
import { mapHandoffListToViewModel, mapHandoffToViewModel } from '../view-models/handoff.js';
import type { Handoff } from '@openslack/collaboration';

function makeHandoff(overrides?: Partial<Handoff>): Handoff {
  return {
    schema: 'openslack.handoff.v1',
    id: 'HANDOFF-20260527-ABCD',
    status: 'open',
    from: 'agent-1',
    to: 'agent-2',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    context: 'Handoff for PR review',
    nextSteps: ['Review PR', 'Add tests'],
    ...overrides,
  };
}

describe('mapHandoffListToViewModel', () => {
  it('maps handoffs with correct counts', () => {
    const handoffs = [
      makeHandoff(),
      makeHandoff({ status: 'closed', id: 'HANDOFF-20260527-EFGH' }),
    ];
    const model = mapHandoffListToViewModel(handoffs);
    expect(model.title).toBe('Handoffs');
    expect(model.totalCount).toBe(2);
    expect(model.openCount).toBe(1);
    expect(model.items).toHaveLength(2);
    // Open should come first
    expect(model.items[0].status).toBe('open');
    expect(model.items[0].age).toBe('1h');
  });

  it('handles empty list', () => {
    const model = mapHandoffListToViewModel([]);
    expect(model.totalCount).toBe(0);
    expect(model.openCount).toBe(0);
    expect(model.items).toHaveLength(0);
  });

  it('sanitizes escape sequences', () => {
    const model = mapHandoffListToViewModel([makeHandoff({ context: 'Bad\x1b[31m inject' })]);
    expect(model.items[0].context).toBe('Bad inject');
  });

  it('shows issue ref when available', () => {
    const model = mapHandoffListToViewModel([makeHandoff({ issueRef: '42' })]);
    expect(model.items[0].ref).toBe('issue:42');
  });

  it('shows pr ref when available', () => {
    const model = mapHandoffListToViewModel([makeHandoff({ prRef: '99', issueRef: undefined })]);
    expect(model.items[0].ref).toBe('pr:99');
  });
});

describe('mapHandoffToViewModel', () => {
  it('maps full handoff detail', () => {
    const handoff = makeHandoff({
      acceptedAt: new Date().toISOString(),
      notes: 'Some notes',
    });
    const model = mapHandoffToViewModel(handoff);
    expect(model.id).toBe('HANDOFF-20260527-ABCD');
    expect(model.status).toBe('open');
    expect(model.from).toBe('agent-1');
    expect(model.to).toBe('agent-2');
    expect(model.canAccept).toBe(true);
    expect(model.canClose).toBe(true);
    expect(model.acceptedAt).toBeDefined();
    expect(model.notes).toBe('Some notes');
    expect(model.nextSteps).toEqual(['Review PR', 'Add tests']);
  });

  it('closed handoff cannot be accepted', () => {
    const model = mapHandoffToViewModel(makeHandoff({ status: 'closed' }));
    expect(model.canAccept).toBe(false);
    expect(model.canClose).toBe(false);
  });

  it('sanitizes escape sequences', () => {
    const model = mapHandoffToViewModel(makeHandoff({ context: 'Bad\x1b[31m inject' }));
    expect(model.context).toBe('Bad inject');
  });
});
