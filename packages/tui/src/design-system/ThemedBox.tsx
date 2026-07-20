import React from 'react';
import type { Props as BoxProps } from '../ink/components/Box.js';
import Box from '../ink/components/Box.js';
import { useTheme } from './ThemeProvider.js';
import type { ThemeColorKey } from './theme.js';

export type ThemedBoxProps = Omit<BoxProps, 'borderColor' | 'backgroundColor'> & {
  borderTheme?: ThemeColorKey;
  backgroundTheme?: ThemeColorKey;
};

export default function ThemedBox({
  borderTheme,
  backgroundTheme,
  ...rest
}: ThemedBoxProps & { children?: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();

  const borderColor = borderTheme ? theme[borderTheme] : (rest as BoxProps).borderColor;
  const backgroundColor = backgroundTheme
    ? theme[backgroundTheme]
    : (rest as BoxProps).backgroundColor;

  return React.createElement(Box, {
    ...rest,
    ...(borderColor && { borderColor }),
    ...(backgroundColor && { backgroundColor }),
  });
}
