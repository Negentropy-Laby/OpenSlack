/**
 * ListItem.test.tsx — Render tests for the ListItem design-system component
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render } from '@openslack/tui';
import ListItem from '../design-system/ListItem.js';
import { ThemeProvider } from '../design-system/ThemeProvider.js';

describe('ListItem render', () => {
  let instance: { unmount: () => void; waitUntilExit: () => Promise<void> } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  it('renders label text', async () => {
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
        React.createElement(ListItem, { label: 'Git installed' }),
      ),
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));
    const output = chunks.join('');
    expect(output).toContain('Git installed');
  });

  it('renders label and detail', async () => {
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
        React.createElement(ListItem, { label: 'Check A', detail: 'Run setup to fix' }),
      ),
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));
    const output = chunks.join('');
    expect(output).toContain('Check A');
    expect(output).toContain('Run setup to fix');
  });

  it('renders status icon for PASS', async () => {
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
        React.createElement(ListItem, { label: 'Tests', status: 'PASS' }),
      ),
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false },
    );

    await new Promise((r) => setTimeout(r, 150));
    const output = chunks.join('');
    expect(output).toContain('Tests');
    expect(output).toContain('✓');
  });
});
