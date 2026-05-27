import React from 'react'
import Box from '../ink/components/Box.js'
import ThemedText from './ThemedText.js'

export type ProgressBarProps = {
  value: number
  max?: number
  width?: number
  label?: string
}

export default function ProgressBar({
  value,
  max = 100,
  width = 20,
  label,
}: ProgressBarProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(value, max))
  const pct = Math.round((clamped / max) * 100)
  const filled = Math.round((clamped / max) * width)
  const empty = width - filled

  const fill = '█'.repeat(filled)
  const track = '░'.repeat(empty)

  const children: React.ReactNode[] = []
  if (label) {
    children.push(React.createElement(ThemedText, { colorTheme: 'foreground' }, `${label} `))
  }
  children.push(
    React.createElement(ThemedText, { colorTheme: 'success' }, fill),
    React.createElement(ThemedText, { colorTheme: 'muted' }, `${track} ${pct}%`),
  )

  return React.createElement(Box, null, ...children)
}
