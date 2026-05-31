import { describe, it, expect } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render, Box, Text } from '@openslack/tui'
import HomeView from '../views/HomeView.js'
import { mapHomeToViewModel } from '../view-models/home.js'
import Divider from '../design-system/Divider.js'
import { NavigationProvider } from '../navigation/context.js'

function createMockStdout(columns = 80, rows = 24) {
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _, cb) {
      chunks.push(String(chunk))
      cb()
    },
  }) as NodeJS.WriteStream
  Object.defineProperties(stdout, {
    columns: { value: columns, writable: true, configurable: true },
    rows: { value: rows, writable: true, configurable: true },
    isTTY: { value: false, configurable: true },
  })
  return { stdout, chunks }
}

describe('HomeView render debug', () => {
  it('renders home view with 2-section layout', async () => {
    const { stdout, chunks } = createMockStdout(80, 24)
    const model = mapHomeToViewModel()
    const instance = await render(
      React.createElement(NavigationProvider, null,
        React.createElement(HomeView, { model })
      ),
      { stdout, patchConsole: false }
    )
    await new Promise<void>((r) => setTimeout(r, 200))
    const output = chunks.join('')
    expect(output).toContain('OpenSlack')
    expect(output).toContain('What do you want to do?')
    expect(output).toContain('Quick Navigation')
    // Verify no old sections remain
    expect(output).not.toContain('Needs Attention')
    expect(output).not.toContain('Workflow Quick Actions')
    instance.unmount()
  })

  it('renders all 6 tasks in the tasks section', async () => {
    const { stdout, chunks } = createMockStdout(80, 50)
    const model = mapHomeToViewModel()
    const instance = await render(
      React.createElement(NavigationProvider, null,
        React.createElement(HomeView, { model })
      ),
      { stdout, patchConsole: false }
    )
    await new Promise<void>((r) => setTimeout(r, 200))
    const output = chunks.join('')
    expect(output).toContain('See what needs attention')
    expect(output).toContain('Start or continue work')
    expect(output).toContain('Run or check a workflow')
    expect(output).toContain('Review and merge PRs')
    expect(output).toContain('Approve pending items')
    expect(output).toContain('Maintain organization profile')
    instance.unmount()
  })

  it('renders nav items in quick navigation section', async () => {
    const { stdout, chunks } = createMockStdout(80, 50)
    const model = mapHomeToViewModel()
    const instance = await render(
      React.createElement(NavigationProvider, null,
        React.createElement(HomeView, { model })
      ),
      { stdout, patchConsole: false }
    )
    await new Promise<void>((r) => setTimeout(r, 200))
    const output = chunks.join('')
    expect(output).toContain('Dashboard')
    expect(output).toContain('Status')
    expect(output).toContain('Activity')
    expect(output).toContain('Digest')
    expect(output).toContain('Profile')
    instance.unmount()
  })

  it('renders Divider without length prop', async () => {
    const { stdout, chunks } = createMockStdout(80, 24)
    const instance = await render(
      React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
        React.createElement(Text, null, 'Header'),
        React.createElement(Divider),
        React.createElement(Text, null, 'Footer')
      ),
      { stdout, patchConsole: false }
    )
    await new Promise<void>((r) => setTimeout(r, 200))
    const output = chunks.join('')
    expect(output).toContain('Header')
    expect(output).toContain('─')
    expect(output).toContain('Footer')
    instance.unmount()
  })
})
