import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render } from '@openslack/tui';
import { ThemeProvider } from '../design-system/ThemeProvider.js';
import ThemedText from '../design-system/ThemedText.js';

describe('ThemedText render', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  it('renders themed text with success color', async () => {
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }) as NodeJS.WriteStream;
    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    instance = await render(
      React.createElement(
        ThemeProvider,
        { mode: 'dark' },
        React.createElement(ThemedText, { colorTheme: 'success' }, 'hello'),
      ),
      { stdout, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));

    const output = chunks.join('');
    expect(output).toContain('hello');
  });

  it('renders bold text', async () => {
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }) as NodeJS.WriteStream;
    Object.defineProperties(stdout, {
      columns: { value: 80, writable: true, configurable: true },
      rows: { value: 24, writable: true, configurable: true },
      isTTY: { value: false, configurable: true },
    });

    instance = await render(
      React.createElement(
        ThemeProvider,
        { mode: 'dark' },
        React.createElement(ThemedText, { bold: true }, 'bold text'),
      ),
      { stdout, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));

    const output = chunks.join('');
    expect(output).toContain('bold text');
  });
});
