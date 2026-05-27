import React from 'react'
import ThemedText from './ThemedText.js'

export type KeyboardShortcutHintProps = {
  keys: string[]
  description?: string
}

export default function KeyboardShortcutHint({
  keys,
  description,
}: KeyboardShortcutHintProps): React.JSX.Element {
  const keyStr = keys.join('/')
  const parts: string[] = [`[${keyStr}]`]
  if (description) parts.push(` ${description}`)

  return React.createElement(
    ThemedText,
    { colorTheme: 'muted', dim: true },
    parts.join(''),
  )
}
