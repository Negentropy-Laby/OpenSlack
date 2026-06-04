import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import ThemedText from '../design-system/ThemedText.js'
import type { ConversationActionCard } from '../views/render-shell.js'

const RISK_THEME: Record<ConversationActionCard['riskLevel'], 'muted' | 'info' | 'warning' | 'error'> = {
  none: 'muted',
  low: 'info',
  medium: 'warning',
  high: 'error',
}

export interface ActionCardProps {
  card: ConversationActionCard
  index: number
  selected: boolean
}

export default function ActionCard({ card, index, selected }: ActionCardProps): React.JSX.Element {
  const prefix = selected ? '>' : ' '
  const riskText = card.confirmationRequired
    ? `${card.riskLevel} risk, confirmation required`
    : `${card.riskLevel} risk`

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: selected ? 'accent' : 'muted', bold: selected }, prefix),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: selected ? 'accent' : 'foreground', bold: selected }, `[${index + 1}] ${card.label}`),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: RISK_THEME[card.riskLevel], dim: card.riskLevel === 'none' }, riskText),
    ),
    React.createElement(
      Box,
      { marginLeft: 4 },
      React.createElement(ThemedText, { colorTheme: 'muted' }, card.detail),
    ),
    card.command
      ? React.createElement(
          Box,
          { marginLeft: 4 },
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, card.command),
        )
      : null,
  )
}
