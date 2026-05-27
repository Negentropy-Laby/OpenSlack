import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import ListItem from '../design-system/ListItem.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import type { RoomViewModel } from '../view-models/room.js'

export type RoomViewProps = {
  model: RoomViewModel
}

export default function RoomView({ model }: RoomViewProps): React.JSX.Element {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit()
    }
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `Room: ${model.roomId}`),
    React.createElement(Divider, { length: 50 }),

    // Source + Owner row
    model.sourceUrl
      ? React.createElement(ThemedText, { colorTheme: 'muted' }, `Source: ${model.sourceUrl}`)
      : null,
    model.owner
      ? React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'foreground' }, 'Owner: '),
          React.createElement(ThemedText, { colorTheme: 'info' }, model.owner),
        )
      : null,
    model.nextAction
      ? React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'foreground' }, 'Next: '),
          React.createElement(ThemedText, { colorTheme: 'warning' }, model.nextAction),
        )
      : null,

    React.createElement(Divider, { length: 40 }),

    // Blockers
    model.blockers.length > 0
      ? React.createElement(
          Pane,
          { title: `Blockers (${model.blockerCount})`, marginY: 0 },
          ...model.blockers.map(b =>
            React.createElement(ListItem, {
              key: `${b.type}-${b.timestamp}`,
              label: `${b.type}`,
              detail: `${b.summary} (${b.timestamp})`,
              status: 'FAIL',
            }),
          ),
        )
      : React.createElement(ThemedText, { colorTheme: 'pass' }, '✓ No blockers'),

    // Handoffs
    model.handoffs.length > 0
      ? React.createElement(
          Pane,
          { title: `Handoffs (${model.handoffs.length})`, marginY: 0 },
          ...model.handoffs.map(h =>
            React.createElement(ListItem, {
              key: h.id,
              label: `${h.from} → ${h.to}`,
              detail: `${h.context} (${h.status})`,
              status: h.status === 'open' ? 'WARN' : 'PASS',
            }),
          ),
        )
      : null,

    // Decisions
    model.decisions.length > 0
      ? React.createElement(
          Pane,
          { title: `Decisions (${model.decisions.length})`, marginY: 0 },
          ...model.decisions.map(d =>
            React.createElement(ListItem, {
              key: d.id,
              label: d.topic,
              detail: `${d.decision} (${d.status})`,
              status: 'PASS',
            }),
          ),
        )
      : null,

    // Recent Activity
    model.recentActivity.length > 0
      ? React.createElement(
          Pane,
          { title: `Recent Activity (${model.recentActivity.length})`, marginY: 0 },
          ...model.recentActivity.map((a, i) =>
            React.createElement(ListItem, {
              key: `${a.type}-${i}`,
              label: a.summary,
              detail: `${a.time} · ${a.actor}`,
              status: a.type.includes('blocked') ? 'FAIL' : a.type.includes('passed') ? 'PASS' : 'info',
            }),
          ),
        )
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No activity found for this room.'),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'exit' }),
    ),
  )
}
