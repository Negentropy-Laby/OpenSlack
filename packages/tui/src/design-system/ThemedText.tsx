import React from 'react'
import Text from '../ink/components/Text.js'
import { useTheme } from './ThemeProvider.js'
import type { ThemeColorKey } from './theme.js'
import type { Color } from '../ink/styles.js'

type BaseProps = {
  colorTheme?: ThemeColorKey
  backgroundColorTheme?: ThemeColorKey
  color?: Color
  backgroundColor?: Color
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
  wrap?: 'wrap' | 'wrap-trim' | 'end' | 'middle' | 'truncate-end' | 'truncate' | 'truncate-middle' | 'truncate-start'
  children?: React.ReactNode
}

type WeightProps =
  | { bold?: never; dim?: never }
  | { bold: boolean; dim?: never }
  | { dim: boolean; bold?: never }

export type ThemedTextProps = BaseProps & WeightProps

export default function ThemedText(props: ThemedTextProps): React.JSX.Element {
  const theme = useTheme()

  const color = props.colorTheme ? theme[props.colorTheme] : props.color
  const backgroundColor = props.backgroundColorTheme ? theme[props.backgroundColorTheme] : props.backgroundColor

  const textProps: Record<string, unknown> = {
    color,
    backgroundColor,
    italic: props.italic,
    underline: props.underline,
    strikethrough: props.strikethrough,
    inverse: props.inverse,
    wrap: props.wrap,
    children: props.children,
  }

  if ('bold' in props && props.bold) {
    textProps.bold = true
  } else if ('dim' in props && props.dim) {
    textProps.dim = true
  }

  return React.createElement(Text, textProps as React.Attributes & { children?: React.ReactNode })
}
