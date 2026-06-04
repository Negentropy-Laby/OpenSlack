import React, { useCallback, useContext, useState } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import { useNavigation } from '../navigation/context.js'
import { useClampedIndex } from '../hooks/use-clamped-index.js'
import type { HomeViewModel, TaskItem, RecommendedAction } from '../view-models/home.js'
import AskBar from '../components/AskBar.js'
import ActionCard from '../components/ActionCard.js'
import type { AskBarSubmit } from '../components/AskBar.js'
import type { ConversationActionCard, TuiActionHandlers, TuiAskResult } from './render-shell.js'

export type HomeViewProps = {
  model: HomeViewModel
  actionHandlers?: TuiActionHandlers
  onAskSubmit?: (input: AskBarSubmit, threadId?: string) => Promise<TuiAskResult | void> | TuiAskResult | void
  askState?: { value?: string; busy?: boolean; message?: string }
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
  'watch-workflows': 'start-work',
  'save-share-workflow': 'start-work',
  'publish-workflow': 'start-work',
  'see-attention': 'review-work',
  'review-prs': 'review-work',
  'view-conversations': 'review-work',
  'approve-workflows': 'govern',
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

type FocusRegion = 'ask' | 'cards' | 'menu'

const COMPACT_HOME_ROWS = 28

export type AskHistoryDirection = 'older' | 'newer'

export interface AskHistorySelection {
  cursor: number | undefined
  value: string
}

const URGENCY_COLOR: Record<RecommendedAction['urgency'], 'warning' | 'info' | 'muted'> = {
  governance: 'warning',
  blocker: 'warning',
  operational: 'info',
  informational: 'muted',
}

export function resolveAskHistorySelection(
  askHistory: string[],
  historyCursor: number | undefined,
  direction: AskHistoryDirection,
): AskHistorySelection | undefined {
  if (askHistory.length === 0) return undefined
  if (direction === 'older') {
    const cursor = historyCursor === undefined
      ? 0
      : Math.min(historyCursor + 1, askHistory.length - 1)
    return { cursor, value: askHistory[cursor] ?? '' }
  }

  if (historyCursor === undefined) return undefined
  if (historyCursor === 0) {
    return { cursor: undefined, value: '' }
  }
  const cursor = historyCursor - 1
  return { cursor, value: askHistory[cursor] ?? '' }
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

export default function HomeView({ model, actionHandlers, onAskSubmit, askState }: HomeViewProps): React.JSX.Element {
  const { exit } = useApp()
  const { push } = useNavigation()
  const terminalSize = useContext(TerminalSizeContext)
  const compactHome = (terminalSize?.rows ?? 40) <= COMPACT_HOME_ROWS

  const combined = buildCombinedItems(model)
  const taskCount = model.tasks.length
  const totalCount = combined.length

  const [selectedIndex, setSelectedIndex] = useClampedIndex(totalCount)
  const [focusRegion, setFocusRegion] = useState<FocusRegion>('ask')
  const [askValue, setAskValue] = useState(askState?.value ?? '')
  const [askBusy, setAskBusy] = useState(Boolean(askState?.busy))
  const [askMessage, setAskMessage] = useState<string | undefined>(askState?.message)
  const [askResult, setAskResult] = useState<TuiAskResult | undefined>()
  const [askHistory, setAskHistory] = useState<string[]>([])
  const [historyCursor, setHistoryCursor] = useState<number | undefined>()
  const cards = askResult?.cards ?? []
  const [selectedCardIndex, setSelectedCardIndex] = useClampedIndex(cards.length)

  const askFocused = focusRegion === 'ask'

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

  const submitAsk = useCallback(async () => {
    const text = askValue.trim()
    if (!text || askBusy) return
    setAskBusy(true)
    setAskMessage('Planning request...')
    try {
      const submit = onAskSubmit
        ? (value: string, threadId?: string) => onAskSubmit({ text: value }, threadId)
        : actionHandlers?.submitWorkbenchAsk
      if (!submit) {
        const fallback: TuiAskResult = {
          threadId: askResult?.threadId ?? '',
          status: 'recorded',
          message: `Use: openslack ask "${text.replace(/"/g, '\\"')}"`,
          cards: [{
            id: 'fallback-ask',
            label: 'Use OpenSlack Ask',
            detail: 'This TUI session does not provide an ask handler.',
            kind: 'command',
            command: `openslack ask "${text.replace(/"/g, '\\"')}"`,
            riskLevel: 'none',
            confirmationRequired: false,
          }],
        }
        setAskResult(fallback)
        setAskMessage(fallback.message)
        setFocusRegion('cards')
        return
      }
      const result = await submit(text, askResult?.threadId)
      if (result) {
        setAskResult(result)
        setAskMessage(result.message.split('\n')[0])
        if (result.cards.length > 0) setFocusRegion('cards')
      }
      setAskHistory(prev => [text, ...prev.filter(item => item !== text)].slice(0, 20))
      setHistoryCursor(undefined)
      setAskValue('')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAskMessage(`Ask failed: ${message}`)
      setAskResult({
        threadId: askResult?.threadId ?? '',
        status: 'error',
        message,
        cards: [],
      })
    } finally {
      setAskBusy(false)
    }
  }, [actionHandlers, askBusy, askResult?.threadId, askValue, onAskSubmit])

  const executeCard = useCallback(async (card: ConversationActionCard) => {
    const threadId = askResult?.threadId
    const record = async (message: string) => {
      if (threadId && actionHandlers?.recordWorkbenchAction) {
        await actionHandlers.recordWorkbenchAction(threadId, card, message)
      }
    }

    if ((card.kind === 'route' || card.kind === 'approval') && card.route) {
      const message = card.confirmationRequired
        ? `Opening ${card.label}; confirmation is still required.`
        : `Opening ${card.label}.`
      setAskMessage(message)
      await record(message)
      push({ view: card.route, params: card.routeParams })
      return
    }

    if (card.kind === 'workflow_draft') {
      if (card.prompt && actionHandlers?.startWorkflowFromPrompt) {
        try {
          setAskBusy(true)
          const result = await actionHandlers.startWorkflowFromPrompt(card.prompt)
          setAskMessage(result.message)
          await record(result.message)
        } catch (err) {
          const message = `Workflow draft failed: ${err instanceof Error ? err.message : String(err)}`
          setAskMessage(message)
          await record(message)
        } finally {
          setAskBusy(false)
        }
        return
      }
      const message = card.command ? `Use: ${card.command}` : 'Workflow draft handler is not available.'
      setAskMessage(message)
      await record(message)
      return
    }

    if (card.kind === 'agent_run' && card.route) {
      const message = `Opening ${card.label}.`
      setAskMessage(message)
      await record(message)
      push({ view: card.route, params: card.routeParams })
      return
    }

    const message = card.command ? `Use: ${card.command}` : `${card.label} is not executable in this TUI session.`
    setAskMessage(message)
    await record(message)
  }, [actionHandlers, askResult?.threadId, push])

  const selectHistory = useCallback((direction: AskHistoryDirection) => {
    const selection = resolveAskHistorySelection(askHistory, historyCursor, direction)
    if (!selection) return
    setHistoryCursor(selection.cursor)
    setAskValue(selection.value)
  }, [askHistory, historyCursor])

  useInput((input, key) => {
    if (focusRegion === 'ask') {
      if (key.ctrl && input === 'p') {
        selectHistory('older')
        return
      }
      if (key.ctrl && input === 'n') {
        selectHistory('newer')
        return
      }
      if (key.return) {
        void submitAsk()
        return
      }
      if (key.backspace || key.delete) {
        setAskValue(prev => prev.slice(0, -1))
        return
      }
      if (key.downArrow) {
        setFocusRegion(cards.length > 0 ? 'cards' : 'menu')
        return
      }
      if (key.escape) {
        if (askValue.length > 0) {
          setAskValue('')
          return
        }
        exit()
        return
      }
      if (input === 'q' && askValue.length === 0) {
        exit()
        return
      }
      if (input && input.length > 0 && !key.ctrl && !key.meta) {
        setAskValue(prev => `${prev}${input}`.slice(0, 400))
      }
      return
    }

    if (focusRegion === 'cards') {
      if (input === 'q' || key.escape) {
        setFocusRegion('ask')
        return
      }
      if (key.upArrow) {
        setSelectedCardIndex(prev => (prev > 0 ? prev - 1 : Math.max(cards.length - 1, 0)))
        return
      }
      if (key.downArrow) {
        setSelectedCardIndex(prev => (prev < cards.length - 1 ? prev + 1 : 0))
        return
      }
      const numeric = Number.parseInt(input, 10)
      if (Number.isFinite(numeric) && numeric >= 1 && numeric <= cards.length) {
        void executeCard(cards[numeric - 1])
        return
      }
      if (key.return && cards[selectedCardIndex]) {
        void executeCard(cards[selectedCardIndex])
        return
      }
      if (input === 'm') {
        setFocusRegion('menu')
        return
      }
      return
    }

    if (input === '/') {
      setFocusRegion('ask')
      return
    }

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
        taskElements.push(renderGroupHeader(groupDef.label, compactHome))
      }
      lastGroup = group
    }
    const isSelected = focusRegion === 'menu' && selectedIndex === i
    taskElements.push(renderTaskRow(item, isSelected, i, handleItemClick, handleItemHover, compactHome))
  }

  // Render nav section items
  const navElements: React.ReactNode[] = []
  for (let i = taskCount; i < totalCount; i++) {
    const item = combined[i]
    const isSelected = focusRegion === 'menu' && selectedIndex === i
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

    // Section 1: Ask OpenSlack
    React.createElement(AskBar, {
      value: askValue,
      focused: askFocused,
      busy: askBusy,
      threadId: askResult?.threadId,
      message: askMessage,
    }),

    cards.length > 0
      ? React.createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack suggests:'),
          ...cards.map((card, index) =>
            React.createElement(
              Box,
              {
                key: card.id,
                flexDirection: 'column',
                onClick: () => { void executeCard(card) },
                onMouseEnter: () => {
                  setFocusRegion('cards')
                  setSelectedCardIndex(index)
                },
              },
              React.createElement(ActionCard, {
                card,
                index,
                selected: focusRegion === 'cards' && selectedCardIndex === index,
              }),
            ),
          ),
        )
      : null,

    React.createElement(Divider, { length: 40 }),

    // Section 2: Suggested shortcuts
    React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 0, marginBottom: 0 },
      React.createElement(
        ThemedText,
        { colorTheme: 'accent', bold: true },
        'Suggested shortcuts',
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
      ? compactHome
        ? [
            React.createElement(
              Box,
              { key: 'compact-next-action', flexDirection: 'row' },
              React.createElement(
                ThemedText,
                { colorTheme: URGENCY_COLOR[model.nextRecommendedAction.urgency], bold: true },
                '>',
              ),
              React.createElement(Text, null, ' '),
              React.createElement(
                ThemedText,
                { colorTheme: URGENCY_COLOR[model.nextRecommendedAction.urgency], wrap: 'truncate-end' },
                `Next: ${model.nextRecommendedAction.label}`,
              ),
            ),
          ]
        : [
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

    ...(compactHome
      ? model.nextRecommendedAction
        ? []
        : [
            React.createElement(
              ThemedText,
              { key: 'compact-home-help', colorTheme: 'muted', dim: true },
              'Use / for Ask, numbers for shortcuts, q/Esc to quit.',
            ),
          ]
      : [
          // Section 2: Quick Navigation
          React.createElement(
            Box,
            { key: 'quick-navigation', flexDirection: 'column', marginTop: 0, marginBottom: 0 },
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
          React.createElement(Divider, { key: 'footer-divider', length: 40 }),
          React.createElement(
            Box,
            { key: 'footer-help', flexDirection: 'row' },
            React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Quit' }),
            React.createElement(Text, null, '  '),
            React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'Ask/select' }),
            React.createElement(Text, null, '  '),
            React.createElement(KeyboardShortcutHint, { keys: ['Down'], description: 'suggestions/menu' }),
            React.createElement(Text, null, '  '),
            React.createElement(KeyboardShortcutHint, { keys: ['/'], description: 'focus ask' }),
            React.createElement(Text, null, '  '),
            React.createElement(KeyboardShortcutHint, { keys: ['Ctrl+P/N'], description: 'history' }),
          ),
        ]),
  )
}

/**
 * Renders a group header with styled separator like "── Group Name ──".
 */
function renderGroupHeader(label: string, compact = false): React.ReactNode {
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
    { key: `group-${label}`, marginTop: compact ? 0 : 1, marginBottom: 0 },
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
  compact = false,
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

  const detailElement = item.detail && (!compact || isSelected)
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
