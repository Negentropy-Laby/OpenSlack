import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import Divider from '../design-system/Divider.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import ListItem from '../design-system/ListItem.js'
import Pane from '../design-system/Pane.js'
import StatusIcon from '../design-system/StatusIcon.js'
import ThemedText from '../design-system/ThemedText.js'
import type { RepositoryPrProjectionViewModel } from '../view-models/repository-pr-projection.js'

export interface RepositoryPrProjectionViewProps {
  model: RepositoryPrProjectionViewModel
}

export default function RepositoryPrProjectionView({
  model,
}: RepositoryPrProjectionViewProps): React.JSX.Element {
  const { exit } = useApp()
  useInput((input, key) => {
    if (input === 'q' || key.escape) exit()
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, model.title),
    React.createElement(Divider, { length: 60 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(StatusIcon, { category: model.partial ? 'warn' : 'pass' }),
      React.createElement(Text, null, ' '),
      React.createElement(
        ThemedText,
        { colorTheme: 'foreground' },
        `Repositories: ${model.repositoryCount} | PRs: ${model.itemCount} | API: ${model.budgetLabel}`,
      ),
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'warning' },
      model.authorityLabel,
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted' },
      `Fetched: ${model.fetchedAt}`,
    ),
    React.createElement(Divider, { length: 60 }),
    model.items.length > 0
      ? React.createElement(
          Pane,
          { title: 'Projection-only pull requests', marginY: 0 },
          ...model.items.map((item) =>
            React.createElement(ListItem, {
              key: item.key,
              label: `${item.repository}#${item.prNumber} ${item.title}`,
              detail: `@${item.author} | ${item.state}${item.draft ? ' draft' : ''} | ${item.headSha} | ${item.checksLabel} | ${item.freshnessLabel}`,
              status: item.warning ? 'WARN' : 'info',
            }),
          ),
        )
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No open pull requests found.'),
    React.createElement(Divider, { length: 60 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'exit' }),
    ),
  )
}
