/**
 * osc-shim.test.ts — OSC inert shim regression tests
 *
 * Validates that all output-generating functions in the inert OSC shim
 * produce no actual OSC sequences. This module is the safe subset used
 * in environments where terminal escape sequences must not leak.
 */
import { describe, it, expect } from 'vitest';

describe('OSC inert shim', () => {
  it('osc() returns empty string', async () => {
    const { osc } = await import('../ink/termio/osc.js');
    expect(osc('52', 'c', 'evil')).toBe('');
  });

  it('link() returns empty string (no OSC 8)', async () => {
    const { link } = await import('../ink/termio/osc.js');
    expect(link('https://example.com')).toBe('');
  });

  it('link() with params returns empty string', async () => {
    const { link } = await import('../ink/termio/osc.js');
    expect(link('https://example.com', { id: 'test' })).toBe('');
  });

  it('setClipboard() resolves without writing', async () => {
    const { setClipboard } = await import('../ink/termio/osc.js');
    const result = await setClipboard('secret text');
    expect(result).toBe('');
  });

  it('supportsTabStatus() returns false', async () => {
    const { supportsTabStatus } = await import('../ink/termio/osc.js');
    expect(supportsTabStatus()).toBe(false);
  });

  it('tabStatus() returns empty string', async () => {
    const { tabStatus } = await import('../ink/termio/osc.js');
    expect(tabStatus({ indicator: null })).toBe('');
  });

  it('CLEAR_ITERM2_PROGRESS is empty string', async () => {
    const { CLEAR_ITERM2_PROGRESS } = await import('../ink/termio/osc.js');
    expect(CLEAR_ITERM2_PROGRESS).toBe('');
  });

  it('CLEAR_TAB_STATUS is empty string', async () => {
    const { CLEAR_TAB_STATUS } = await import('../ink/termio/osc.js');
    expect(CLEAR_TAB_STATUS).toBe('');
  });

  it('CLEAR_TERMINAL_TITLE is empty string', async () => {
    const { CLEAR_TERMINAL_TITLE } = await import('../ink/termio/osc.js');
    expect(CLEAR_TERMINAL_TITLE).toBe('');
  });

  it('LINK_END is empty string', async () => {
    const { LINK_END } = await import('../ink/termio/osc.js');
    expect(LINK_END).toBe('');
  });

  it('wrapForMultiplexer() returns sequence unchanged', async () => {
    const { wrapForMultiplexer } = await import('../ink/termio/osc.js');
    const seq = '\x1b]52;c=test\x07';
    expect(wrapForMultiplexer(seq)).toBe(seq);
  });

  it('getClipboardPath() returns osc52', async () => {
    const { getClipboardPath } = await import('../ink/termio/osc.js');
    expect(getClipboardPath()).toBe('osc52');
  });
});
