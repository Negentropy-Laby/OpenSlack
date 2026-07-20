import React from 'react';
import Box from '../ink/components/Box.js';
import Text from '../ink/components/Text.js';
import ThemedText from './ThemedText.js';
import StatusIcon from './StatusIcon.js';

export type ListItemProps = {
  label: string;
  detail?: string;
  bullet?: string;
  status?: string;
};

export default function ListItem({
  label,
  detail,
  bullet = '•',
  status,
}: ListItemProps): React.JSX.Element {
  const icon = status
    ? React.createElement(StatusIcon, { status })
    : React.createElement(ThemedText, { colorTheme: 'muted' }, `${bullet} `);

  const labelLine = React.createElement(
    Box,
    { flexDirection: 'row' },
    icon,
    React.createElement(Text, null, ' '),
    React.createElement(ThemedText, { colorTheme: 'foreground' }, label),
  );

  if (!detail) return labelLine;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    labelLine,
    React.createElement(
      Box,
      { marginLeft: 3 },
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, detail),
    ),
  );
}
