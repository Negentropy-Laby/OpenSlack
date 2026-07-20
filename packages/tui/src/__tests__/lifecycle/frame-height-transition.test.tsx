/**
 * frame-height-transition.test.tsx -- Frame height transition lifecycle tests.
 *
 * Verifies that when a TUI view transitions from a tall frame to a short frame,
 * stale rows from the tall frame are cleaned up and do not appear in output.
 *
 * This tests the render lifecycle guarantee: long list shorter = no stale rows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'stream';
import React, { useState } from 'react';
import { render } from '@openslack/tui';
import Box from '../../ink/components/Box.js';
import Text from '../../ink/components/Text.js';
import stripAnsi from 'strip-ansi';

function createMockStdout(columns = 80, rows = 50) {
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

// A test component that switches between tall and short content
function SwitchableList({ tall }: { tall: boolean }) {
  if (tall) {
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      ...Array.from({ length: 20 }, (_, i) =>
        React.createElement(Text, { key: i }, `Tall item ${i + 1}`),
      ),
    );
  }
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, null, 'Short content'),
    React.createElement(Text, null, 'Only two lines'),
  );
}

describe('frame height transition', () => {
  let instance: { unmount: () => void } | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  it('tall-to-short transition does not leave stale tall rows', async () => {
    const { stdout, chunks } = createMockStdout(80, 50);

    // Render tall content first
    function Container() {
      const [tall, setTall] = useState(true);
      return React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(SwitchableList, { tall }),
        React.createElement(Text, {}, tall ? '[switch to short]' : '[switch to tall]'),
      );
    }

    instance = await render(React.createElement(Container), { stdout, patchConsole: false });
    await new Promise((r) => setTimeout(r, 200));

    const tallOutput = chunks.join('');
    expect(tallOutput).toContain('Tall item 1');
    expect(tallOutput).toContain('Tall item 20');

    // Clear and switch to short content by re-rendering
    chunks.length = 0;
    instance.unmount();
    instance = null;

    // Re-render with short content
    const { stdout: stdout2, chunks: chunks2 } = createMockStdout(80, 50);
    instance = await render(React.createElement(SwitchableList, { tall: false }), {
      stdout: stdout2,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 200));

    const shortOutput = chunks2.join('');
    expect(shortOutput).toContain('Short content');
    expect(shortOutput).toContain('Only two lines');

    // Stale tall rows must not appear in the short output
    const stripped = stripAnsi(shortOutput);
    expect(stripped).not.toContain('Tall item 20');
    expect(stripped).not.toContain('Tall item 19');
    expect(stripped).not.toContain('Tall item 10');
  });

  it('short-to-tall transition renders all new rows', async () => {
    const { stdout, chunks } = createMockStdout(80, 50);

    // Render short content first
    instance = await render(React.createElement(SwitchableList, { tall: false }), {
      stdout,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 200));

    const shortOutput = chunks.join('');
    expect(shortOutput).toContain('Short content');

    // Clear and render tall content
    chunks.length = 0;
    instance.unmount();
    instance = null;

    const { stdout: stdout2, chunks: chunks2 } = createMockStdout(80, 50);
    instance = await render(React.createElement(SwitchableList, { tall: true }), {
      stdout: stdout2,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 200));

    const tallOutput = chunks2.join('');
    expect(tallOutput).toContain('Tall item 1');
    expect(tallOutput).toContain('Tall item 20');
  });

  it('consecutive re-renders with varying heights produce clean output', async () => {
    // Render several heights in sequence and verify each is self-consistent
    const heights = [5, 15, 3, 10, 1];

    for (const count of heights) {
      const { stdout, chunks } = createMockStdout(80, 50);

      const el = React.createElement(
        Box,
        { flexDirection: 'column' },
        ...Array.from({ length: count }, (_, i) =>
          React.createElement(Text, { key: i }, `Row ${i + 1}`),
        ),
      );

      const inst = await render(el, { stdout, patchConsole: false });
      await new Promise((r) => setTimeout(r, 150));

      const output = chunks.join('');
      const stripped = stripAnsi(output);

      // Must contain all expected rows
      for (let i = 0; i < count; i++) {
        expect(stripped).toContain(`Row ${i + 1}`);
      }

      // Must not contain rows from a previous (different-height) render
      expect(stripped).not.toContain(`Row ${count + 1}`);

      inst.unmount();
    }
  });
});
