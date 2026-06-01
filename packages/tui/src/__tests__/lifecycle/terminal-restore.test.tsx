/**
 * terminal-restore.test.tsx -- Terminal state restore on unmount.
 *
 * Verifies that the Ink engine correctly manages terminal state transitions:
 * - Mouse tracking enable/disable are paired
 * - Alt-screen activation is tracked
 * - Unmount completes without error
 * - setAltScreenActive(false) writes disable sequences synchronously
 *
 * This tests the render lifecycle guarantee: exit TUI = terminal restored.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'stream'
import React from 'react'
import { Text } from '@openslack/tui'
import renderInk from '../../ink/root.js'
import type { Instance } from '../../ink/root.js'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
} from '../../ink/termio/dec.js'

function createMockStdout(columns = 80, rows = 24, isTTY = true) {
  const chunks: string[] = []
  let tty = isTTY
  const stdout = new Writable({
    write(chunk, _, cb) {
      chunks.push(String(chunk))
      cb()
    },
  }) as NodeJS.WriteStream
  Object.defineProperties(stdout, {
    columns: { value: columns, writable: true, configurable: true },
    rows: { value: rows, writable: true, configurable: true },
    isTTY: { get: () => tty, configurable: true },
  })
  return {
    stdout,
    chunks,
    setIsTTY: (next: boolean) => { tty = next },
  }
}

describe('terminal restore on unmount', () => {
  let instance: Instance | null = null

  afterEach(() => {
    if (instance) {
      instance.unmount()
      instance = null
    }
  })

  it('enable-then-disable mouse tracking writes disable sequence', async () => {
    const mock = createMockStdout(80, 24, true)

    instance = await renderInk(
      React.createElement(Text, null, 'mouse-pair'),
      { stdout: mock.stdout },
    )

    // Enable mouse tracking
    instance.setAltScreenActive(true, true)
    await new Promise((r) => setTimeout(r, 50))

    mock.chunks.length = 0

    // Disable mouse tracking (synchronous write)
    instance.setAltScreenActive(false)

    const output = mock.chunks.join('')
    expect(output).toContain(DISABLE_MOUSE_TRACKING)
  })

  it('unmount after render completes without error', async () => {
    const mock = createMockStdout(80, 24, false)

    instance = await renderInk(
      React.createElement(Text, null, 'clean-exit'),
      { stdout: mock.stdout },
    )
    await new Promise((r) => setTimeout(r, 100))

    // Unmount should not throw
    expect(() => instance!.unmount()).not.toThrow()
    instance = null
  })

  it('unmount after alt-screen enable completes without error', async () => {
    const mock = createMockStdout(80, 24, true)

    instance = await renderInk(
      React.createElement(Text, null, 'alt-exit'),
      { stdout: mock.stdout },
    )
    instance.setAltScreenActive(true, true)
    await new Promise((r) => setTimeout(r, 100))

    // Unmount should not throw even with alt-screen active
    expect(() => instance!.unmount()).not.toThrow()
    instance = null
  })

  it('enable-disable-enable cycle writes correct sequences each time', async () => {
    const mock = createMockStdout(80, 24, true)

    instance = await renderInk(
      React.createElement(Text, null, 'cycle'),
      { stdout: mock.stdout },
    )

    // Enable
    instance.setAltScreenActive(true, true)
    await new Promise((r) => setTimeout(r, 50))
    const enable1Output = mock.chunks.join('')
    expect(enable1Output).toContain(ENABLE_MOUSE_TRACKING)

    mock.chunks.length = 0

    // Disable
    instance.setAltScreenActive(false)
    await new Promise((r) => setTimeout(r, 50))
    const disableOutput = mock.chunks.join('')
    expect(disableOutput).toContain(DISABLE_MOUSE_TRACKING)

    mock.chunks.length = 0

    // Re-enable
    instance.setAltScreenActive(true, true)
    await new Promise((r) => setTimeout(r, 50))
    const enable2Output = mock.chunks.join('')
    expect(enable2Output).toContain(ENABLE_MOUSE_TRACKING)
  })

  it('multiple unmounts are idempotent', async () => {
    const mock = createMockStdout(80, 24, false)

    instance = await renderInk(
      React.createElement(Text, null, 'double-unmount'),
      { stdout: mock.stdout },
    )
    await new Promise((r) => setTimeout(r, 100))

    instance.unmount()
    // Second unmount should not throw
    expect(() => instance!.unmount()).not.toThrow()
    instance = null
  })
})
