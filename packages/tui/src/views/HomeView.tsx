import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import SelectableList from '../design-system/SelectableList.js'
import Divider from '../design-system/Divider.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import { useNavigation } from '../navigation/context.js'
import type { SelectableListItem } from '../design-system/SelectableList.js'
import type { HomeViewModel } from '../view-models/home.js'

export type HomeViewProps = {
  model: HomeViewModel
}

export default function HomeView({ model }: HomeViewProps): React.JSX.Element {
  const { exit } = useApp()
  const { push } = useNavigation()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit()
    }
  })

  const items: SelectableListItem[] = model.menuItems.map(item => ({
    label: item.label,
    detail: item.badge,
    key: item.key,
  }))

  const handleSelect = (item: SelectableListItem) => {
    push({ view: item.key })
  }

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack'),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, model.systemStatus),
    ),
    React.createElement(Divider, { length: 40 }),

    // Navigation menu
    React.createElement(
      Pane,
      { title: 'Navigate', marginY: 0 },
      React.createElement(SelectableList, {
        items,
        onSelect: handleSelect,
      }),
    ),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q'], description: 'Quit' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Up/Down'], description: 'Navigate' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'Select' }),
    ),
  )
}
