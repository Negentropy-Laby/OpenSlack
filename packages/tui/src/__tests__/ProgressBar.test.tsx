import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import ProgressBar from '../design-system/ProgressBar.js'

describe('ProgressBar render', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  async function renderBar(jsx: React.ReactElement): Promise<string> {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' }, jsx),
      { stdout, patchConsole: false },
    )

    await new Promise((r) => setTimeout(r, 150))
    return chunks.join('')
  }

  it('renders 50% progress', async () => {
    const output = await renderBar(React.createElement(ProgressBar, { value: 50, width: 10 }))
    expect(output).toContain('50%')
  })

  it('renders 0% progress', async () => {
    const output = await renderBar(React.createElement(ProgressBar, { value: 0, width: 10 }))
    expect(output).toContain('0%')
  })

  it('renders 100% progress', async () => {
    const output = await renderBar(React.createElement(ProgressBar, { value: 100, width: 10 }))
    expect(output).toContain('100%')
  })

  it('clamps value exceeding max to 100%', async () => {
    const output = await renderBar(React.createElement(ProgressBar, { value: 150, max: 100, width: 10 }))
    expect(output).toContain('100%')
  })
})
