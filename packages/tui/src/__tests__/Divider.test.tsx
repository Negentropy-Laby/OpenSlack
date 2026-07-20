import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import React from 'react';
import { render } from '@openslack/tui';
import Divider from '../design-system/Divider.js';

describe('Divider', () => {
  it('renders a horizontal line of the specified length', async () => {
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

    const instance = await render(React.createElement(Divider, { length: 5 }), {
      stdout,
      patchConsole: false,
    });

    await new Promise<void>((r) => setTimeout(r, 100));
    const output = chunks.join('');
    expect(output).toContain('─────');
    instance.unmount();
  });
});
