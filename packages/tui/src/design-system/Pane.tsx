import React from 'react'
import type { ThemedBoxProps } from './ThemedBox.js'
import ThemedBox from './ThemedBox.js'
import ThemedText from './ThemedText.js'

export type PaneProps = ThemedBoxProps & {
  title?: string
  padding?: number
}

export default function Pane({
  title,
  padding = 1,
  children,
  ...rest
}: PaneProps & { children?: React.ReactNode }): React.JSX.Element {
  const inner: React.ReactNode[] = []

  if (title) {
    inner.push(React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, title))
  }

  inner.push(children)

  return React.createElement(
    ThemedBox,
    {
      ...rest,
      borderStyle: 'single',
      borderTheme: 'border',
      padding,
      flexDirection: 'column',
      overflow: 'hidden',
    },
    ...inner,
  )
}
