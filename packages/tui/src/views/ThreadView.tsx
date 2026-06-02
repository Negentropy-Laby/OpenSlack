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
import type { ThreadViewModel, ThreadMessageItem } from '../view-models/conversation.js'

export type ThreadViewProps = {
  model: ThreadViewModel
  onBack?: () => void
}

function renderMessage(msg: ThreadMessageItem): React.JSX.Element {
  switch (msg.kind) {
    case 'user_message':
      return React.createElement(
        Box,
        { flexDirection: 'column', marginBottom: 0 },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'info', bold: true }, '●'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'info', bold: true }, msg.authorDisplay),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, msg.timestamp),
        ),
        React.createElement(
          Box,
          { marginLeft: 2 },
          React.createElement(ThemedText, { colorTheme: 'foreground' }, msg.content),
        ),
      )

    case 'agent_response':
      return React.createElement(
        Box,
        { flexDirection: 'column', marginBottom: 0 },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'pass', bold: true }, '●'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'pass', bold: true }, msg.authorDisplay),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, msg.timestamp),
        ),
        React.createElement(
          Box,
          { marginLeft: 2 },
          React.createElement(ThemedText, { colorTheme: 'foreground' }, msg.content),
        ),
      )

    case 'tool_event':
      return React.createElement(
        Box,
        { flexDirection: 'column', marginBottom: 0 },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '⚙'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, msg.authorDisplay),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, msg.content),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, msg.timestamp),
        ),
      )

    case 'plan':
      return React.createElement(
        Box,
        { flexDirection: 'column', marginBottom: 0 },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'warning', bold: true }, '◆'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'warning', bold: true }, 'Plan'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, msg.timestamp),
        ),
        React.createElement(
          Box,
          { marginLeft: 2 },
          React.createElement(ThemedText, { colorTheme: 'foreground' }, msg.content),
        ),
      )

    case 'approval_request':
      return React.createElement(
        Box,
        { flexDirection: 'column', marginBottom: 0 },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'warning', bold: true }, '⚠'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'warning', bold: true }, 'Approval Request'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, msg.timestamp),
        ),
        React.createElement(
          Box,
          { marginLeft: 2 },
          React.createElement(ThemedText, { colorTheme: 'foreground' }, msg.content),
          ...(msg.metadata?.riskLevel
            ? [
                React.createElement(Text, null, ' '),
                React.createElement(ThemedText, { colorTheme: 'warning' }, `[Risk: ${msg.metadata.riskLevel}]`),
              ]
            : []),
        ),
      )

    case 'decision':
      return React.createElement(
        Pane,
        { title: 'Decision', marginY: 0 },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, '◆'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, msg.authorDisplay),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, msg.timestamp),
        ),
        React.createElement(ThemedText, { colorTheme: 'foreground' }, msg.content),
      )

    case 'handoff':
      return React.createElement(
        Box,
        { flexDirection: 'column', marginBottom: 0 },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'info', bold: true }, '→'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'info', bold: true }, 'Handoff'),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, msg.timestamp),
        ),
        React.createElement(
          Box,
          { marginLeft: 2 },
          React.createElement(ThemedText, { colorTheme: 'foreground' }, msg.content),
          ...(msg.metadata?.toParticipant
            ? [
                React.createElement(Text, null, ' '),
                React.createElement(ThemedText, { colorTheme: 'info' }, `→ ${msg.metadata.toParticipant}`),
              ]
            : []),
        ),
      )
  }
}

export default function ThreadView({ model, onBack }: ThreadViewProps): React.JSX.Element {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) onBack()
      else exit()
    }
  })

  const statusCat = model.status === 'active' ? 'pass' : model.status === 'paused' ? 'warn' : 'info'

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(StatusIcon, { category: statusCat }),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, model.title),
    ),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `Status: ${model.status} · ${model.participants.length} participants`),
    ),
    React.createElement(Divider, { length: 40 }),

    // Participants panel
    model.participants.length > 0
      ? React.createElement(
          Pane,
          { title: 'Participants', marginY: 0 },
          ...model.participants.map(p =>
            React.createElement(
              Box,
              { key: p.id, flexDirection: 'row' },
              React.createElement(ThemedText, { colorTheme: 'foreground' }, p.displayName),
              React.createElement(Text, null, ' '),
              React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `(${p.kind})`),
            ),
          ),
        )
      : null,

    // Messages
    model.messages.length > 0
      ? React.createElement(
          Box,
          { flexDirection: 'column', marginY: 0 },
          ...model.messages.map(msg =>
            React.createElement(
              Box,
              { key: msg.id, flexDirection: 'column' },
              renderMessage(msg),
            ),
          ),
        )
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No messages in this thread.'),

    // Linked objects
    model.linkedObjects.length > 0
      ? React.createElement(
          Pane,
          { title: 'Linked Objects', marginY: 0 },
          ...model.linkedObjects.map(obj =>
            React.createElement(
              Box,
              { key: `${obj.kind}-${obj.id}`, flexDirection: 'row' },
              React.createElement(ThemedText, { colorTheme: 'foreground' }, `${obj.kind}:${obj.id}`),
              ...(obj.url
                ? [
                    React.createElement(Text, null, ' '),
                    React.createElement(ThemedText, { colorTheme: 'info' }, obj.url),
                  ]
                : []),
            ),
          ),
        )
      : null,

    // Next action
    model.nextAction
      ? React.createElement(
          Box,
          { flexDirection: 'column', marginY: 0 },
          React.createElement(Divider, { length: 40 }),
          React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'warning', bold: true }, 'Next: '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, model.nextAction.action),
            React.createElement(Text, null, ' '),
            React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `by ${model.nextAction.owner}`),
          ),
          model.nextAction.command
            ? React.createElement(
                Box,
                { marginLeft: 2 },
                React.createElement(ThemedText, { colorTheme: 'info' }, `Run: ${model.nextAction.command}`),
              )
            : null,
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
