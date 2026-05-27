import { describe, it, expect } from 'vitest'
import { mapRoomToViewModel } from '../view-models/room.js'
import type { RoomView } from '@openslack/collaboration'
import type { CollaborationEvent } from '@openslack/collaboration'

function makeEvent(overrides?: Partial<CollaborationEvent>): CollaborationEvent {
  return {
    id: 'evt-1',
    schema: 'openslack.collaboration_event.v1',
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    type: 'task.claimed',
    actor: { id: 'agent-1', kind: 'agent' },
    object: { kind: 'issue', id: '101' },
    source: { kind: 'operator', ref: 'op-1' },
    summary: 'Agent claimed issue #101',
    visibility: 'workspace',
    redacted: false,
    containsSensitiveData: false,
    ...overrides,
  }
}

function makeRoomView(overrides?: Partial<RoomView>): RoomView {
  return {
    roomId: 'pr:42',
    objectKind: 'pr',
    objectId: '42',
    sourceUrl: 'https://github.com/org/repo/pull/42',
    recentEvents: [makeEvent()],
    blockers: [],
    owner: 'human:alice',
    nextAction: 'alice — Review changes',
    linkedDecisions: [],
    linkedHandoffs: [],
    ...overrides,
  }
}

describe('mapRoomToViewModel', () => {
  it('maps a full room view to view model', () => {
    const model = mapRoomToViewModel(makeRoomView())
    expect(model.roomId).toBe('pr:42')
    expect(model.objectKind).toBe('pr')
    expect(model.objectId).toBe('42')
    expect(model.sourceUrl).toBe('https://github.com/org/repo/pull/42')
    expect(model.owner).toBe('human:alice')
    expect(model.nextAction).toBe('alice — Review changes')
    expect(model.blockerCount).toBe(0)
    expect(model.recentActivity).toHaveLength(1)
  })

  it('sanitizes escape sequences from fields', () => {
    const model = mapRoomToViewModel(makeRoomView({
      roomId: 'pr:\x1b[31m42',
      blockers: [makeEvent({ type: 'task.blocked', summary: 'Bad\x1b[31m inject' })],
    }))
    expect(model.roomId).toBe('pr:42')
    expect(model.blockers[0].summary).toBe('Bad inject')
  })

  it('handles room with no optional fields', () => {
    const model = mapRoomToViewModel(makeRoomView({
      sourceUrl: undefined,
      owner: undefined,
      nextAction: undefined,
      recentEvents: [],
      blockers: [],
    }))
    expect(model.sourceUrl).toBe('')
    expect(model.owner).toBe('')
    expect(model.nextAction).toBe('')
    expect(model.recentActivity).toHaveLength(0)
    expect(model.blockerCount).toBe(0)
  })

  it('maps blockers with capped count', () => {
    const blockers = Array.from({ length: 8 }, (_, i) =>
      makeEvent({ type: 'task.blocked', summary: `Blocker ${i}` }),
    )
    const model = mapRoomToViewModel(makeRoomView({ blockers }))
    expect(model.blockerCount).toBe(8)
    expect(model.blockers).toHaveLength(5)
  })

  it('maps linked handoffs and decisions', () => {
    const model = mapRoomToViewModel(makeRoomView({
      linkedHandoffs: [{
        schema: 'openslack.handoff.v1',
        id: 'h-1',
        status: 'open',
        from: 'agent-1',
        to: 'agent-2',
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        context: 'Review PR',
        nextSteps: ['Review'],
      }],
      linkedDecisions: [{
        schema: 'openslack.decision.v1',
        id: 'd-1',
        topic: 'Use React',
        decision: 'Adopted React',
        rationale: 'Ecosystem',
        decidedBy: 'alice',
        createdAt: '2026-05-20T10:00:00Z',
        status: 'active',
      }],
    }))
    expect(model.handoffs).toHaveLength(1)
    expect(model.handoffs[0].from).toBe('agent-1')
    expect(model.handoffs[0].to).toBe('agent-2')
    expect(model.decisions).toHaveLength(1)
    expect(model.decisions[0].topic).toBe('Use React')
  })

  it('formats activity timestamps as HH:MM', () => {
    const model = mapRoomToViewModel(makeRoomView({
      recentEvents: [makeEvent({ timestamp: '2026-05-27T14:30:00Z' })],
    }))
    expect(model.recentActivity[0].time).toBe('14:30')
  })
})
