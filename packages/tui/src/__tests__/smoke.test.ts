import { describe, it, expect } from 'vitest';
import React from 'react';

describe('@openslack/tui smoke test', () => {
  it('exports core components', async () => {
    const tui = await import('@openslack/tui');
    expect(tui.render).toBeDefined();
    expect(tui.createRoot).toBeDefined();
    expect(tui.Box).toBeDefined();
    expect(tui.Text).toBeDefined();
    expect(tui.Newline).toBeDefined();
    expect(tui.Spacer).toBeDefined();
  }, 15000);

  it('exports hooks', async () => {
    const tui = await import('@openslack/tui');
    expect(tui.useApp).toBeDefined();
    expect(tui.useInput).toBeDefined();
    expect(tui.useStdin).toBeDefined();
    expect(tui.useInterval).toBeDefined();
  }, 15000);

  it('can create React elements with Box and Text', async () => {
    const { Box, Text } = await import('@openslack/tui');
    const element = React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Text, null, 'Hello TUI'),
    );
    expect(element).toBeDefined();
    expect(element.type).toBe(Box);
    expect((element.props.children as React.ReactElement).type).toBe(Text);
  }, 15000);
});
