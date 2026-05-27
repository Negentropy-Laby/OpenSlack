import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { Text } from '@openslack/tui'
import { renderTui } from '../render.js'

describe('renderTui', () => {
  let unmountFn: (() => void) | null = null

  afterEach(() => {
    unmountFn?.()
    unmountFn = null
  })

  function createMockStdout() {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } })
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { value: false, configurable: true },
    })
    return { stdout, chunks }
  }

  it('renders themed component and returns unmount', async () => {
    const { stdout, chunks } = createMockStdout()
    const { unmount } = await renderTui(
      React.createElement(Text, null, 'hello tui'),
      { stdout: stdout as unknown as NodeJS.WriteStream },
    )
    unmountFn = unmount

    await new Promise(r => setTimeout(r, 100))
    const output = chunks.join('')
    expect(output).toContain('hello tui')
  })

  it('throws when isTuiSupported is false and no stdout override', async () => {
    await expect(
      renderTui(React.createElement(Text, null, 'test')),
    ).rejects.toThrow('TUI is not supported')
  })
})
