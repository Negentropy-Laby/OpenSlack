import React from 'react'
import Box from '../ink/components/Box.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import ListItem from '../design-system/ListItem.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import type { ProfileViewModel } from '../view-models/profile.js'

export type ProfileViewProps = {
  model: ProfileViewModel
  onBack?: () => void
  onAction?: (actionId: string) => void
}

function syncStatusIcon(status: ProfileViewModel['syncStatus']): import('../design-system/StatusIcon.js').StatusCategory {
  if (status === 'synced') return 'pass'
  if (status === 'pending') return 'warn'
  if (status === 'failed') return 'fail'
  return 'info'
}

function markerStatusIcon(status: ProfileViewModel['markerStatus']): import('../design-system/StatusIcon.js').StatusCategory {
  if (status === 'present') return 'pass'
  if (status === 'missing') return 'fail'
  return 'info'
}

export default function ProfileView({ model, onBack, onAction }: ProfileViewProps): React.JSX.Element {
  const { exit } = useApp()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) onBack()
      else exit()
      return
    }

    const action = model.actions.find((a) => a.key === input)
    if (action && onAction) {
      onAction(action.id)
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
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `Target: ${model.targetRepo}/${model.targetPath}`),
    ),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `Marker: <!-- openslack:${model.marker}:start/end -->`),
    ),
    React.createElement(Divider, { length: 50 }),

    // Sync status
    React.createElement(
      Pane,
      { title: 'Sync Status', marginY: 0 },
      React.createElement(ListItem, {
        label: `Status: ${model.syncStatus}`,
        status: syncStatusIcon(model.syncStatus),
        detail: model.lastSyncDate ? `Last sync: ${model.lastSyncDate}` : undefined,
      }),
      React.createElement(ListItem, {
        label: `Marker: ${model.markerStatus}`,
        status: markerStatusIcon(model.markerStatus),
      }),
      model.lastPrUrl
        ? React.createElement(ListItem, {
            label: 'Last PR',
            detail: model.lastPrUrl,
            status: 'warn',
          })
        : null,
      model.pendingPR
        ? React.createElement(ListItem, {
            label: 'Pending PR',
            detail: `#${model.pendingPR.number} ${model.pendingPR.branch}`,
            status: 'warn',
          })
        : null,
    ),

    // Validation summary
    React.createElement(
      Pane,
      { title: 'Validation', marginY: 0 },
      React.createElement(ListItem, {
        label: `Total posts: ${model.validationSummary.total}`,
        status: 'info',
      }),
      React.createElement(ListItem, {
        label: `Published: ${model.validationSummary.published}`,
        status: model.validationSummary.published > 0 ? 'pass' : 'info',
      }),
      React.createElement(ListItem, {
        label: `Failed: ${model.validationSummary.failed}`,
        status: model.validationSummary.failed > 0 ? 'fail' : 'pass',
      }),
    ),

    // Posts
    model.posts.length > 0
      ? React.createElement(
          Pane,
          { title: `Latest Posts (${model.posts.length})`, marginY: 0 },
          ...model.posts.map((p, i) =>
            React.createElement(ListItem, {
              key: `post-${i}`,
              label: `${p.date} — ${p.title}`,
              detail: p.summary.slice(0, 60) + (p.summary.length > 60 ? '...' : ''),
              status: 'info',
            }),
          ),
        )
      : React.createElement(
          Box,
          { marginY: 1 },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'No posts synced yet.'),
        ),

    // Action result
    model.actionResult
      ? React.createElement(
          Pane,
          { title: 'Action Result', marginY: 0 },
          React.createElement(ListItem, {
            label: model.actionResult.actionId,
            detail: model.actionResult.message,
            status: model.actionResult.success ? 'pass' : 'fail',
          }),
        )
      : null,

    // Actions
    React.createElement(
      Pane,
      { title: 'Actions', marginY: 0 },
      ...model.actions.map((a) =>
        React.createElement(ListItem, {
          key: `action-${a.id}`,
          label: `${a.key} — ${a.label}`,
          detail: a.description,
          status: a.risk === 'high' ? 'fail' : a.risk === 'medium' ? 'warn' : 'info',
        }),
      ),
    ),

    // Footer
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row', flexWrap: 'wrap' },
      ...model.actions.map((a) =>
        React.createElement(KeyboardShortcutHint, { key: `hint-${a.id}`, keys: [a.key], description: a.label }),
      ),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  )
}
