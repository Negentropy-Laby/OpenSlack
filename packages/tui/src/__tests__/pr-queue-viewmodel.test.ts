import { describe, it, expect } from 'vitest'
import { mapPrQueueToViewModel } from '../view-models/pr-queue.js'
import type { PRQueueItem } from '@openslack/pr'

function makeItem(overrides?: Partial<PRQueueItem>): PRQueueItem {
  return {
    prNumber: 42,
    title: 'Add new feature',
    author: 'alice',
    decision: 'READY_TO_MERGE',
    canMerge: true,
    blockerCategory: 'none',
    owner: 'human',
    nextAction: 'Run openslack pr merge 42',
    evidence: ['Risk zone: green', 'Author: @alice'],
    rerunCommand: 'openslack pr doctor 42',
    riskZone: 'green',
    ...overrides,
  }
}

describe('mapPrQueueToViewModel', () => {
  it('maps an empty queue', () => {
    const model = mapPrQueueToViewModel([])
    expect(model.title).toBe('PR Queue')
    expect(model.totalPRs).toBe(0)
    expect(model.readyCount).toBe(0)
    expect(model.blockedCount).toBe(0)
    expect(model.pendingCount).toBe(0)
    expect(model.items).toHaveLength(0)
  })

  it('maps a single ready PR', () => {
    const model = mapPrQueueToViewModel([makeItem()])
    expect(model.totalPRs).toBe(1)
    expect(model.readyCount).toBe(1)
    expect(model.blockedCount).toBe(0)
    expect(model.items).toHaveLength(1)
    expect(model.items[0].prNumber).toBe(42)
    expect(model.items[0].title).toBe('Add new feature')
    expect(model.items[0].canMerge).toBe(true)
  })

  it('counts blocked and pending PRs correctly', () => {
    const items: PRQueueItem[] = [
      makeItem({ prNumber: 1, canMerge: true, blockerCategory: 'none', decision: 'READY_TO_MERGE' }),
      makeItem({ prNumber: 2, canMerge: false, blockerCategory: 'approvals', decision: 'NEEDS_HUMAN_APPROVAL' }),
      makeItem({ prNumber: 3, canMerge: false, blockerCategory: 'checks', decision: 'CHECKS_PENDING' }),
      makeItem({ prNumber: 4, canMerge: false, blockerCategory: 'risk_zone', decision: 'BLOCKED_BLACK_ZONE' }),
    ]
    const model = mapPrQueueToViewModel(items)
    expect(model.totalPRs).toBe(4)
    expect(model.readyCount).toBe(1)
    expect(model.blockedCount).toBe(3)
    expect(model.pendingCount).toBe(1)
  })

  it('sanitizes escape sequences from fields', () => {
    const model = mapPrQueueToViewModel([
      makeItem({
        title: 'Bad\x1b[31m inject',
        author: 'evil\x1b[32m user',
        nextAction: 'Do\x1b[33m something',
      }),
    ])
    expect(model.items[0].title).toBe('Bad inject')
    expect(model.items[0].author).toBe('evil user')
    expect(model.items[0].nextAction).toBe('Do something')
  })

  it('maps all fields from PRQueueItem', () => {
    const model = mapPrQueueToViewModel([makeItem()])
    const item = model.items[0]
    expect(item.prNumber).toBe(42)
    expect(item.author).toBe('alice')
    expect(item.decision).toBe('READY_TO_MERGE')
    expect(item.blockerCategory).toBe('none')
    expect(item.owner).toBe('human')
    expect(item.riskZone).toBe('green')
    expect(item.rerunCommand).toBe('openslack pr doctor 42')
  })

  it('handles multiple items preserving order', () => {
    const items = [
      makeItem({ prNumber: 10 }),
      makeItem({ prNumber: 20 }),
      makeItem({ prNumber: 30 }),
    ]
    const model = mapPrQueueToViewModel(items)
    expect(model.items.map(i => i.prNumber)).toEqual([10, 20, 30])
  })
})
