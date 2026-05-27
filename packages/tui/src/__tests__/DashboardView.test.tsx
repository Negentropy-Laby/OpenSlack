import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import DashboardView from '../views/DashboardView.js'
import type { DashboardViewModel } from '../view-models/dashboard.js'

function makeModel(overrides?: Partial<DashboardViewModel>): DashboardViewModel {
  return {
    title: 'OpenSlack Team Dashboard',
    generatedAt: '2026-05-27T12:00:00Z',
    summary: { blockers: 1, handoffs: 0, decisions: 0 },
    blockers: [{ object: 'pr:42', summary: 'Missing reviews' }],
    handoffs: [],
    decisions: [],
    recentActivity: [],
    ...overrides,
  }
}

describe('DashboardView', () => {
  let instance: { unmount: () => void } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  async function renderView(model: DashboardViewModel): Promise<string> {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(DashboardView, { model }),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise(r => setTimeout(r, 150))
    return chunks.join('')
  }

  it('renders header with title', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('OpenSlack Team Dashboard')
  })

  it('renders blocker items', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('pr:42')
    expect(output).toContain('Missing reviews')
  })

  it('renders with empty data without crashing', async () => {
    const output = await renderView(makeModel({
      summary: { blockers: 0, handoffs: 0, decisions: 0 },
      blockers: [],
      handoffs: [],
      decisions: [],
      recentActivity: [],
    }))
    expect(output).toContain('OpenSlack Team Dashboard')
    expect(output).toContain('No blockers')
  })
})
