import React from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import Pane from '../design-system/Pane.js'
import ListItem from '../design-system/ListItem.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import { NavigationProvider, useNavigation, HOME_ROUTE } from '../navigation/context.js'
import type { Route } from '../navigation/router.js'
import { mapHomeToViewModel } from '../view-models/home.js'
import { mapApprovalCenterToViewModel } from '../view-models/approval-center.js'
import { mapWorkflowGalleryToViewModel } from '../view-models/workflow-gallery.js'
import { mapIssuesPrToViewModel } from '../view-models/issues-pr.js'
import type { ShellViewData, TuiActionHandlers } from './render-shell.js'

import HomeView from './HomeView.js'
import ApprovalCenterView from './ApprovalCenterView.js'
import WorkflowWorkbenchView from './WorkflowWorkbenchView.js'
import IssuesPrView from './IssuesPrView.js'
import DashboardView from './DashboardView.js'
import PrQueueView from './PrQueueView.js'
import StatusView from './StatusView.js'

/**
 * A view that hasn't been wired to live data yet.
 * Shows the view name and a "press q to go back" prompt.
 */
function PlaceholderView({ route }: { route: Route }): React.JSX.Element {
  const { pop } = useNavigation()

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      pop()
    }
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `OpenSlack / ${route.view}`),
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted' },
      `View "${route.view}" is not yet connected to live data.`,
    ),
    React.createElement(
      ThemedText,
      { colorTheme: 'muted', dim: true },
      'Press [q] to go back',
    ),
  )
}

/**
 * Activity view — shows recent events from the dashboard data.
 */
function ActivityView({ data }: { data?: ShellViewData }): React.JSX.Element {
  const { pop } = useNavigation()
  const activity = data?.dashboard?.recentActivity ?? []

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      pop()
    }
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack / Activity'),
    React.createElement(Divider, { length: 40 }),
    activity.length > 0
      ? React.createElement(
          Pane,
          { title: 'Recent Activity', marginY: 0 },
          ...activity.slice(0, 20).map((a, i) =>
            React.createElement(ListItem, {
              key: `${a.type}-${i}`,
              label: a.summary,
              detail: `${a.time} · ${a.actor}`,
              status: 'info',
            }),
          ),
        )
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No recent activity.'),
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
  )
}

/**
 * Maps a route to a rendered view component.
 */
function ViewRouter({ data }: { data?: ShellViewData }): React.JSX.Element {
  const { current, pop } = useNavigation()

  switch (current.view) {
    case 'home': {
      const model = mapHomeToViewModel({ shellData: data })
      return React.createElement(HomeView, { model })
    }
    case 'dashboard': {
      if (data?.dashboard) {
        return React.createElement(DashboardView, { model: data.dashboard, onBack: pop })
      }
      return React.createElement(PlaceholderView, { route: current })
    }
    case 'pr-queue': {
      if (data?.prQueue) {
        return React.createElement(PrQueueView, { model: data.prQueue, onBack: pop })
      }
      // Fall back to IssuesPrView with PR tab
      const issuesPrModel = mapIssuesPrToViewModel({ tab: 'prs' })
      return React.createElement(IssuesPrView, { model: issuesPrModel })
    }
    case 'approvals': {
      const model = data?.approvals ?? mapApprovalCenterToViewModel()
      return React.createElement(ApprovalCenterView, { model, actionHandlers: data?.actionHandlers })
    }
    case 'workflow-preview':
    case 'workflows': {
      const galleryModel = data?.workflowGallery ?? mapWorkflowGalleryToViewModel()
      return React.createElement(WorkflowWorkbenchView, { galleryModel, actionHandlers: data?.actionHandlers })
    }
    case 'status': {
      if (data?.status) {
        return React.createElement(StatusView, { model: data.status, onBack: pop })
      }
      return React.createElement(PlaceholderView, { route: current })
    }
    case 'activity': {
      return React.createElement(ActivityView, { data })
    }
    case 'prs':
    case 'issues': {
      const issuesPrModel = mapIssuesPrToViewModel({ tab: current.view as 'issues' | 'prs' })
      return React.createElement(IssuesPrView, { model: issuesPrModel })
    }
    default:
      return React.createElement(PlaceholderView, { route: current })
  }
}

/**
 * The shell wraps the entire navigable TUI.
 * NavigationProvider manages the router state.
 * ViewRouter renders the current view using pre-built view models.
 */
export default function ShellView({ data }: { data?: ShellViewData }): React.JSX.Element {
  return React.createElement(
    NavigationProvider,
    null,
    React.createElement(ViewRouter, { data }),
  )
}
