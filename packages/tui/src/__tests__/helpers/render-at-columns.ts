/**
 * render-at-columns.ts -- Test helper for rendering TUI components at multiple column widths.
 *
 * Exports:
 * - renderAtColumns(element, widths) -- renders a React element at each specified terminal
 *   width and returns a Map<number, string> of column width to rendered output.
 * - assertNoLineExceedsWidth(output, maxWidth) -- splits output into lines (stripping ANSI)
 *   and asserts no line's visual width exceeds maxWidth using stringWidth.
 */
import { Writable } from 'stream';
import React from 'react';
import render from '../../ink/root.js';
import { stringWidth } from '../../ink/stringWidth.js';
import stripAnsi from 'strip-ansi';

/**
 * Create a mock NodeJS.WriteStream with the given terminal dimensions.
 */
function createMockStdout(
  columns: number,
  rows = 24,
): {
  stdout: NodeJS.WriteStream;
  chunks: string[];
} {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding: string, cb: () => void) {
      chunks.push(String(chunk));
      cb();
    },
  }) as NodeJS.WriteStream;
  Object.defineProperties(stdout, {
    columns: { value: columns, writable: true, configurable: true },
    rows: { value: rows, writable: true, configurable: true },
    isTTY: { value: false, configurable: true },
  });
  return { stdout, chunks };
}

/**
 * Render a React element at each specified terminal column width.
 *
 * Returns a Map where keys are column widths and values are the rendered output string.
 * Each render gets its own mock stdout; instances are unmounted after capture.
 */
export async function renderAtColumns(
  element: React.ReactElement,
  widths: number[],
): Promise<Map<number, string>> {
  const results = new Map<number, string>();

  for (const cols of widths) {
    const { stdout, chunks } = createMockStdout(cols);

    const instance = await render(element, {
      stdout,
      patchConsole: false,
    });

    // Give the reconciler time to flush a frame
    await new Promise((r) => setTimeout(r, 200));

    const output = chunks.join('');
    results.set(cols, output);

    instance.unmount();
  }

  return results;
}

/**
 * Assert that no line in the output exceeds the given visual width.
 *
 * Strips ANSI escape codes before measuring so color/style codes don't
 * inflate the count. Uses stringWidth for accurate CJK/emoji measurement.
 */
export function assertNoLineExceedsWidth(output: string, maxWidth: number): void {
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const stripped = stripAnsi(raw);
    const width = stringWidth(stripped);

    if (width > maxWidth) {
      throw new Error(
        `Line ${i + 1} exceeds ${maxWidth} columns (visual width: ${width}):\n` +
          `  raw: ${raw.slice(0, 120)}${raw.length > 120 ? '...' : ''}\n` +
          `  stripped: ${stripped.slice(0, 120)}${stripped.length > 120 ? '...' : ''}`,
      );
    }
  }
}
