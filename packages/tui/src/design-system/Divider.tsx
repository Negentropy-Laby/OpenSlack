import React from 'react';
import ThemedText from './ThemedText.js';

export type DividerProps = {
  direction?: 'horizontal' | 'vertical';
  dashed?: boolean;
  length?: number;
};

export default function Divider({
  direction = 'horizontal',
  dashed = false,
  length = 40,
}: DividerProps): React.JSX.Element {
  const char = direction === 'vertical' ? '│' : dashed ? '╌' : '─';
  const line = char.repeat(length);
  return React.createElement(ThemedText, { colorTheme: 'border' }, line);
}
