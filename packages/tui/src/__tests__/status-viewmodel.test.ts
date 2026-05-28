import { describe, it, expect } from 'vitest'
import { mapStatusToViewModel } from '../view-models/status.js'

function makeData(overrides?: Partial<Parameters<typeof mapStatusToViewModel>[0]>): Parameters<typeof mapStatusToViewModel>[0] {
  return {
    commit: 'abc1234',
    commitSubject: 'feat: add new module',
    modules: [
      { name: 'runtime', status: 'ACTIVE', tests: 100 },
      { name: 'kernel', status: 'ACTIVE' },
      { name: 'tui', status: 'ACTIVE', tests: 50 },
    ],
    gitHub: {
      available: true,
      tasksReady: 3,
      tasksClaimed: 1,
      tasksBlocked: 0,
      prsOpen: 5,
      prsBlocked: 2,
      prsReady: 1,
    },
    testSuite: { totalTests: 526, totalFiles: 48 },
    recommendations: [
      { title: 'Review PR #42', action: 'Check the PR', command: 'openslack pr doctor 42' },
    ],
    attentionItems: [
      { type: 'pr', description: '2 PRs blocked', action: 'Check what is blocking', priority: 'medium' },
    ],
    nextAction: 'Review PR #42',
    ...overrides,
  }
}

describe('mapStatusToViewModel', () => {
  it('maps a complete status data', () => {
    const model = mapStatusToViewModel(makeData())
    expect(model.title).toBe('OpenSlack Status')
    expect(model.version).toBe('v0.1 Developer Preview')
    expect(model.commit).toBe('abc1234')
    expect(model.commitSubject).toBe('feat: add new module')
  })

  it('maps modules with and without tests', () => {
    const model = mapStatusToViewModel(makeData())
    expect(model.modules).toHaveLength(3)
    expect(model.modules[0].name).toBe('runtime')
    expect(model.modules[0].tests).toBe(100)
    expect(model.modules[1].name).toBe('kernel')
    expect(model.modules[1].tests).toBeNull()
    expect(model.modules[2].tests).toBe(50)
  })

  it('maps GitHub operations', () => {
    const model = mapStatusToViewModel(makeData())
    expect(model.gitHub.available).toBe(true)
    expect(model.gitHub.tasksReady).toBe(3)
    expect(model.gitHub.prsOpen).toBe(5)
    expect(model.gitHub.prsBlocked).toBe(2)
    expect(model.gitHub.prsReady).toBe(1)
  })

  it('handles unavailable GitHub', () => {
    const model = mapStatusToViewModel(makeData({
      gitHub: {
        available: false,
        tasksReady: 0,
        tasksClaimed: 0,
        tasksBlocked: 0,
        prsOpen: 0,
        prsBlocked: 0,
        prsReady: 0,
      },
    }))
    expect(model.gitHub.available).toBe(false)
    expect(model.gitHub.tasksReady).toBe(0)
  })

  it('maps test suite data', () => {
    const model = mapStatusToViewModel(makeData())
    expect(model.testSuite.totalTests).toBe(526)
    expect(model.testSuite.totalFiles).toBe(48)
  })

  it('maps recommendations with and without commands', () => {
    const model = mapStatusToViewModel(makeData({
      recommendations: [
        { title: 'Review PR', action: 'Check it', command: 'openslack pr doctor 42' },
        { title: 'All clear', action: 'No action needed' },
      ],
    }))
    expect(model.recommendations).toHaveLength(2)
    expect(model.recommendations[0].command).toBe('openslack pr doctor 42')
    expect(model.recommendations[1].command).toBeNull()
  })

  it('maps attention items with priority levels', () => {
    const model = mapStatusToViewModel(makeData({
      attentionItems: [
        { type: 'health', description: 'Doctor failed', action: 'Run doctor', priority: 'high' },
        { type: 'pr', description: '2 PRs blocked', action: 'Check', priority: 'medium' },
        { type: 'task', description: '3 tasks ready', action: 'Claim one', priority: 'low' },
      ],
    }))
    expect(model.attentionItems).toHaveLength(3)
    expect(model.attentionItems[0].priority).toBe('high')
    expect(model.attentionItems[1].priority).toBe('medium')
    expect(model.attentionItems[2].priority).toBe('low')
  })

  it('maps empty recommendations and attention items', () => {
    const model = mapStatusToViewModel(makeData({
      recommendations: [],
      attentionItems: [],
      nextAction: 'All clear - no immediate actions needed.',
    }))
    expect(model.recommendations).toHaveLength(0)
    expect(model.attentionItems).toHaveLength(0)
    expect(model.nextAction).toBe('All clear - no immediate actions needed.')
  })

  it('sanitizes escape sequences from all fields', () => {
    const model = mapStatusToViewModel(makeData({
      commit: 'abc\x1b[31m1234',
      commitSubject: 'evil\x1b[32m subject',
      modules: [{ name: 'bad\x1b[33m module', status: 'ACTIVE' }],
      recommendations: [{ title: 'rec\x1b[31m title', action: 'act' }],
      attentionItems: [{ type: 'pr', description: 'desc\x1b[31mription', action: 'act', priority: 'high' }],
      nextAction: 'next\x1b[31m action',
    }))
    expect(model.commit).toBe('abc1234')
    expect(model.commitSubject).toBe('evil subject')
    expect(model.modules[0].name).toBe('bad module')
    expect(model.recommendations[0].title).toBe('rec title')
    expect(model.attentionItems[0].description).toBe('description')
    expect(model.nextAction).toBe('next action')
  })

  it('handles modules without tests field (undefined)', () => {
    const model = mapStatusToViewModel(makeData({
      modules: [{ name: 'newmod', status: 'PLANNED' }],
    }))
    expect(model.modules[0].tests).toBeNull()
  })
})
