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
import type { WorkflowGalleryViewModel, WorkflowDetailViewModel } from '../view-models/workflow-gallery.js'

type ViewMode = 'gallery' | 'detail'

type WorkflowWorkbenchProps = {
  galleryModel: WorkflowGalleryViewModel
}

export default function WorkflowWorkbenchView({ galleryModel }: WorkflowWorkbenchProps): React.JSX.Element {
  const { pop, push } = useNavigation()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<ViewMode>('gallery')

  const items = galleryModel.workflows

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (mode === 'detail') {
        setMode('gallery')
      } else {
        pop()
      }
      return
    }

    if (mode === 'gallery') {
      if (key.upArrow) {
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : items.length - 1))
      } else if (key.downArrow) {
        setSelectedIndex(prev => (prev < items.length - 1 ? prev + 1 : 0))
      } else if (key.return && items.length > 0) {
        setMode('detail')
      }
    }
  })

  const summaryText = `${galleryModel.summary.total} workflows (${galleryModel.summary.yaml} YAML, ${galleryModel.summary.js} JS)`

  if (mode === 'detail' && items[selectedIndex]) {
    const wf = items[selectedIndex]
    const trustIcon = wf.trustLevel === 'core' ? 'pass' : wf.trustLevel === 'trusted' ? 'warn' : 'blocked'
    const riskIcon = wf.risk === 'low' ? 'pass' : wf.risk === 'high' ? 'fail' : 'warn'

    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `OpenSlack / Workflows / ${wf.name}`),
      ),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Pane,
        { title: 'Workflow Detail', marginY: 0 },
        React.createElement(Box, { flexDirection: 'column' },
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Description: '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, wf.description || '(none)'),
          ),
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Format: '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, wf.format.toUpperCase()),
          ),
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Trust: '),
            React.createElement(StatusIcon, { status: trustIcon }),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, ` ${wf.trustLevel}`),
          ),
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Risk: '),
            React.createElement(StatusIcon, { status: riskIcon }),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, ` ${wf.risk}`),
          ),
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Phases: '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, String(wf.phases)),
          ),
          wf.lastRunStatus
            ? React.createElement(Box, { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Last run: '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, wf.lastRunStatus),
              )
            : null,
        ),
      ),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back to gallery' }),
      ),
    )
  }

  // Gallery mode
  const galleryRows = items.map((wf, i) => {
    const isSelected = i === selectedIndex
    const pointer = isSelected ? '>' : ' '
    const trustIcon = wf.trustLevel === 'core' ? 'pass' : wf.trustLevel === 'trusted' ? 'warn' : 'blocked'

    return React.createElement(
      Box,
      { key: wf.name, flexDirection: 'column' },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: isSelected ? 'accent' : 'muted' }, pointer),
        React.createElement(Text, null, ' '),
        React.createElement(StatusIcon, { status: trustIcon }),
        React.createElement(Text, null, ' '),
        isSelected
          ? React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, wf.name)
          : React.createElement(ThemedText, { colorTheme: 'foreground' }, wf.name),
        React.createElement(Text, null, ' '),
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, wf.format.toUpperCase()),
      ),
      React.createElement(
        Box,
        { marginLeft: 3 },
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, wf.description),
      ),
    )
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack / Workflows'),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, summaryText),
    ),
    React.createElement(Divider, { length: 40 }),
    items.length > 0
      ? React.createElement(Pane, { title: 'Workflow Gallery', marginY: 0 },
          React.createElement(Box, { flexDirection: 'column' }, ...galleryRows),
        )
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No workflows discovered.'),
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
