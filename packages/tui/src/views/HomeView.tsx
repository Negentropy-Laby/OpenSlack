import React, { useCallback } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import { useNavigation } from '../navigation/context.js'
import { useClampedIndex } from '../hooks/use-clamped-index.js'
import type { HomeViewModel, TaskItem, RecommendedAction } from '../view-models/home.js'

export type HomeViewProps = {
  model: HomeViewModel
}

/**
 * Goal-oriented group for task items.
 */
type TaskGroupCategory = 'start-work' | 'review-work' | 'govern' | 'maintain'

interface TaskGroup {
  category: TaskGroupCategory
  label: string
}

const TASK_GROUPS: TaskGroup[] = [
  { category: 'start-work', label: 'Start Work' },
  { category: 'review-work', label: 'Review Work' },
  { category: 'govern', label: 'Govern Actions' },
  { category: 'maintain', label: 'Maintain Profile' },
]

const TASK_KEY_TO_GROUP: Record<string, TaskGroupCategory> = {
  'start-work': 'start-work',
  'run-workflow': 'start-work',
  'see-attention': 'review-work',
  'review-prs': 'review-work',
  'approve-pending': 'govern',
  'maintain-profile': 'maintain',
}

const GROUP_ORDER: Record<TaskGroupCategory, number> = {
  'start-work': 0,
  'review-work': 1,
  'govern': 2,
  'maintain': 3,
}

/**
 * Combined selectable item for the unified keyboard handler.
 * Tasks come first (index 0..n-1), nav items follow (index n..m).
 */
interface CombinedItem {
  label: string
  detail?: string
  route: string
  kind: 'task' | 'nav'
  colorTheme: 'accent' | 'muted'
  shortcut: string
  attentionBadge?: string
  groupCategory?: TaskGroupCategory
}

const URGENCY_COLOR: Record<RecommendedAction['urgency'], 'warning' | 'info' | 'muted'> = {
  governance: 'warning',
  blocker: 'warning',
  operational: 'info',
  informational: 'muted',
}

function buildCombinedItems(model: HomeViewModel): CombinedItem[] {
  const items: CombinedItem[] = []

  // Build task items and sort by group order for visual grouping
  const taskItems = model.tasks.map(t => ({
    label: t.label,
    detail: t.description,
    route: t.route,
    kind: 'task' as const,
    colorTheme: 'accent' as const,
    shortcut: t.shortcut,
    attentionBadge: t.attentionBadge,
    groupCategory: (TASK_KEY_TO_GROUP[t.key] ?? 'start-work') as TaskGroupCategory,
  }))

  // Sort tasks by group order while preserving original order within same group
  const sortedTasks = taskItems.slice().sort((a, b) => {
    const ga = GROUP_ORDER[a.groupCategory ?? 'start-work']
    const gb = GROUP_ORDER[b.groupCategory ?? 'start-work']
    return ga - gb
  })

  items.push(...sortedTasks)

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
  const taskCount = model.tasks.length
  const totalCount = combined.length

  const [selectedIndex, setSelectedIndex] = useClampedIndex(totalCount)

  const handleItemClick = useCallback((index: number) => {
    push({ view: combined[index].route })
  }, [combined, push])

  const handleItemHover = useCallback((index: number) => {
    setSelectedIndex(index)
  }, [])

  // Shortcut lookup — all items have shortcuts
  const shortcutMap = new Map<string, number>()
  for (let i = 0; i < totalCount; i++) {
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

  // Render task section items grouped by category
  const taskElements: React.ReactNode[] = []
  let lastGroup: TaskGroupCategory | null = null
  for (let i = 0; i < taskCount; i++) {
    const item = combined[i]
    const group = item.groupCategory ?? 'start-work'
    if (group !== lastGroup) {
      const groupDef = TASK_GROUPS.find(g => g.category === group)
      if (groupDef) {
        taskElements.push(renderGroupHeader(groupDef.label))
      }
      lastGroup = group
    }
    const isSelected = selectedIndex === i
    taskElements.push(renderTaskRow(item, isSelected, i, handleItemClick, handleItemHover))
  }

  // Render nav section items
  const navElements: React.ReactNode[] = []
  for (let i = taskCount; i < totalCount; i++) {
    const item = combined[i]
    const isSelected = selectedIndex === i
    navElements.push(renderNavRow(item, isSelected, i, handleItemClick, handleItemHover))
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

    // Section 1: What do you want to do?
    React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 0, marginBottom: 0 },
      React.createElement(
        ThemedText,
        { colorTheme: 'accent', bold: true },
        'What do you want to do?',
      ),
      React.createElement(
        Box,
        { flexDirection: 'column' },
        ...taskElements,
      ),
    ),

    React.createElement(Divider, { length: 40 }),

    // Section: Next Recommended Action
    ...(model.nextRecommendedAction
      ? [
          React.createElement(
            Box,
            { flexDirection: 'column', marginTop: 0, marginBottom: 0 },
            React.createElement(
              Box,
              { flexDirection: 'row' },
              React.createElement(
                ThemedText,
                { colorTheme: URGENCY_COLOR[model.nextRecommendedAction.urgency], bold: true },
                '>',
              ),
              React.createElement(Text, null, ' '),
              React.createElement(
                ThemedText,
                { colorTheme: URGENCY_COLOR[model.nextRecommendedAction.urgency] },
                `Next: ${model.nextRecommendedAction.label}`,
              ),
            ),
            React.createElement(
              Box,
              { flexDirection: 'row', marginLeft: 2 },
              React.createElement(
                ThemedText,
                { colorTheme: 'muted', dim: true },
                model.nextRecommendedAction.reason,
              ),
            ),
          ),
          React.createElement(Divider, { length: 40 }),
        ]
      : []),

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
      React.createElement(KeyboardShortcutHint, { keys: ['1-9/0', 'p/r'], description: 'Jump' }),
    ),
  )
}

/**
 * Renders a group header with styled separator like "── Group Name ──".
 */
function renderGroupHeader(label: string): React.ReactNode {
  const pad = 1
  const totalWidth = 28
  const textWidth = label.length + 2 // 2 for spaces around label
  const leftPad = Math.max(pad, Math.floor((totalWidth - textWidth) / 2))
  const rightPad = Math.max(pad, totalWidth - leftPad - textWidth)
  const leftLine = '─'.repeat(leftPad)
  const rightLine = '─'.repeat(rightPad)
  const headerText = `${leftLine} ${label} ${rightLine}`
  return React.createElement(
    Box,
    { key: `group-${label}`, marginTop: 1, marginBottom: 0 },
    React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, headerText),
  )
}

/**
 * Renders a single task row with shortcut, label, description, and optional attention badge.
 */
function renderTaskRow(
  item: CombinedItem,
  isSelected: boolean,
  index: number,
  onItemClick: (index: number) => void,
  onItemHover: (index: number) => void,
): React.ReactNode {
  const pointer = isSelected ? '>' : ' '
  const colorTheme = isSelected ? item.colorTheme : 'muted'

  const labelColorTheme = isSelected ? item.colorTheme : 'foreground'

  const labelContent = item.label

  const labelElement = isSelected
    ? React.createElement(ThemedText, { colorTheme: labelColorTheme, bold: true }, labelContent)
    : React.createElement(ThemedText, { colorTheme: 'foreground' }, labelContent)

  const badgeElement = item.attentionBadge
    ? React.createElement(
        Box,
        { marginLeft: 1 },
        React.createElement(ThemedText, { colorTheme: 'warning', bold: true }, `(${item.attentionBadge})`),
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
      key: `task-${item.route}-${item.label}`,
      flexDirection: 'column',
      onClick: () => onItemClick(index),
      onMouseEnter: () => onItemHover(index),
    },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: isSelected ? colorTheme : 'muted' }, pointer),
      React.createElement(Text, null, ' '),
      React.createElement(
        Box,
        { marginRight: 1 },
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `[${item.shortcut}]`),
      ),
      labelElement,
      badgeElement,
    ),
    detailElement,
  )
}

/**
 * Renders a single nav row with shortcut and label.
 */
function renderNavRow(
  item: CombinedItem,
  isSelected: boolean,
  index: number,
  onItemClick: (index: number) => void,
  onItemHover: (index: number) => void,
): React.ReactNode {
  const pointer = isSelected ? '>' : ' '
  const colorTheme = isSelected ? item.colorTheme : 'muted'

  const labelElement = isSelected
    ? React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, item.label)
    : React.createElement(ThemedText, { colorTheme: 'foreground' }, item.label)

  return React.createElement(
    Box,
    {
      key: `nav-${item.route}-${item.label}`,
      flexDirection: 'row',
      onClick: () => onItemClick(index),
      onMouseEnter: () => onItemHover(index),
    },
    React.createElement(ThemedText, { colorTheme: isSelected ? colorTheme : 'muted' }, pointer),
    React.createElement(Text, null, ' '),
    React.createElement(
      Box,
      { marginRight: 1 },
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `[${item.shortcut}]`),
    ),
    labelElement,
  )
}
