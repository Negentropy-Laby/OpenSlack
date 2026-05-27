/**
 * design-system-integration.test.tsx — Integration render test
 *
 * Renders a full composition of design-system components inside ThemeProvider
 * and asserts the combined output contains expected text from each component.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render, Text } from '@openslack/tui'
import { ThemeProvider } from '../design-system/ThemeProvider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import ProgressBar from '../design-system/ProgressBar.js'
import ListItem from '../design-system/ListItem.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'

describe('design-system integration render', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null

  afterEach(() => {
    instance?.unmount()
    instance = null
  })

  it('renders full composition with ThemeProvider, Pane, ListItem, and ProgressBar', async () => {
    const chunks: string[] = []
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } })
    Object.defineProperties(stdout, { columns: { value: 80 }, rows: { value: 24 }, isTTY: { value: false } })

    instance = await render(
      React.createElement(ThemeProvider, { mode: 'dark' },
        React.createElement(Pane, { title: 'Health Check' },
          React.createElement(ListItem, { label: 'Git', status: 'PASS' }),
          React.createElement(ListItem, { label: 'Node', status: 'WARN' }),
          React.createElement(ProgressBar, { value: 75, width: 10 }),
        ),
      ),
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
    )

    await new Promise((r) => setTimeout(r, 150))
    const output = chunks.join('')
    expect(output).toContain('Health Check')
    expect(output).toContain('Git')
    expect(output).toContain('Node')
    expect(output).toContain('75%')
  })
})
