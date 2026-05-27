import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import DoctorView from '../views/DoctorView.js'
import type { DoctorViewModel } from '../view-models/doctor.js'

function makeModel(overrides?: Partial<DoctorViewModel>): DoctorViewModel {
  return {
    prNumber: 42,
    title: 'Add TUI package',
    author: 'alice',
    state: 'open',
    draft: false,
    riskZone: 'green',
    mergeable: true,
    decision: 'READY_TO_MERGE',
    reason: 'All gates passed',
    recommendation: 'Merge when ready',
    gates: [
      { name: 'Draft', status: 'PASS', detail: 'Ready for review' },
      { name: 'State', status: 'PASS', detail: 'Open' },
      { name: 'Merge', status: 'PASS', detail: 'No merge conflicts' },
      { name: 'Checks', status: 'PASS', detail: 'All 2 passed' },
      { name: 'Approvals', status: 'PASS', detail: '1 valid approval(s)' },
      { name: 'Risk', status: 'PASS', detail: 'Zone: GREEN' },
    ],
    checks: [{ name: 'CI', status: 'PASS', conclusion: 'success' }],
    reviews: [{ user: 'bob', state: 'APPROVED', valid: true }],
    evidence: [],
    ...overrides,
  }
}

describe('DoctorView', () => {
  let instance: { unmount: () => void } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  async function renderView(model: DoctorViewModel): Promise<string> {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(DoctorView, { model }),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise(r => setTimeout(r, 150))
    return chunks.join('')
  }

  it('renders header with PR number', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('PR #42')
    expect(output).toContain('Doctor Report')
  })

  it('renders gate items', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('Draft')
    expect(output).toContain('Checks')
    expect(output).toContain('Approvals')
  })

  it('renders decision', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('READY_TO_MERGE')
  })

  it('renders with blocked data without crashing', async () => {
    const output = await renderView(makeModel({
      draft: true,
      decision: 'BLOCKED_DRAFT',
      reason: 'PR is in draft state',
      gates: [
        { name: 'Draft', status: 'FAIL', detail: 'PR is in draft state' },
        { name: 'State', status: 'PASS', detail: 'Open' },
        { name: 'Merge', status: 'PASS', detail: 'No merge conflicts' },
        { name: 'Checks', status: 'PASS', detail: 'All 2 passed' },
        { name: 'Approvals', status: 'PASS', detail: '1 valid approval(s)' },
        { name: 'Risk', status: 'PASS', detail: 'Zone: GREEN' },
      ],
    }))
    expect(output).toContain('BLOCKED_DRAFT')
    expect(output).toContain('draft state')
  })
})
