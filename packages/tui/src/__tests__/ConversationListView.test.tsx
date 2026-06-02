import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import ConversationListView from '../views/ConversationListView.js'
import type { ConversationListViewModel } from '../view-models/conversation.js'

function makeModel(overrides?: Partial<ConversationListViewModel>): ConversationListViewModel {
  return {
    title: 'Conversations',
    totalCount: 2,
    activeCount: 1,
    items: [
      {
        id: 'THREAD-001',
        title: 'First Thread',
        participantCount: 3,
        lastActivity: '1h',
        status: 'active',
        linkedObjects: [{ kind: 'issue', id: '42' }],
      },
      {
        id: 'THREAD-002',
        title: 'Second Thread',
        participantCount: 2,
        lastActivity: '2d',
        status: 'completed',
        linkedObjects: [],
      },
    ],
    ...overrides,
  }
}

describe('ConversationListView', () => {
  let instance: { unmount: () => void } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  async function renderView(model: ConversationListViewModel): Promise<string> {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(ConversationListView, { model }),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise(r => setTimeout(r, 150))
    return chunks.join('')
  }

  it('renders thread list with titles', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('Conversations')
    expect(output).toContain('First Thread')
    expect(output).toContain('Second Thread')
  })

  it('renders counts in header', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('2 total')
    expect(output).toContain('1 active')
  })

  it('renders empty state', async () => {
    const output = await renderView(makeModel({
      totalCount: 0,
      activeCount: 0,
      items: [],
    }))
    expect(output).toContain('No conversations found.')
  })

  it('renders keyboard hints in footer', async () => {
    const output = await renderView(makeModel())
    expect(output).toContain('navigate')
    expect(output).toContain('select')
    expect(output).toContain('back')
  })
})
