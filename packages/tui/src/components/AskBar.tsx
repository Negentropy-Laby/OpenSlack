import React from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import ThemedText from '../design-system/ThemedText.js';

export interface AskBarSubmit {
  text: string;
}

export interface AskBarProps {
  value: string;
  focused: boolean;
  busy?: boolean;
  threadId?: string;
  message?: string;
}

export default function AskBar({
  value,
  focused,
  busy = false,
  threadId,
  message,
}: AskBarProps): React.JSX.Element {
  const prompt = focused ? '>' : ' ';
  const renderedValue = value.length > 0 ? value : 'What do you want OpenSlack to do?';

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'Ask OpenSlack:'),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(
        ThemedText,
        { colorTheme: focused ? 'accent' : 'muted', bold: focused },
        prompt,
      ),
      React.createElement(Text, null, ' '),
      React.createElement(
        ThemedText,
        { colorTheme: value.length > 0 ? 'foreground' : 'muted', dim: value.length === 0 },
        renderedValue,
      ),
      busy
        ? React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '  planning...')
        : null,
    ),
    threadId
      ? React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `Thread: ${threadId}`)
      : null,
    message ? React.createElement(ThemedText, { colorTheme: 'info' }, message) : null,
  );
}
