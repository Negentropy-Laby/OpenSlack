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
import type { SetupViewModel, SetupReadiness } from '../view-models/setup.js'

export type SetupViewProps = {
  model: SetupViewModel
}

function readinessCategory(r: SetupReadiness): 'pass' | 'warn' | 'fail' {
  if (r === 'ready') return 'pass'
  if (r === 'almost ready') return 'warn'
  return 'fail'
}

export default function SetupView({ model }: SetupViewProps): React.JSX.Element {
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
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack Setup Report'),
    React.createElement(Divider, { length: 40 }),

    // Readiness
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(StatusIcon, { category: readinessCategory(model.readiness) }),
      React.createElement(Text, null, ' '),
      React.createElement(ThemedText, { colorTheme: 'foreground', bold: true }, `Readiness: ${model.readiness}`),
    ),
    React.createElement(ThemedText, { colorTheme: 'muted' }, `${model.passedChecks}/${model.totalChecks} checks passed`),
    React.createElement(Divider, { length: 40 }),

    // Fixable items
    model.fixable.length > 0
      ? React.createElement(
          Pane,
          { title: `Fixable (${model.fixable.length})`, marginY: 0 },
          ...model.fixable.map(f =>
            React.createElement(ListItem, {
              key: f.id,
              label: f.title,
              detail: f.command || f.nextAction || f.detail,
              status: 'WARN',
            }),
          ),
        )
      : null,

    // Needs action
    model.needsAction.length > 0
      ? React.createElement(
          Pane,
          { title: `Needs Action (${model.needsAction.length})`, marginY: 0 },
          ...model.needsAction.map(f =>
            React.createElement(ListItem, {
              key: f.id,
              label: f.title,
              detail: f.nextAction || f.detail,
              status: 'FAIL',
            }),
          ),
        )
      : null,

    // OK items
    model.ok.length > 0
      ? React.createElement(
          Pane,
          { title: `Passed (${model.ok.length})`, marginY: 0 },
          ...model.ok.map(f =>
            React.createElement(ListItem, {
              key: f.id,
              label: f.title,
              detail: f.detail,
              status: f.status,
            }),
          ),
        )
      : null,

    // All clear
    model.fixable.length === 0 && model.needsAction.length === 0
      ? React.createElement(ThemedText, { colorTheme: 'pass' }, '✓ OpenSlack is fully set up.')
      : null,

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'exit' }),
    ),
  )
}
