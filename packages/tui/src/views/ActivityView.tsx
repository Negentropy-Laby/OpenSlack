import React, { useState, useCallback } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import type { ActivityViewModel, ActivityEventViewModel } from '../view-models/activity.js'

export type ActivityViewProps = {
  model: ActivityViewModel
  onBack?: () => void
}

type FilterMode = 'all' | 'blocked' | 'needs-human' | 'agent'

function getEventStatus(event: ActivityEventViewModel): 'FAIL' | 'WARN' | 'PASS' | 'info' {
  if (event.type.includes('blocked') || event.type.includes('failed')) return 'FAIL'
  if (event.nextAction || event.risk === 'high') return 'WARN'
  if (event.type.includes('completed') || event.type.includes('passed')) return 'PASS'
  return 'info'
}

function filterEvents(events: ActivityEventViewModel[], mode: FilterMode): ActivityEventViewModel[] {
  if (mode === 'all') return events
  if (mode === 'blocked') return events.filter(e => e.type.includes('blocked') || e.type.includes('failed'))
  if (mode === 'needs-human') return events.filter(e => e.nextAction !== undefined)
  if (mode === 'agent') return events.filter(e => !e.type.includes('blocked') && !e.type.includes('failed'))
  return events
}

function renderEventPane(title: string, events: ActivityEventViewModel[]): React.ReactNode {
  if (events.length === 0) return null
  return React.createElement(
    Pane,
    { title: `${title} (${events.length})`, marginY: 0 },
    ...events.map((e, i) =>
      React.createElement(
        Box,
        { key: `${e.type}-${i}`, flexDirection: 'row' },
        React.createElement(StatusIcon, { category: getEventStatus(e) === 'FAIL' ? 'fail' : getEventStatus(e) === 'WARN' ? 'warn' : getEventStatus(e) === 'PASS' ? 'pass' : 'info' }),
        React.createElement(Text, null, ' '),
        React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(
            ThemedText,
            { colorTheme: 'foreground' },
            `${e.time} ${e.type}`,
          ),
          e.summary
            ? React.createElement(
                ThemedText,
                { colorTheme: 'muted', dim: true },
                `${e.summary.slice(0, 70)}${e.summary.length > 70 ? '...' : ''}`,
              )
            : null,
          e.actor
            ? React.createElement(
                ThemedText,
                { colorTheme: 'muted', dim: true },
                `by ${e.actor} · ${e.objectKind}:${e.objectId}`,
              )
            : null,
        ),
      ),
    ),
  )
}

export default function ActivityView({ model, onBack }: ActivityViewProps): React.JSX.Element {
  const { exit } = useApp()
  const [filterMode, setFilterMode] = useState<FilterMode>('all')

  const filtered = filterEvents(model.events, filterMode)
  const today = filterEvents(model.today, filterMode)
  const yesterday = filterEvents(model.yesterday, filterMode)
  const older = filterEvents(model.older, filterMode)

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) onBack()
      else exit()
    }
    if (input === 'f') {
      setFilterMode(prev => {
        const modes: FilterMode[] = ['all', 'blocked', 'needs-human', 'agent']
        const idx = modes.indexOf(prev)
        return modes[(idx + 1) % modes.length]
      })
    }
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, model.title),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted', dim: true },
      `Last ${model.periodHours}h · ${model.totalEvents} events · Filter: ${filterMode}`,
    ),
    React.createElement(Divider, { length: 40 }),

    // Events grouped by time bucket
    today.length > 0 ? renderEventPane('Today', today) : null,
    yesterday.length > 0 ? renderEventPane('Yesterday', yesterday) : null,
    older.length > 0 ? renderEventPane('Older', older) : null,

    filtered.length === 0
      ? React.createElement(ThemedText, { colorTheme: 'muted' }, 'No events match the current filter.')
      : null,

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['f'], description: 'filter' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  )
}
