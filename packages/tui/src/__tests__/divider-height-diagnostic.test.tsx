import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render, Box, Text } from '@openslack/tui';
import Divider from '../design-system/Divider.js';

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
    isTTY: { value: false, configurable: true },
  });
  return { stdout, chunks };
}

describe('Divider height diagnostic', () => {
  it('verifies adaptive Divider renders at correct y position', async () => {
    const { stdout, chunks } = createMockStdout(80, 24);
    const instance = await render(
      React.createElement(
        Box,
        { flexDirection: 'column', paddingX: 1 },
        React.createElement(Text, null, 'Header'),
        React.createElement(Divider),
        React.createElement(Text, null, 'Footer'),
      ),
      { stdout, patchConsole: false },
    );
    await new Promise<void>((r) => setTimeout(r, 200));

    const output = chunks.join('');
    const lines = output.split('\n');

    // Non-TTY output should have exactly 3 lines:
    // Line 0: Header
    // Line 1: Divider (border line)
    // Line 2: Footer
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('Header');
    expect(lines[1]).toContain('─');
    expect(lines[2]).toContain('Footer');

    instance.unmount();
  });

  it('verifies Divider with explicit length still works', async () => {
    const { stdout, chunks } = createMockStdout(80, 24);
    const instance = await render(
      React.createElement(
        Box,
        { flexDirection: 'column', paddingX: 1 },
        React.createElement(Text, null, 'Header'),
        React.createElement(Divider, { length: 10 }),
        React.createElement(Text, null, 'Footer'),
      ),
      { stdout, patchConsole: false },
    );
    await new Promise<void>((r) => setTimeout(r, 200));

    const output = chunks.join('');
    const lines = output.split('\n');

    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('Header');
    expect(lines[1]).toContain('──────────');
    expect(lines[2]).toContain('Footer');

    instance.unmount();
  });

  it('verifies multiple Dividers have correct spacing', async () => {
    const { stdout, chunks } = createMockStdout(80, 24);
    const instance = await render(
      React.createElement(
        Box,
        { flexDirection: 'column', paddingX: 1 },
        React.createElement(Text, null, 'A'),
        React.createElement(Divider),
        React.createElement(Text, null, 'B'),
        React.createElement(Divider),
        React.createElement(Text, null, 'C'),
      ),
      { stdout, patchConsole: false },
    );
    await new Promise<void>((r) => setTimeout(r, 200));

    const output = chunks.join('');
    const lines = output.split('\n');

    // Should be exactly 5 lines: A, Divider, B, Divider, C
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('A');
    expect(lines[1]).toContain('─');
    expect(lines[2]).toContain('B');
    expect(lines[3]).toContain('─');
    expect(lines[4]).toContain('C');

    instance.unmount();
  });
});
