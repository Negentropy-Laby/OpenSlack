import React, { useCallback, useState } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import { useNavigation } from '../navigation/context.js'
import type { HomeViewModel } from '../view-models/home.js'

export type HomeViewProps = {
  model: HomeViewModel
}

/**
 * Combined selectable item for the unified keyboard handler.
 * Attention items come first (index 0..n-1), nav items follow (index n..m).
 */
interface CombinedItem {
  label: string
  detail?: string
  route: string
  kind: 'attention' | 'nav'
  colorTheme: 'warning' | 'info' | 'accent'
  shortcut?: string
}

function buildCombinedItems(model: HomeViewModel): CombinedItem[] {
  const items: CombinedItem[] = []

  for (const a of model.attentionItems) {
    items.push({
      label: a.label,
      detail: a.detail,
      route: a.route,
      kind: 'attention',
      colorTheme: a.colorTheme,
    })
  }

  for (const n of model.navItems) {
    items.push({
      label: n.label,
      route: n.key,
      kind: 'nav',
      colorTheme: 'accent',
      shortcut: n.shortcut,
    })
  }

  return items
}

export default function HomeView({ model }: HomeViewProps): React.JSX.Element {
  const { exit } = useApp()
  const { push } = useNavigation()

  const combined = buildCombinedItems(model)
  const attentionCount = model.attentionItems.length
  const totalCount = combined.length

  const [selectedIndex, setSelectedIndex] = useState(0)

  const handleItemClick = useCallback((index: number) => {
    push({ view: combined[index].route })
  }, [combined, push])

  const handleItemHover = useCallback((index: number) => {
    setSelectedIndex(index)
  }, [])

  // Number shortcut lookup
  const shortcutMap = new Map<string, number>()
  for (let i = attentionCount; i < totalCount; i++) {
    const shortcut = combined[i].shortcut
    if (shortcut) {
      shortcutMap.set(shortcut, i)
    }
  }

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit()
      return
    }

    // Number shortcuts 1-5 for quick navigation
    const shortcutIndex = shortcutMap.get(input)
    if (shortcutIndex !== undefined) {
      push({ view: combined[shortcutIndex].route })
      return
    }

    if (key.upArrow) {
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : totalCount - 1))
    } else if (key.downArrow) {
      setSelectedIndex(prev => (prev < totalCount - 1 ? prev + 1 : 0))
    } else if (key.return) {
      if (combined[selectedIndex]) {
        push({ view: combined[selectedIndex].route })
      }
    }
  })

  // Render attention section items
  const attentionElements: React.ReactNode[] = []
  for (let i = 0; i < attentionCount; i++) {
    const item = combined[i]
    const isSelected = selectedIndex === i
    attentionElements.push(renderItemRow(item, isSelected, i, handleItemClick, handleItemHover))
  }

  // Render nav section items
  const navElements: React.ReactNode[] = []
  for (let i = attentionCount; i < totalCount; i++) {
    const item = combined[i]
    const isSelected = selectedIndex === i
    navElements.push(renderItemRow(item, isSelected, i, handleItemClick, handleItemHover))
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

    // Section 1: Needs Attention
    React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 0, marginBottom: 0 },
      React.createElement(
        ThemedText,
        { colorTheme: 'warning', bold: true },
        'Needs Attention',
      ),
      attentionCount > 0
        ? React.createElement(
            Box,
            { flexDirection: 'column' },
            ...attentionElements,
          )
        : React.createElement(
            Box,
            { marginLeft: 2, marginTop: 0, marginBottom: 0 },
            React.createElement(
              ThemedText,
              { colorTheme: 'success' },
              'Nothing needs attention right now',
            ),
          ),
    ),

    React.createElement(Divider, { length: 40 }),

    // Section 2: Quick Navigation
    React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 0, marginBottom: 0 },
      React.createElement(
        ThemedText,
        { colorTheme: 'accent', bold: true },
        'Quick Navigation',
      ),
      React.createElement(
        Box,
        { flexDirection: 'column' },
        ...navElements,
      ),
    ),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Quit' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Up/Down'], description: 'Navigate' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'Select' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['1-6'], description: 'Jump' }),
    ),
  )
}

/**
 * Renders a single selectable row.
 */
function renderItemRow(
  item: CombinedItem,
  isSelected: boolean,
  index: number,
  onItemClick: (index: number) => void,
  onItemHover: (index: number) => void,
): React.ReactNode {
  const pointer = isSelected ? '>' : ' '
  const colorTheme = isSelected ? item.colorTheme : 'muted'

  const labelColorTheme = isSelected ? item.colorTheme : 'foreground'

  let labelContent: string = item.label
  if (item.kind === 'nav' && item.shortcut) {
    labelContent = item.label
  }

  const labelElement = isSelected
    ? React.createElement(ThemedText, { colorTheme: labelColorTheme, bold: true }, labelContent)
    : React.createElement(ThemedText, { colorTheme: 'foreground' }, labelContent)

  const shortcutElement = item.shortcut
    ? React.createElement(
        Box,
        { marginRight: 1 },
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `[${item.shortcut}]`),
      )
    : null

  const detailElement = item.detail
    ? React.createElement(
        Box,
        { marginLeft: 4 },
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, item.detail),
      )
    : null

  return React.createElement(
    Box,
    {
      key: `${item.kind}-${item.route}-${item.label}`,
      flexDirection: 'column',
      onClick: () => onItemClick(index),
      onMouseEnter: () => onItemHover(index),
    },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: isSelected ? colorTheme : 'muted' }, pointer),
      React.createElement(Text, null, ' '),
      shortcutElement,
      labelElement,
    ),
    detailElement,
  )
}
