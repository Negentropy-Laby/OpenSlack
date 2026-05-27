import { describe, it, expect } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { render } from '@openslack/tui'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'

describe('KeyboardShortcutHint', () => {
  it('renders keys and description', async () => {
    const chunks: string[] = []
    const stdout = new Writable({
      write(chunk, _, cb) {
        chunks.push(String(chunk))
        cb()
      },
    }) as NodeJS.WriteStream
    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    })

    const instance = await render(
      React.createElement(KeyboardShortcutHint, {
        keys: ['Ctrl+C', 'q'],
        description: 'quit',
      }),
      { stdout, patchConsole: false },
    )

    await new Promise<void>((r) => setTimeout(r, 100))
    const output = chunks.join('')
    expect(output).toContain('Ctrl+C')
    expect(output).toContain('quit')
    instance.unmount()
  })
})
