// @openslack/tui — Action status indicator component

import React from 'react';
import ThemedBox from './ThemedBox.js';
import ThemedText from './ThemedText.js';
import { useAnimationTimer } from '../ink/hooks/use-interval.js';
import { sanitizeTerminalText } from '../sanitize.js';
import type { TuiActionState } from '../actions/types.js';
import { TuiActionStatus } from '../actions/types.js';

const SPINNER_FRAMES = ['|', '/', '-', '\\'];
const SPINNER_INTERVAL_MS = 120;

export interface ActionStatusProps {
  /** Current action state to render. */
  state: TuiActionState;
  /** Optional label to show alongside status. */
  label?: string;
}

export default function ActionStatus({
  state,
  label,
}: ActionStatusProps): React.JSX.Element | null {
  if (state.status === TuiActionStatus.Idle) return null;

  const safeLabel = label ? sanitizeTerminalText(label) : undefined;

  if (state.status === TuiActionStatus.Executing) {
    return React.createElement(SpinnerRow, { label: safeLabel });
  }

  if (state.status === TuiActionStatus.Success) {
    const message = state.result ? sanitizeTerminalText(state.result.message) : 'Done';
    return React.createElement(
      ThemedBox,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'success', bold: true }, ' OK '),
      safeLabel
        ? React.createElement(ThemedText, { colorTheme: 'foreground' }, ` ${safeLabel}: `)
        : React.createElement(ThemedText, { colorTheme: 'foreground' }, ' '),
      React.createElement(ThemedText, { colorTheme: 'success' }, message),
    );
  }

  if (state.status === TuiActionStatus.Error) {
    const errorText = state.error
      ? sanitizeTerminalText(state.error)
      : state.result
        ? sanitizeTerminalText(state.result.message)
        : 'Unknown error';
    return React.createElement(
      ThemedBox,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'error', bold: true }, ' !! '),
      safeLabel
        ? React.createElement(ThemedText, { colorTheme: 'foreground' }, ` ${safeLabel}: `)
        : React.createElement(ThemedText, { colorTheme: 'foreground' }, ' '),
      React.createElement(ThemedText, { colorTheme: 'error' }, errorText),
    );
  }

  // Confirming state -- not typically rendered by ActionStatus, but handle gracefully
  return React.createElement(
    ThemedBox,
    { flexDirection: 'row' },
    React.createElement(ThemedText, { colorTheme: 'warning', bold: true }, ' ?? '),
    safeLabel
      ? React.createElement(ThemedText, { colorTheme: 'foreground' }, ` ${safeLabel}`)
      : null,
    React.createElement(ThemedText, { colorTheme: 'muted' }, ' awaiting confirmation'),
  );
}

/** Internal spinner sub-component. */
function SpinnerRow({ label }: { label?: string }): React.JSX.Element {
  const time = useAnimationTimer(SPINNER_INTERVAL_MS);
  const frameIndex = Math.floor(time / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  const frame = SPINNER_FRAMES[frameIndex];

  return React.createElement(
    ThemedBox,
    { flexDirection: 'row' },
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, ` ${frame} `),
    label
      ? React.createElement(ThemedText, { colorTheme: 'muted' }, ` ${label}...`)
      : React.createElement(ThemedText, { colorTheme: 'muted' }, ' Working...'),
  );
}
