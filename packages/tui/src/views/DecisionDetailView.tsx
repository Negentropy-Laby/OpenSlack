import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import type { DecisionDetailViewModel } from '../view-models/decision.js'

export type DecisionDetailViewProps = {
  model: DecisionDetailViewModel
  onBack?: () => void
}

export default function DecisionDetailView({ model, onBack }: DecisionDetailViewProps): React.JSX.Element {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) onBack()
      else exit()
    }
  })

  const statusIcon = model.status === 'active' ? 'pass' : 'warn'

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `Decision: ${model.id}`),
    React.createElement(Divider, { length: 40 }),

    // Status row
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(StatusIcon, { category: statusIcon }),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, `Status: ${model.status}`),
    ),

    // Core details
    React.createElement(
      Box,
      { flexDirection: 'column', marginY: 1 },
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, 'Topic'),
      React.createElement(ThemedText, { colorTheme: 'foreground' }, model.topic),
      React.createElement(Text, null, ''),
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, 'Decision'),
      React.createElement(ThemedText, { colorTheme: 'foreground' }, model.decision),
      React.createElement(Text, null, ''),
      React.createElement(ThemedText, { colorTheme: 'muted' }, `By: ${model.decidedBy} · Created: ${model.createdAt}`),
    ),

    React.createElement(Divider, { length: 40 }),

    // Rationale
    React.createElement(Pane, { title: 'Rationale', marginY: 0 },
      React.createElement(ThemedText, { colorTheme: 'foreground' }, model.rationale),
    ),

    // Alternatives
    model.alternatives.length > 0
      ? React.createElement(
          Pane,
          { title: 'Alternatives Considered', marginY: 0 },
          ...model.alternatives.map((alt, i) =>
            React.createElement(
              ThemedText,
              { key: `alt-${i}`, colorTheme: 'foreground' },
              `  • ${alt}`,
            ),
          ),
        )
      : null,

    // Consequences
    model.consequences.length > 0
      ? React.createElement(
          Pane,
          { title: 'Consequences', marginY: 0 },
          ...model.consequences.map((cons, i) =>
            React.createElement(
              ThemedText,
              { key: `cons-${i}`, colorTheme: 'foreground' },
              `  • ${cons}`,
            ),
          ),
        )
      : null,

    // Tags
    model.tags.length > 0
      ? React.createElement(
          Box,
          { flexDirection: 'row', marginY: 1 },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Tags: '),
          ...model.tags.map((tag, i) =>
            React.createElement(
              ThemedText,
              { key: `tag-${i}`, colorTheme: 'info' },
              `${tag}${i < model.tags.length - 1 ? ', ' : ''}`,
            ),
          ),
        )
      : null,

    // Superseded notice
    model.supersededBy
      ? React.createElement(
          Pane,
          { title: 'Superseded', marginY: 0 },
          React.createElement(ThemedText, { colorTheme: 'warning' }, `Superseded by: ${model.supersededBy}`),
          model.supersededAt ? React.createElement(ThemedText, { colorTheme: 'muted' }, `At: ${model.supersededAt}`) : null,
        )
      : null,

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  )
}
