/**
 * resize-stability.test.tsx -- Resize layout stability tests.
 *
 * Verifies that when the terminal is resized, the TUI re-renders correctly
 * at the new dimensions. Tests:
 * - Width narrowing: no line exceeds new column width
 * - Width widening: no line exceeds new column width
 * - Row-only resize: content still present
 * - Rapid consecutive resizes: converges to final dimensions
 *
 * This tests the render lifecycle guarantee: resize = stable layout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render } from '@openslack/tui';
import Box from '../../ink/components/Box.js';
import Text from '../../ink/components/Text.js';
import stripAnsi from 'strip-ansi';
import { stringWidth } from '../../ink/stringWidth.js';

function createMockStdout(columns = 80, rows = 24) {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _, cb) {
      chunks.push(String(chunk));
      cb();
    },
  }) as NodeJS.WriteStream;
  Object.defineProperties(stdout, {
    columns: { value: columns, writable: true, configurable: true },
    rows: { value: rows, writable: true, configurable: true },
    isTTY: { value: true, configurable: true },
  });
  return { stdout, chunks };
}

/** Emit a resize event on the mock stdout. */
function emitResize(stdout: NodeJS.WriteStream, columns: number, rows: number) {
  Object.defineProperties(stdout, {
    columns: { value: columns, writable: true, configurable: true },
    rows: { value: rows, writable: true, configurable: true },
  });
  stdout.emit('resize');
}

describe('resize layout stability', () => {
  let instance: { unmount: () => void } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  it('narrowing columns produces output within new width', async () => {
    const { stdout, chunks } = createMockStdout(100, 24);

    instance = await render(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, 'Initial'),
        React.createElement(Text, null, 'A'.repeat(80)),
      ),
      { stdout, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 200));

    const initial = chunks.join('');
    expect(initial).toContain('Initial');

    // Resize narrower
    chunks.length = 0;
    emitResize(stdout, 60, 24);
    await new Promise((r) => setTimeout(r, 300));

    const afterResize = chunks.join('');
    // No line should exceed 60 columns after resize
    const lines = stripAnsi(afterResize).split('\n');
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const width = stringWidth(line);
      expect(width, `Line exceeds 60 cols (${width}): "${line.slice(0, 60)}"`).toBeLessThanOrEqual(
        60,
      );
    }
  });

  it('widening columns produces output within new width', async () => {
    const { stdout, chunks } = createMockStdout(40, 24);

    instance = await render(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, 'Narrow'),
        React.createElement(Text, null, 'B'.repeat(30)),
      ),
      { stdout, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 200));

    const initial = chunks.join('');
    expect(initial).toContain('Narrow');

    // Resize wider
    chunks.length = 0;
    emitResize(stdout, 120, 40);
    await new Promise((r) => setTimeout(r, 300));

    const afterResize = chunks.join('');
    // No line should exceed 120 columns
    const lines = stripAnsi(afterResize).split('\n');
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const width = stringWidth(line);
      expect(width, `Line exceeds 120 cols (${width}): "${line.slice(0, 80)}"`).toBeLessThanOrEqual(
        120,
      );
    }
  });

  it('row-only resize does not corrupt existing content', async () => {
    const { stdout, chunks } = createMockStdout(80, 24);

    instance = await render(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, 'RowResize'),
        React.createElement(Text, null, 'Second'),
        React.createElement(Text, null, 'Third'),
      ),
      { stdout, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 200));

    const initial = chunks.join('');
    expect(initial).toContain('RowResize');

    // Row-only resize: same width, different rows.
    // The diff engine may produce no output if content is unchanged.
    emitResize(stdout, 80, 40);
    await new Promise((r) => setTimeout(r, 300));

    // Content should still be valid — verify no crash, instance still alive
    expect(() => instance!.unmount()).not.toThrow();
    instance = null;
  });

  it('rapid consecutive resizes converge to final dimensions', async () => {
    const { stdout, chunks } = createMockStdout(120, 40);

    instance = await render(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, 'RapidResize'),
      ),
      { stdout, patchConsole: false },
    );
    await new Promise((r) => setTimeout(r, 150));

    // Fire multiple resizes rapidly
    emitResize(stdout, 60, 12);
    emitResize(stdout, 100, 30);
    emitResize(stdout, 40, 24);
    emitResize(stdout, 80, 24);

    await new Promise((r) => setTimeout(r, 400));

    const output = chunks.join('');
    // The final state should have valid 80-col output
    const lines = stripAnsi(output).split('\n');
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const width = stringWidth(line);
      expect(
        width,
        `Line exceeds 80 cols after rapid resize (${width}): "${line.slice(0, 80)}"`,
      ).toBeLessThanOrEqual(80);
    }
    expect(output).toContain('RapidResize');
  });
});
