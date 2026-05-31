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
  it('renders home view and captures output', async () => {
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
    expect(output).toContain('Needs Attention')
    expect(output).toContain('Quick Navigation')
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
