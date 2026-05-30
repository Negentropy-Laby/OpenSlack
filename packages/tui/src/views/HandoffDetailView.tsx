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
import type { HandoffDetailViewModel } from '../view-models/handoff.js'

export type HandoffDetailViewProps = {
  model: HandoffDetailViewModel
  onBack?: () => void
}

export default function HandoffDetailView({ model, onBack }: HandoffDetailViewProps): React.JSX.Element {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) onBack()
      else exit()
    }
  })

  const statusIcon = model.status === 'open' ? 'warn' : model.status === 'accepted' ? 'pass' : 'info'

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `Handoff: ${model.id}`),
    React.createElement(Divider, { length: 40 }),

    // Status row
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(StatusIcon, { category: statusIcon }),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, `Status: ${model.status}`),
    ),

    // Details
    React.createElement(
      Box,
      { flexDirection: 'column', marginY: 1 },
      React.createElement(ThemedText, { colorTheme: 'foreground' }, `From: ${model.from}`),
      React.createElement(ThemedText, { colorTheme: 'foreground' }, `To: ${model.to}`),
      React.createElement(ThemedText, { colorTheme: 'muted' }, `Created: ${model.createdAt}`),
      model.acceptedAt ? React.createElement(ThemedText, { colorTheme: 'muted' }, `Accepted: ${model.acceptedAt}`) : null,
      model.closedAt ? React.createElement(ThemedText, { colorTheme: 'muted' }, `Closed: ${model.closedAt}`) : null,
      model.issueRef ? React.createElement(ThemedText, { colorTheme: 'info' }, `Issue: ${model.issueRef}`) : null,
      model.prRef ? React.createElement(ThemedText, { colorTheme: 'info' }, `PR: ${model.prRef}`) : null,
    ),

    React.createElement(Divider, { length: 40 }),

    // Context
    React.createElement(Pane, { title: 'Context', marginY: 0 },
      React.createElement(ThemedText, { colorTheme: 'foreground' }, model.context),
    ),

    // Next steps
    model.nextSteps.length > 0
      ? React.createElement(
          Pane,
          { title: 'Next Steps', marginY: 0 },
          ...model.nextSteps.map((step, i) =>
            React.createElement(
              ThemedText,
              { key: `step-${i}`, colorTheme: 'foreground' },
              `  • ${step}`,
            ),
          ),
        )
      : null,

    // Notes
    model.notes
      ? React.createElement(Pane, { title: 'Notes', marginY: 0 },
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.notes),
        )
      : null,

    // Actions hint
    React.createElement(Divider, { length: 40 }),
    model.canAccept
      ? React.createElement(ThemedText, { colorTheme: 'warning' }, 'This handoff can be accepted.')
      : null,
    model.canClose && !model.canAccept
      ? React.createElement(ThemedText, { colorTheme: 'warning' }, 'This handoff can be closed.')
      : null,

    // Footer
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  )
}
