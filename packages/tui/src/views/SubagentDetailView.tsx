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
import type { AgentDetailItem } from '../view-models/agent-detail.js'

export type SubagentDetailViewProps = {
  model: AgentDetailItem
  onBack?: () => void
}

export default function SubagentDetailView({
  model,
  onBack,
}: SubagentDetailViewProps): React.JSX.Element {
  const { exit } = useApp()

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
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `Agent: ${model.name}`),
    React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `Source: ${model.source}`),
    React.createElement(Divider, { length: 40 }),

    // Description
    React.createElement(ThemedText, { colorTheme: 'foreground' }, model.description),
    React.createElement(Divider, { length: 40 }),

    // Identity section
    React.createElement(Pane, { title: 'Identity', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Name: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.name),
        ),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Source: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.source),
        ),
        ...(model.model
          ? [
              React.createElement(
                Box,
                { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Model: '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, model.model),
              ),
            ]
          : []),
      ),
    ),

    // Capabilities section
    React.createElement(Pane, { title: 'Capabilities', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        // Tools
        React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Tools:'),
          ...(model.tools.length > 0
            ? model.tools.map(tool =>
                React.createElement(
                  Box,
                  { key: tool, marginLeft: 2, flexDirection: 'row' },
                  React.createElement(StatusIcon, { category: 'pass' }),
                  React.createElement(Text, null, ' '),
                  React.createElement(ThemedText, { colorTheme: 'foreground' }, tool),
                ),
              )
            : [React.createElement(ThemedText, { key: 'none', colorTheme: 'muted', dim: true }, '  (none)')]),
        ),
        // Denied tools
        ...(model.deniedTools.length > 0
          ? [
              React.createElement(
                Box,
                { flexDirection: 'column', marginTop: 0 },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Denied Tools:'),
                ...model.deniedTools.map(tool =>
                  React.createElement(
                    Box,
                    { key: `denied-${tool}`, marginLeft: 2, flexDirection: 'row' },
                    React.createElement(StatusIcon, { category: 'fail' }),
                    React.createElement(Text, null, ' '),
                    React.createElement(ThemedText, { colorTheme: 'foreground' }, tool),
                  ),
                ),
              ),
            ]
          : []),
        // Max turns
        ...(model.maxTurns != null
          ? [
              React.createElement(
                Box,
                { flexDirection: 'row', marginTop: 0 },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Max Turns: '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, String(model.maxTurns)),
              ),
            ]
          : []),
      ),
    ),

    // Policy section
    React.createElement(Pane, { title: 'Policy', marginY: 0 },
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Memory: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.memory),
        ),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Isolation: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.isolation),
        ),
        React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Can Spawn: '),
          React.createElement(
            StatusIcon,
            { category: model.canSpawn ? 'pass' : 'info' },
          ),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.canSpawn ? 'Yes' : 'No'),
        ),
      ),
    ),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  )
}
