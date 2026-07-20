import React from 'react';
import render from './ink/root.js';
import { ThemeProvider } from './design-system/ThemeProvider.js';
import { isTuiSupported } from './capabilities.js';
import { ENTER_ALT_SCREEN, ENABLE_MOUSE_TRACKING } from './ink/termio/dec.js';
import { getClearTerminalSequence } from './ink/clearTerminal.js';
import type { ThemeMode } from './design-system/theme.js';

export interface RenderTuiOptions {
  mode?: ThemeMode;
  stdout?: NodeJS.WriteStream;
}

/**
 * Detect whether the terminal properly supports DEC alternate screen (mode 1049).
 * Windows conhost (legacy PowerShell/CMD) partially handles mode 1049 in a way
 * that corrupts display state: ENTER_ALT_SCREEN is ignored or partially
 * processed, but ERASE_SCREEN still clears the buffer, and EXIT_ALT_SCREEN
 * does not reliably restore the prior screen. Windows Terminal, VS Code,
 * and Unix terminals handle it correctly.
 *
 * Mouse click/hover works in both modes because dispatchClick/dispatchHover
 * no longer gates on altScreenActive.
 */
function supportsAltScreen(stdout: NodeJS.WriteStream): boolean {
  if (!stdout.isTTY) return false;
  if (process.platform !== 'win32') return true;
  // Windows Terminal sets WT_SESSION; VS Code sets TERM_PROGRAM=vscode
  return !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode';
}

export async function renderTui(
  node: React.ReactElement,
  options?: RenderTuiOptions,
): Promise<{ unmount: () => void }> {
  if (!isTuiSupported() && !options?.stdout) {
    throw new Error(
      'TUI is not supported in this terminal. Use --format standard for text output, or the plain renderer will be used automatically.',
    );
  }

  const wrapped = React.createElement(ThemeProvider, { mode: options?.mode }, node);

  const stdout = options?.stdout ?? process.stdout;

  // Send terminal setup sequences BEFORE rendering so Ink starts drawing
  // from the viewport top-left (row 0). This ensures nodeCache rects map
  // 1:1 to terminal mouse coordinates (col, row).
  //
  // Without this, Ink draws at the current cursor position (which may be
  // mid-screen after previous shell output). DOM y=0 then maps to a
  // non-zero terminal row, causing hit-test to mismatch by that offset.
  if (stdout.isTTY) {
    if (supportsAltScreen(stdout)) {
      // Alt-screen terminals: enter alt buffer + clear (including scrollback) + home cursor.
      // Content renders into the blank alt-screen starting at (0,0).
      stdout.write(ENTER_ALT_SCREEN + getClearTerminalSequence());
    } else {
      // Main-screen terminals: clear viewport + scrollback + home cursor.
      // Without scrollback clear, stale content can bleed through when
      // the TUI scrolls the viewport (see log-update.ts main-screen path).
      stdout.write(getClearTerminalSequence());
    }
  }

  const instance = await render(wrapped, {
    stdout: options?.stdout,
    patchConsole: true,
  });

  // Set internal flags AFTER rendering so the first frame already used
  // the correct terminal state (alt-screen or main-screen).
  // For alt-screen terminals this also resets frame caches for next diff.
  if (supportsAltScreen(stdout)) {
    instance.setAltScreenActive(true, true);
  } else if (stdout.isTTY) {
    stdout.write(ENABLE_MOUSE_TRACKING);
  }

  return { unmount: () => instance.unmount() };
}
