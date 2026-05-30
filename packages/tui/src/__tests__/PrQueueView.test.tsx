import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import PrQueueView from '../views/PrQueueView.js'
import type { PrQueueViewModel } from '../view-models/pr-queue.js'

function makeModel(overrides?: Partial<PrQueueViewModel>): PrQueueViewModel {
  return {
    title: 'PR Queue',
    totalPRs: 3,
    readyCount: 1,
    blockedCount: 1,
    pendingCount: 1,
    items: [
      {
        prNumber: 42,
        title: 'Add TUI views',
        author: 'alice',
        decision: 'READY_TO_MERGE',
        blockerCategory: 'none',
        owner: 'human',
        canMerge: true,
        riskZone: 'green',
        nextAction: 'Run openslack pr merge 42',
        rerunCommand: 'openslack pr doctor 42',
        workflowGate: { touched: false, criteria: [], overall: 'N/A' },
      },
      {
        prNumber: 43,
        title: 'Fix auth bug',
        author: 'bob',
        decision: 'CHECKS_PENDING',
        blockerCategory: 'checks',
        owner: 'agent',
        canMerge: false,
        riskZone: 'green',
        nextAction: 'Wait for checks to complete',
        rerunCommand: 'openslack pr doctor 43',
        workflowGate: { touched: true, criteria: [{ name: 'tests', passed: true }, { name: 'lint', passed: false }], overall: 'FAIL' },
      },
      {
        prNumber: 44,
        title: 'Refactor core',
        author: 'charlie',
        decision: 'NEEDS_HUMAN_APPROVAL',
        blockerCategory: 'approvals',
        owner: 'human',
        canMerge: false,
        riskZone: 'red',
        nextAction: 'Request human approval',
        rerunCommand: 'openslack pr doctor 44',
        workflowGate: { touched: true, criteria: [{ name: 'approval', passed: false }], overall: 'FAIL' },
      },
    ],
    ...overrides,
  }
}

describe('PrQueueView', () => {
  let instance: { unmount: () => void } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  async function renderView(model: PrQueueViewModel): Promise<string> {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(PrQueueView, { model }),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise(r => setTimeout(r, 150))
    return chunks.join('')
  }

  it('renders header with title', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('PR Queue')
  })

  it('renders summary counts', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('Total: 3')
    expect(output).toContain('Ready: 1')
    expect(output).toContain('Blocked: 1')
    expect(output).toContain('Pending: 1')
  })

  it('renders PR items', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('#42')
    expect(output).toContain('Add TUI views')
    expect(output).toContain('#43')
    expect(output).toContain('Fix auth bug')
    expect(output).toContain('#44')
    expect(output).toContain('Refactor core')
  })

  it('renders PR owner and blocker info', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('Owner: human')
    expect(output).toContain('Blocker: none')
    expect(output).toContain('Blocker: checks')
    expect(output).toContain('Blocker: approvals')
  })

  it('renders with empty queue without crashing', async () => {
    const output = await renderView(makeModel({
      totalPRs: 0,
      readyCount: 0,
      blockedCount: 0,
      pendingCount: 0,
      items: [],
    }))
    expect(output).toContain('PR Queue')
    expect(output).toContain('No open PRs')
  })

  it('renders with all PRs ready', async () => {
    const output = await renderView(makeModel({
      totalPRs: 1,
      readyCount: 1,
      blockedCount: 0,
      pendingCount: 0,
      items: [makeModel().items[0]],
    }))
    expect(output).toContain('Ready: 1')
    expect(output).toContain('Blocked: 0')
  })

  it('renders keyboard shortcut hints', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('[q')
    expect(output).toContain('Esc]')
  })
})
