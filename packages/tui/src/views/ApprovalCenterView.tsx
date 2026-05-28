import React, { useState } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import { useNavigation } from '../navigation/context.js'
import { getCategoryLabel } from '../view-models/approval-center.js'
import type { ApprovalCenterViewModel, ApprovalItem } from '../view-models/approval-center.js'

export type ApprovalCenterViewProps = {
  model: ApprovalCenterViewModel
}

type ViewMode = 'list' | 'detail'

export default function ApprovalCenterView({ model }: ApprovalCenterViewProps): React.JSX.Element {
  const { pop } = useNavigation()
  const { exit } = useApp()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<ViewMode>('list')

  const items = model.pendingApprovals

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (mode === 'detail') {
        setMode('list')
      } else {
        pop()
      }
      return
    }

    if (mode === 'list') {
      if (key.upArrow) {
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : items.length - 1))
      } else if (key.downArrow) {
        setSelectedIndex(prev => (prev < items.length - 1 ? prev + 1 : 0))
      } else if (key.return && items.length > 0) {
        setMode('detail')
      }
    }
  })

  const selected: ApprovalItem | undefined = items[selectedIndex]

  // Summary bar
  const summaryParts: string[] = []
  if (model.summary.plans > 0) summaryParts.push(`Plans: ${model.summary.plans}`)
  if (model.summary.mergeRequests > 0) summaryParts.push(`Merge: ${model.summary.mergeRequests}`)
  if (model.summary.workflowEffects > 0) summaryParts.push(`Effects: ${model.summary.workflowEffects}`)
  if (model.summary.githubReviews > 0) summaryParts.push(`Reviews: ${model.summary.githubReviews}`)

  const summaryText = summaryParts.length > 0 ? summaryParts.join(' | ') : 'No pending approvals'

  if (mode === 'detail' && selected) {
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack / Approvals'),
      ),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Pane,
        { title: getCategoryLabel(selected.category), marginY: 0 },
        React.createElement(Box, { flexDirection: 'column' },
          React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Title: '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, selected.title),
          ),
          React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Risk: '),
            React.createElement(StatusIcon, { status: selected.risk === 'low' ? 'pass' : selected.risk === 'high' ? 'fail' : 'warn' }),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, ` ${selected.risk}`),
          ),
          React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Requested by: '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, selected.requestedBy),
          ),
          selected.detail
            ? React.createElement(
                Box,
                { flexDirection: 'column', marginTop: 1 },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Detail:'),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, selected.detail),
              )
            : null,
        ),
      ),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back to list' }),
      ),
    )
  }

  // List mode
  const listRows = items.map((item, i) => {
    const isSelected = i === selectedIndex
    const pointer = isSelected ? '>' : ' '
    const categoryIcon = item.category === 'plan' ? 'pass'
      : item.category === 'merge-request' ? 'warn'
      : item.category === 'workflow-effect' ? 'info'
      : 'blocked'

    return React.createElement(
      Box,
      { key: item.id, flexDirection: 'column' },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: isSelected ? 'accent' : 'muted' }, pointer),
        React.createElement(Text, null, ' '),
        React.createElement(StatusIcon, { status: categoryIcon }),
        React.createElement(Text, null, ' '),
        isSelected
          ? React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, item.title)
          : React.createElement(ThemedText, { colorTheme: 'foreground' }, item.title),
      ),
      React.createElement(
        Box,
        { marginLeft: 3 },
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `${getCategoryLabel(item.category)} — ${item.requestedBy}`),
      ),
    )
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack / Approvals'),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, summaryText),
    ),
    React.createElement(Divider, { length: 40 }),
    items.length > 0
      ? React.createElement(Pane, { title: 'Pending Approvals', marginY: 0 },
          React.createElement(Box, { flexDirection: 'column' }, ...listRows),
        )
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No pending approvals.'),
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Up/Down'], description: 'navigate' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'inspect' }),
    ),
  )
}
