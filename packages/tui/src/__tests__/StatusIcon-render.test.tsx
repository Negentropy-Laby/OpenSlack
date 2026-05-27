import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import StatusIcon from '../design-system/StatusIcon.js'

describe('StatusIcon render', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  async function renderIcon(jsx: React.ReactElement): Promise<string> {
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

  it('renders pass category', async () => {
    const output = await renderIcon(React.createElement(StatusIcon, { category: 'pass' }))
    expect(output).toContain('✓')
  })

  it('renders warn category', async () => {
    const output = await renderIcon(React.createElement(StatusIcon, { category: 'warn' }))
    expect(output).toContain('⚠')
  })

  it('renders fail category', async () => {
    const output = await renderIcon(React.createElement(StatusIcon, { category: 'fail' }))
    expect(output).toContain('✗')
  })

  it('renders blocked category', async () => {
    const output = await renderIcon(React.createElement(StatusIcon, { category: 'blocked' }))
    expect(output).toContain('⊘')
  })

  it('renders info category', async () => {
    const output = await renderIcon(React.createElement(StatusIcon, { category: 'info' }))
    expect(output).toContain('●')
  })

  it('auto-categorizes PASS status', async () => {
    const output = await renderIcon(React.createElement(StatusIcon, { status: 'PASS' }))
    expect(output).toContain('✓')
  })

  it('auto-categorizes BLOCKED_BY_CHECKS status', async () => {
    const output = await renderIcon(React.createElement(StatusIcon, { status: 'BLOCKED_BY_CHECKS' }))
    expect(output).toContain('⊘')
  })
})
