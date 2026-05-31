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
import type { DigestViewModel, DigestGroupViewModel } from '../view-models/digest.js'

export type DigestViewProps = {
  model: DigestViewModel
  onBack?: () => void
}

function renderGroup(group: DigestGroupViewModel, index: number): React.ReactNode {
  if (group.events.length === 0) return null

  const iconCategory = group.status === 'fail' ? 'fail' : group.status === 'warn' ? 'warn' : group.status === 'pass' ? 'pass' : 'info'

  return React.createElement(
    Pane,
    { key: `group-${group.label}-${index}`, title: `${group.label} (${group.count})`, marginY: 0 },
    ...group.events.map((e, i) =>
      React.createElement(
        Box,
        { key: `${e.type}-${i}`, flexDirection: 'row' },
        React.createElement(StatusIcon, { category: iconCategory }),
        React.createElement(Text, null, ' '),
        React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(
            ThemedText,
            { colorTheme: 'foreground' },
            `${e.time} ${e.type}`,
          ),
          e.summary
            ? React.createElement(
                ThemedText,
                { colorTheme: 'muted', dim: true },
                `${e.summary.slice(0, 70)}${e.summary.length > 70 ? '...' : ''}`,
              )
            : null,
          React.createElement(
            ThemedText,
            { colorTheme: 'muted', dim: true },
            `${e.objectKind}:${e.objectId}`,
          ),
        ),
      ),
    ),
  )
}

export default function DigestView({ model, onBack }: DigestViewProps): React.JSX.Element {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) onBack()
      else exit()
    }
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, model.title),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted', dim: true },
      `Last ${model.periodHours}h · ${model.totalEvents} events`,
    ),
    React.createElement(Divider, { length: 40 }),

    // Groups
    model.groups.length > 0
      ? model.groups.map((g, i) => renderGroup(g, i))
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No activity in this period.'),

    // Recommended Next Actions
    model.recommendedNext.length > 0
      ? React.createElement(
          Pane,
          { title: 'Recommended Next Actions', marginY: 0 },
          ...model.recommendedNext.map((r, i) =>
            React.createElement(
              Box,
              { key: `next-${i}`, flexDirection: 'row' },
              React.createElement(StatusIcon, { category: 'warn' }),
              React.createElement(Text, null, ' '),
              React.createElement(
                ThemedText,
                { colorTheme: 'warning' },
                `${r.objectKind}:${r.objectId}`,
              ),
              React.createElement(Text, null, ' — '),
              React.createElement(ThemedText, { colorTheme: 'foreground' }, r.action),
              ),
            ),
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
