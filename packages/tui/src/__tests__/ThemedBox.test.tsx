import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render, Text } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import ThemedBox from '../design-system/ThemedBox.js'

describe('ThemedBox render', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  it('renders bordered box with text child', async () => {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(ThemedBox, { borderStyle: 'single' },
          React.createElement(Text, null, 'inside'),
        ),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise((r) => setTimeout(r, 150))

    const output = chunks.join('')
    expect(output).toContain('inside')
  })
})
