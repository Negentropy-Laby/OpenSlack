import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render, Text } from '@openslack/tui'
import { ThemeProvider, useTheme } from '../design-system/ThemeProvider.js'

function ThemeReader() {
  const theme = useTheme()
  return React.createElement(Text, null, theme.mode)
}

describe('ThemeProvider render', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  it('provides dark theme by default', async () => {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(ThemeReader),
      ),
      { stdout, patchConsole: false },
    )

    await new Promise((r) => setTimeout(r, 150))

    const output = chunks.join('')
    expect(output).toContain('dark')
  })
})
