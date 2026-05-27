import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import RoomView from '../views/RoomView.js'
import type { RoomViewModel } from '../view-models/room.js'

function makeModel(overrides?: Partial<RoomViewModel>): RoomViewModel {
  return {
    roomId: 'pr:42',
    objectKind: 'pr',
    objectId: '42',
    sourceUrl: 'https://github.com/org/repo/pull/42',
    owner: 'human:alice',
    nextAction: 'alice — Review changes',
    blockerCount: 1,
    blockers: [{ type: 'task.blocked', summary: 'Missing reviews', timestamp: '1h' }],
    handoffs: [],
    decisions: [],
    recentActivity: [{ time: '14:30', type: 'task.claimed', summary: 'Agent claimed issue', actor: 'agent-1' }],
    ...overrides,
  }
}

describe('RoomView', () => {
  let instance: { unmount: () => void } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  async function renderView(model: RoomViewModel): Promise<string> {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(RoomView, { model }),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise(r => setTimeout(r, 150))
    return chunks.join('')
  }

  it('renders header with room ID', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('Room: pr:42')
  })

  it('renders blocker items', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('task.blocked')
    expect(output).toContain('Missing reviews')
  })

  it('renders no-blockers message when empty', async () => {
    const output = await renderView(makeModel({
      blockerCount: 0,
      blockers: [],
    }))
    expect(output).toContain('No blockers')
  })

  it('renders with empty data without crashing', async () => {
    const output = await renderView(makeModel({
      sourceUrl: '',
      owner: '',
      nextAction: '',
      blockerCount: 0,
      blockers: [],
      handoffs: [],
      decisions: [],
      recentActivity: [],
    }))
    expect(output).toContain('Room: pr:42')
    expect(output).toContain('No blockers')
    expect(output).toContain('No activity')
  })
})
