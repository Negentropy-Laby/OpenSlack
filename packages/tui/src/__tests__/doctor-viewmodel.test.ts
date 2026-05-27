import { describe, it, expect } from 'vitest'
import { mapDoctorToViewModel } from '../view-models/doctor.js'
import type { PRReviewReport } from '@openslack/pr'

function makeReport(overrides?: Partial<PRReviewReport>): PRReviewReport {
  return {
    prNumber: 42,
    title: 'Add TUI package',
    author: 'alice',
    state: 'open',
    draft: false,
    baseRef: 'main',
    riskZone: 'green',
    changedFiles: ['packages/tui/src/index.ts'],
    checks: [
      { name: 'CI', status: 'completed', conclusion: 'success' },
      { name: 'Lint', status: 'completed', conclusion: 'success' },
    ],
    reviews: [
      { user: 'bob', state: 'APPROVED' },
      { user: 'alice', state: 'APPROVED' },
    ],
    humanApprovals: [{ user: 'bob' }],
    decision: 'READY_TO_MERGE',
    reason: 'All gates passed',
    recommendation: 'Merge when ready',
    mergeable: true,
    ...overrides,
  }
}

describe('mapDoctorToViewModel', () => {
  it('maps a passing PR report', () => {
    const model = mapDoctorToViewModel(makeReport())
    expect(model.prNumber).toBe(42)
    expect(model.title).toBe('Add TUI package')
    expect(model.author).toBe('alice')
    expect(model.decision).toBe('READY_TO_MERGE')
    expect(model.gates).toHaveLength(6)
    expect(model.gates.every(g => g.status === 'PASS')).toBe(true)
    expect(model.checks).toHaveLength(2)
    expect(model.reviews).toHaveLength(2)
  })

  it('maps gates correctly for blocked PR', () => {
    const model = mapDoctorToViewModel(makeReport({
      draft: true,
      mergeable: false,
      riskZone: 'black',
      checks: [
        { name: 'CI', status: 'completed', conclusion: 'failure' },
        { name: 'Lint', status: 'in_progress', conclusion: null },
      ],
      reviews: [],
      decision: 'BLOCKED_DRAFT',
    }))
    const gateNames = model.gates.map(g => g.name)
    expect(gateNames).toEqual(['Draft', 'State', 'Merge', 'Checks', 'Approvals', 'Risk'])
    expect(model.gates[0].status).toBe('FAIL') // Draft
    expect(model.gates[2].status).toBe('FAIL') // Merge
    expect(model.gates[3].status).toBe('WARN') // Checks (pending)
    expect(model.gates[4].status).toBe('FAIL') // Approvals
    expect(model.gates[5].status).toBe('FAIL') // Risk black
  })

  it('sanitizes escape sequences from fields', () => {
    const model = mapDoctorToViewModel(makeReport({
      title: 'Bad\x1b[31m inject',
      reason: 'Reason\x1b[31m with escape',
    }))
    expect(model.title).toBe('Bad inject')
    expect(model.reason).toBe('Reason with escape')
  })

  it('maps checks with correct status', () => {
    const model = mapDoctorToViewModel(makeReport({
      checks: [
        { name: 'CI', status: 'completed', conclusion: 'success' },
        { name: 'Lint', status: 'completed', conclusion: 'failure' },
        { name: 'Deploy', status: 'in_progress', conclusion: null },
      ],
    }))
    expect(model.checks[0].status).toBe('PASS')
    expect(model.checks[1].status).toBe('FAIL')
    expect(model.checks[2].status).toBe('WARN')
  })

  it('maps reviews with valid flag', () => {
    const model = mapDoctorToViewModel(makeReport({
      reviews: [
        { user: 'bob', state: 'APPROVED' },
        { user: 'alice', state: 'APPROVED' },
        { user: 'charlie', state: 'CHANGES_REQUESTED' },
      ],
    }))
    expect(model.reviews[0].valid).toBe(true)  // bob, not author
    expect(model.reviews[1].valid).toBe(false) // alice, is author
    expect(model.reviews[2].valid).toBe(false) // CHANGES_REQUESTED
  })

  it('passes evidence through sanitization', () => {
    const model = mapDoctorToViewModel(makeReport(), ['Risk zone: green', 'Evil\x1b[31m evidence'])
    expect(model.evidence).toHaveLength(2)
    expect(model.evidence[1]).toBe('Evil evidence')
  })
})
