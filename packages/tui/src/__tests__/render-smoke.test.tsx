/**
 * render-smoke.test.tsx — Real render smoke test
 *
 * Exercises the ink reconciler, layout (Yoga), and output pipeline
 * end-to-end by rendering a Box+Text tree into a mock writable stream
 * and asserting the rendered output contains the expected text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { Writable } from 'stream';

describe('Real render smoke test', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  it('renders Box containing Text into a mock stdout', async () => {
    const tui = await import('@openslack/tui');

    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _encoding: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as NodeJS.WriteStream;

    // The Ink constructor reads .columns, .rows, and .isTTY from stdout.
    // Provide sensible defaults for a non-TTY mock.
    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    instance = await tui.render(
      React.createElement(tui.Box, null,
        React.createElement(tui.Text, null, 'Hello TUI'),
      ),
      { stdout, patchConsole: false },
    );

    // Give the reconciler and render pipeline a tick to flush output.
    await new Promise((r) => setTimeout(r, 150));

    const output = chunks.join('');
    expect(output).toContain('Hello TUI');
  });

  it('renders multiple Text children inside a column Box', async () => {
    const tui = await import('@openslack/tui');

    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _encoding: string, cb: () => void) {
        chunks.push(chunk.toString());
        cb();
      },
    }) as NodeJS.WriteStream;

    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    instance = await tui.render(
      React.createElement(
        tui.Box,
        { flexDirection: 'column' },
        React.createElement(tui.Text, null, 'Line One'),
        React.createElement(tui.Text, null, 'Line Two'),
      ),
      { stdout, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));

    const output = chunks.join('');
    expect(output).toContain('Line One');
    expect(output).toContain('Line Two');
  });
});
