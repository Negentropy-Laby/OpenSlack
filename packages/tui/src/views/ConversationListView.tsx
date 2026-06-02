import React, { useCallback } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import SelectableList from '../design-system/SelectableList.js'
import type {
  ConversationListViewModel,
  ConversationListItem,
} from '../view-models/conversation.js'

export type ConversationListViewProps = {
  model: ConversationListViewModel
  onSelect?: (item: ConversationListItem) => void
  onBack?: () => void
}

function statusToCategory(status: string): 'pass' | 'warn' | 'info' | 'fail' {
  switch (status) {
    case 'active':
      return 'pass'
    case 'open':
      return 'info'
    case 'paused':
      return 'warn'
    case 'completed':
    case 'archived':
      return 'info'
    default:
      return 'info'
  }
}

export default function ConversationListView({
  model,
  onSelect,
  onBack,
}: ConversationListViewProps): React.JSX.Element {
  const { exit } = useApp()

  const handleSelect = useCallback(
    (item: { key: string }) => {
      if (onSelect) {
        const found = model.items.find(i => i.id === item.key)
        if (found) onSelect(found)
      }
    },
    [model.items, onSelect],
  )

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
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'foreground' }, `${model.totalCount} total`),
      React.createElement(Text, null, ' · '),
      model.activeCount > 0
        ? React.createElement(ThemedText, { colorTheme: 'pass' }, `${model.activeCount} active`)
        : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No active'),
    ),
    React.createElement(Divider, { length: 40 }),

    // List or empty state
    model.items.length > 0
      ? React.createElement(
          SelectableList,
          {
            items: model.items.map(item => ({
              key: item.id,
              label: `${item.title}  [${item.participantCount}]  ${item.lastActivity}`,
              detail: `Status: ${item.status}${
                item.linkedObjects.length > 0
                  ? ` · Linked: ${item.linkedObjects.map(o => `${o.kind}:${o.id}`).join(', ')}`
                  : ''
              }`,
            })),
            onSelect: handleSelect,
          },
        )
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No conversations found.'),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['↑', '↓'], description: 'navigate' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'select' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  )
}
