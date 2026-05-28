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
import type { StatusViewModel } from '../view-models/status.js'

export type StatusViewProps = {
  model: StatusViewModel
}

function attentionStatus(priority: StatusViewModel['attentionItems'][number]['priority']): 'FAIL' | 'WARN' | 'info' {
  if (priority === 'high') return 'FAIL'
  if (priority === 'medium') return 'WARN'
  return 'info'
}

export default function StatusView({ model }: StatusViewProps): React.JSX.Element {
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
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, model.title),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `Version: ${model.version}`),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `Commit: ${model.commit}`),
    ),
    React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, model.commitSubject),
    React.createElement(Divider, { length: 50 }),

    // Modules
    React.createElement(
      Pane,
      { title: `Modules (${model.modules.length})`, marginY: 0 },
      ...model.modules.map(m =>
        React.createElement(ListItem, {
          key: m.name,
          label: `${m.name}${m.tests !== null ? ` (${m.tests} tests)` : ''}`,
          detail: m.status,
          status: m.status === 'ACTIVE' ? 'PASS' : 'info',
        }),
      ),
    ),

    // GitHub section
    model.gitHub.available
      ? React.createElement(
          Pane,
          { title: 'GitHub', marginY: 0 },
          React.createElement(ListItem, {
            label: `Tasks ready: ${model.gitHub.tasksReady}`,
            status: model.gitHub.tasksReady > 0 ? 'info' : 'PASS',
          }),
          React.createElement(ListItem, {
            label: `Tasks claimed: ${model.gitHub.tasksClaimed}`,
            status: model.gitHub.tasksClaimed > 0 ? 'info' : 'PASS',
          }),
          React.createElement(ListItem, {
            label: `Tasks blocked: ${model.gitHub.tasksBlocked}`,
            status: model.gitHub.tasksBlocked > 0 ? 'FAIL' : 'PASS',
          }),
          React.createElement(ListItem, {
            label: `PRs open: ${model.gitHub.prsOpen}`,
            status: 'info',
          }),
          React.createElement(ListItem, {
            label: `PRs blocked: ${model.gitHub.prsBlocked}`,
            status: model.gitHub.prsBlocked > 0 ? 'FAIL' : 'PASS',
          }),
          React.createElement(ListItem, {
            label: `PRs ready: ${model.gitHub.prsReady}`,
            status: model.gitHub.prsReady > 0 ? 'PASS' : 'info',
          }),
        )
      : React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, 'GitHub: unavailable'),

    // Test Suite
    React.createElement(
      Box,
      { flexDirection: 'row', marginY: 0 },
      React.createElement(StatusIcon, { category: 'pass' }),
      React.createElement(Text, null, ' '),
      React.createElement(
        ThemedText,
        { colorTheme: 'foreground' },
        `Test Suite: ${model.testSuite.totalTests} tests across ${model.testSuite.totalFiles} files`,
      ),
    ),
    React.createElement(Divider, { length: 40 }),

    // Recommendations
    model.recommendations.length > 0
      ? React.createElement(
          Pane,
          { title: 'Recommended Next Steps', marginY: 0 },
          ...model.recommendations.map((r, i) =>
            React.createElement(ListItem, {
              key: `rec-${i}`,
              label: `${i + 1}. ${r.title}`,
              detail: r.command ? `Run: ${r.command}` : r.action,
              status: 'info',
            }),
          ),
        )
      : null,

    // Attention Items
    model.attentionItems.length > 0
      ? React.createElement(
          Pane,
          { title: 'Needs Attention', marginY: 0 },
          ...model.attentionItems.map((a, i) =>
            React.createElement(ListItem, {
              key: `attn-${i}`,
              label: `[${a.priority.toUpperCase()}] ${a.type}: ${a.description}`,
              detail: a.action,
              status: attentionStatus(a.priority),
            }),
          ),
        )
      : React.createElement(ThemedText, { colorTheme: 'pass' }, 'All clear'),

    // Next action
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row', marginY: 0 },
      React.createElement(ThemedText, { colorTheme: 'warning' }, 'Next: '),
      React.createElement(ThemedText, { colorTheme: 'foreground' }, model.nextAction),
    ),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'exit' }),
    ),
  )
}
