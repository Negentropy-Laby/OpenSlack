import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { Text } from '@openslack/tui'
import { renderTui } from '../render.js'
import renderInk from '../ink/root.js'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
} from '../ink/termio/dec.js'

describe('renderTui', () => {
  let unmountFn: (() => void) | null = null
  const originalTermProgram = process.env.TERM_PROGRAM

  afterEach(() => {
    unmountFn?.()
    unmountFn = null
    if (originalTermProgram === undefined) {
      delete process.env.TERM_PROGRAM
    } else {
      process.env.TERM_PROGRAM = originalTermProgram
    }
  })

  function createMockStdout({ isTTY = false } = {}) {
    const chunks: string[] = []
    let tty = isTTY
    const stdout = new Writable({ write(chunk, _, cb) { chunks.push(String(chunk)); cb() } })
    Object.defineProperties(stdout, {
      columns: { value: 80, configurable: true },
      rows: { value: 24, configurable: true },
      isTTY: { get: () => tty, configurable: true },
    })
    return { stdout, chunks, setIsTTY: (next: boolean) => { tty = next } }
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

  it('enables mouse tracking immediately after alt-screen render starts', async () => {
    process.env.TERM_PROGRAM = 'vscode'
    const { stdout, chunks, setIsTTY } = createMockStdout({ isTTY: true })
    const { unmount } = await renderTui(
      React.createElement(Text, null, 'mouse ready'),
      { stdout: stdout as unknown as NodeJS.WriteStream },
    )
    unmountFn = () => { setIsTTY(false); unmount() }

    const output = chunks.join('')
    expect(output).toContain(ENABLE_MOUSE_TRACKING)
  })

  it('setAltScreenActive(true, true) writes mouse tracking immediately', async () => {
    const { stdout, chunks, setIsTTY } = createMockStdout({ isTTY: true })
    const instance = await renderInk(
      React.createElement(Text, null, 'direct enable'),
      { stdout: stdout as unknown as NodeJS.WriteStream },
    )
    unmountFn = () => { setIsTTY(false); instance.unmount() }
    chunks.length = 0

    instance.setAltScreenActive(true, true)

    expect(chunks.join('')).toContain(ENABLE_MOUSE_TRACKING)
  })

  it('setAltScreenActive(false) disables mouse tracking after it was enabled', async () => {
    const { stdout, chunks, setIsTTY } = createMockStdout({ isTTY: true })
    const instance = await renderInk(
      React.createElement(Text, null, 'direct disable'),
      { stdout: stdout as unknown as NodeJS.WriteStream },
    )
    unmountFn = () => { setIsTTY(false); instance.unmount() }

    instance.setAltScreenActive(true, true)
    chunks.length = 0
    instance.setAltScreenActive(false)

    expect(chunks.join('')).toContain(DISABLE_MOUSE_TRACKING)
  })

  it('setAltScreenActive(true, false) does not write mouse tracking', async () => {
    const { stdout, chunks, setIsTTY } = createMockStdout({ isTTY: true })
    const instance = await renderInk(
      React.createElement(Text, null, 'no mouse'),
      { stdout: stdout as unknown as NodeJS.WriteStream },
    )
    unmountFn = () => { setIsTTY(false); instance.unmount() }
    chunks.length = 0

    instance.setAltScreenActive(true, false)

    expect(chunks.join('')).not.toContain(ENABLE_MOUSE_TRACKING)
    expect(chunks.join('')).not.toContain(DISABLE_MOUSE_TRACKING)
  })
})
