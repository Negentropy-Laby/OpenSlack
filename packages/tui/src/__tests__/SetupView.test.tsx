import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import SetupView from '../views/SetupView.js'
import type { SetupViewModel } from '../view-models/setup.js'

function makeModel(overrides?: Partial<SetupViewModel>): SetupViewModel {
  return {
    readiness: 'ready',
    root: '/path/to/repo',
    totalChecks: 2,
    passedChecks: 2,
    fixable: [],
    needsAction: [],
    ok: [
      { id: 'repo-root', title: 'Workspace root', status: 'PASS', detail: '/path/to/repo', nextAction: '', command: '' },
      { id: 'git-remote', title: 'Git remote', status: 'PASS', detail: 'origin configured', nextAction: '', command: '' },
    ],
    ...overrides,
  }
}

describe('SetupView', () => {
  let instance: { unmount: () => void } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  async function renderView(model: SetupViewModel): Promise<string> {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(SetupView, { model }),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise(r => setTimeout(r, 150))
    return chunks.join('')
  }

  it('renders header with title', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('OpenSlack Setup Report')
  })

  it('renders readiness status', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('ready')
  })

  it('renders fixable items as WARN', async () => {
    const output = await renderView(makeModel({
      readiness: 'almost ready',
      fixable: [{ id: 'labels', title: 'Labels', status: 'WARN', detail: 'Can repair', nextAction: '', command: 'openslack github repair labels --apply' }],
    }))
    expect(output).toContain('Labels')
    expect(output).toContain('Fixable')
  })

  it('renders needs-action items', async () => {
    const output = await renderView(makeModel({
      readiness: 'needs setup help',
      ok: [],
      needsAction: [{ id: 'branch', title: 'Branch protection', status: 'FAIL', detail: 'Manual check required', nextAction: 'Confirm in GitHub settings', command: '' }],
    }))
    expect(output).toContain('Branch protection')
    expect(output).toContain('Needs Action')
  })

  it('renders fully set up message when all ok', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('fully set up')
  })
})
