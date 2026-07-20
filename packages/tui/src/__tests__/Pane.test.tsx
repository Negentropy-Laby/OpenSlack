/**
 * Pane.test.tsx — Render tests for the Pane design-system component
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render, Text } from '@openslack/tui';
import Pane from '../design-system/Pane.js';
import { ThemeProvider } from '../design-system/ThemeProvider.js';

describe('Pane render', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  it('renders title and children content', async () => {
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    Object.defineProperties(stdout, {
      columns: { value: 80 },
      rows: { value: 24 },
      isTTY: { value: false },
    });

    instance = await render(
      React.createElement(
        ThemeProvider,
        { mode: 'dark' },
        React.createElement(
          Pane,
          { title: 'Section' },
          React.createElement(Text, null, 'content here'),
        ),
      ),
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));
    const output = chunks.join('');
    expect(output).toContain('Section');
    expect(output).toContain('content here');
  });

  it('renders children without a title when borderStyle is set', async () => {
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    Object.defineProperties(stdout, {
      columns: { value: 80 },
      rows: { value: 24 },
      isTTY: { value: false },
    });

    instance = await render(
      React.createElement(
        ThemeProvider,
        { mode: 'dark' },
        React.createElement(
          Pane,
          { borderStyle: 'single' },
          React.createElement(Text, null, 'no title'),
        ),
      ),
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));
    const output = chunks.join('');
    expect(output).toContain('no title');
  });
});
