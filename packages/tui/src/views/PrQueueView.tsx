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
import type { PrQueueViewModel } from '../view-models/pr-queue.js'

export type PrQueueViewProps = {
  model: PrQueueViewModel
  onBack?: () => void
}

function statusForItem(item: PrQueueViewModel['items'][number]): 'PASS' | 'FAIL' | 'WARN' | 'info' {
  if (item.canMerge) return 'PASS'
  if (item.blockerCategory === 'checks') return 'WARN'
  if (item.blockerCategory !== 'none') return 'FAIL'
  return 'info'
}

function renderWorkflowGate(
  gate: PrQueueViewModel['items'][number]['workflowGate'],
): React.ReactNode {
  if (!gate.touched) return null

  return React.createElement(
    Box,
    { flexDirection: 'column', marginLeft: 3, marginTop: 0 },
    React.createElement(
      ThemedText,
      { colorTheme: 'accent', bold: true },
      'Workflow Gate:',
    ),
    ...gate.criteria.map(criterion =>
      React.createElement(
        Box,
        { flexDirection: 'row', key: criterion.name, marginLeft: 2 },
        React.createElement(StatusIcon, {
          status: criterion.passed ? 'PASS' : 'FAIL',
        }),
        React.createElement(Text, null, ' '),
        React.createElement(
          ThemedText,
          {
            colorTheme: criterion.passed ? 'foreground' : 'error',
          },
          criterion.name,
        ),
      ),
    ),
    gate.criteria.length === 0
      ? React.createElement(
          Box,
          { marginLeft: 2 },
          React.createElement(
            ThemedText,
            { colorTheme: 'warning' },
            '(no criteria defined)',
          ),
        )
      : null,
  )
}

export default function PrQueueView({ model, onBack }: PrQueueViewProps): React.JSX.Element {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) onBack()
      else exit()
    }
  })

  const summaryCategory = model.blockedCount > 0 ? 'fail' : model.pendingCount > 0 ? 'warn' : 'pass'

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, model.title),
    React.createElement(Divider, { length: 50 }),

    // Summary row
    React.createElement(
      Box,
      { flexDirection: 'row', marginY: 0 },
      React.createElement(StatusIcon, { category: summaryCategory }),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'foreground' }, `Total: ${model.totalPRs}`),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'pass' }, `Ready: ${model.readyCount}`),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'error' }, `Blocked: ${model.blockedCount}`),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'warning' }, `Pending: ${model.pendingCount}`),
    ),
    React.createElement(Divider, { length: 40 }),

    // PR items
    model.items.length > 0
      ? React.createElement(
          Pane,
          { title: 'Pull Requests', marginY: 0 },
          ...model.items.map(item =>
            React.createElement(
              Box,
              { key: item.prNumber, flexDirection: 'column', marginY: 0 },
              React.createElement(ListItem, {
                label: `#${item.prNumber} ${item.title}`,
                detail: `Owner: ${item.owner} | Blocker: ${item.blockerCategory} | Next: ${item.nextAction}`,
                status: statusForItem(item),
              }),
              renderWorkflowGate(item.workflowGate),
            ),
          ),
        )
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No open PRs found.'),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'exit' }),
    ),
  )
}
