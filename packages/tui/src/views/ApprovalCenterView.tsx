import React, { useState, useCallback } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import type { ThemeColorKey } from '../design-system/theme.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import ConfirmationDialog from '../design-system/ConfirmationDialog.js'
import ActionStatus from '../design-system/ActionStatus.js'
import { useNavigation } from '../navigation/context.js'
import { getCategoryLabel } from '../view-models/approval-center.js'
import { useClampedIndex } from '../hooks/use-clamped-index.js'
import { useActionDispatch } from '../actions/use-action-dispatch.js'
import { TuiActionCategory, TuiRiskLevel, TuiActionStatus } from '../actions/types.js'
import type { TuiAction, TuiActionResult } from '../actions/types.js'
import type { ApprovalCenterViewModel, ApprovalItem, ApprovalCategory } from '../view-models/approval-center.js'
import type { TuiActionHandlers } from './render-shell.js'

export type ApprovalCenterViewProps = {
  model: ApprovalCenterViewModel
  actionHandlers?: TuiActionHandlers
}

type ViewMode = 'list' | 'detail' | 'action-result'

/** Map ApprovalCategory to TuiActionCategory. */
function toActionCategory(category: ApprovalCategory): TuiActionCategory {
  switch (category) {
    case 'plan':
      return TuiActionCategory.PlanApproval
    case 'merge-request':
      return TuiActionCategory.MergeConfirmation
    case 'workflow-effect':
      return TuiActionCategory.WorkflowConfirmation
    case 'profile-sync':
      return TuiActionCategory.ProfileSyncConfirmation
    case 'github-review':
      return TuiActionCategory.GithubApproval
  }
}

/** Map risk string to TuiRiskLevel. */
function toRiskLevel(risk: string): TuiRiskLevel {
  switch (risk) {
    case 'critical':
      return TuiRiskLevel.Critical
    case 'high':
      return TuiRiskLevel.High
    case 'medium':
      return TuiRiskLevel.Medium
    default:
      return TuiRiskLevel.Low
  }
}

/** Determine the action verb based on approval category. */
function getActionVerb(category: ApprovalCategory, isApprove: boolean): string {
  if (isApprove) {
    switch (category) {
      case 'plan':
        return 'Approve plan'
      case 'merge-request':
        return 'Confirm merge'
      case 'workflow-effect':
        return 'Confirm effect'
      case 'profile-sync':
        return 'Sync profile'
      case 'github-review':
        return 'Show GitHub approval command'
    }
  }
  switch (category) {
    case 'plan':
      return 'Reject plan'
    case 'merge-request':
      return 'Cancel merge'
    case 'workflow-effect':
      return 'Cancel effect'
    case 'profile-sync':
      return 'Cancel sync'
    case 'github-review':
      return 'Show GitHub request-changes command'
  }
}

export function isTuiConfirmableApprovalCategory(category: ApprovalCategory): boolean {
  return category !== 'github-review'
}

/** CLI command suggestion for a given category. */
function getCliSuggestion(category: ApprovalCategory, isApprove: boolean, prNumber?: number): string {
  if (category === 'github-review') {
    const target = prNumber ? String(prNumber) : '<PR>'
    return isApprove
      ? `gh pr review ${target} --approve`
      : `gh pr review ${target} --request-changes`
  }
  if (category === 'merge-request') {
    return 'openslack pr merge <PR>'
  }
  if (category === 'profile-sync') {
    return 'openslack collaboration workflow profile-sync status'
  }
  return 'openslack collaboration decision record --topic "..." --decision "..."'
}

export default function ApprovalCenterView({ model, actionHandlers }: ApprovalCenterViewProps): React.JSX.Element {
  const { pop } = useNavigation()
  const [mode, setMode] = useState<ViewMode>('list')
  const [confirmingAction, setConfirmingAction] = useState<'approve' | 'reject' | null>(null)

  const {
    state: actionState,
    activeAction,
    dispatch: dispatchAction,
    confirm: confirmAction,
    cancel: cancelAction,
    reset: resetAction,
  } = useActionDispatch()

  // Flatten groups into a single navigable list while preserving group order
  const flatItems: ApprovalItem[] = []
  const groupBoundaries: number[] = [] // indices in flatItems where a new group starts
  for (const group of model.groups) {
    groupBoundaries.push(flatItems.length)
    flatItems.push(...group.items)
  }

  const items = flatItems
  const [selectedIndex, setSelectedIndex] = useClampedIndex(items.length)
  const selected: ApprovalItem | undefined = items[selectedIndex]
  const isExternalGithubReview = selected ? !isTuiConfirmableApprovalCategory(selected.category) : false

  /** Build a TuiAction for the selected item. */
  const buildAction = useCallback((isApprove: boolean): TuiAction | null => {
    if (!selected) return null
    const verb = getActionVerb(selected.category, isApprove)
    const suggestion = getCliSuggestion(selected.category, isApprove, selected.prNumber)
    return {
      id: `${selected.id}-${isApprove ? 'approve' : 'reject'}`,
      category: toActionCategory(selected.category),
      risk: toRiskLevel(selected.risk),
      label: verb,
      description: `${verb}: ${selected.title}`,
      requiresConfirmation: true,
      handler: async (): Promise<TuiActionResult> => {
        if (actionHandlers) {
          return actionHandlers.executeApproval({
            id: selected.id,
            category: selected.category,
            title: selected.title,
            planId: selected.planId,
            prNumber: selected.prNumber,
            workflowName: selected.workflowName,
            profileSyncAction: selected.profileSyncAction,
          }, isApprove)
        }
        return {
          success: false,
          message: `${verb} is not available in TUI. Use: ${suggestion}`,
          data: { cliCommand: suggestion, itemId: selected.id },
        }
      },
    }
  }, [selected, actionHandlers])

  /** Transition to action-result once execution finishes. */
  React.useEffect(() => {
    if (
      mode === 'detail' &&
      (actionState.status === TuiActionStatus.Success || actionState.status === TuiActionStatus.Error)
    ) {
      setMode('action-result')
      setConfirmingAction(null)
    }
  }, [actionState.status, mode])

  // Main input handler
  useInput((input, key) => {
    // action-result mode: any key returns to list
    if (mode === 'action-result') {
      resetAction()
      setConfirmingAction(null)
      setMode('list')
      return
    }

    // When confirmation dialog is showing, input is handled by ConfirmationDialog
    if (confirmingAction) return

    // action-status executing: swallow keys
    if (actionState.status === TuiActionStatus.Executing) return

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
      return
    }

    if (mode === 'detail') {
      if (isExternalGithubReview) return
      if (input === 'a' || input === 'A') {
        const action = buildAction(true)
        if (action) {
          setConfirmingAction('approve')
          dispatchAction(action)
        }
      } else if (input === 'r' || input === 'R') {
        const action = buildAction(false)
        if (action) {
          setConfirmingAction('reject')
          dispatchAction(action)
        }
      }
    }
  })

  // Confirmation handlers
  const handleConfirm = useCallback(() => {
    confirmAction()
  }, [confirmAction])

  const handleCancel = useCallback(() => {
    cancelAction()
    setConfirmingAction(null)
  }, [cancelAction])

  // Summary bar badges
  const summaryBadges: Array<{ label: string; count: number; colorTheme: ThemeColorKey }> = [
    { label: 'Plans', count: model.summary.plans, colorTheme: 'success' },
    { label: 'Merge', count: model.summary.mergeRequests, colorTheme: 'warning' },
    { label: 'Workflow', count: model.summary.workflowEffects, colorTheme: 'info' },
    { label: 'Profile', count: model.summary.profileSyncs, colorTheme: 'accent' },
    { label: 'Reviews', count: model.summary.githubReviews, colorTheme: 'error' },
  ]

  const hasAnyItems = summaryBadges.some(b => b.count > 0)

  // --- ACTION-RESULT MODE ---
  if (mode === 'action-result' && selected) {
    const actionLabel = activeAction ? activeAction.label : 'Action'
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
        { title: 'Action Result', marginY: 0 },
        React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(ActionStatus, { state: actionState, label: actionLabel }),
          actionState.result?.data?.cliCommand
            ? React.createElement(
                Box,
                { flexDirection: 'row', marginTop: 1 },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'CLI: '),
                React.createElement(ThemedText, { colorTheme: 'accent' }, String(actionState.result.data.cliCommand)),
              )
            : null,
        ),
      ),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(KeyboardShortcutHint, { keys: ['any key'], description: 'back to list' }),
      ),
    )
  }

  // --- DETAIL MODE ---
  if (mode === 'detail' && selected) {
    // Determine what to render below the item details
    let overlay: React.ReactNode = null

    if (confirmingAction && actionState.status === TuiActionStatus.Confirming && activeAction) {
      // Show confirmation dialog overlay
      overlay = React.createElement(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        React.createElement(ConfirmationDialog, {
          action: activeAction,
          onConfirm: handleConfirm,
          onCancel: handleCancel,
          isActive: true,
        }),
      )
    } else if (actionState.status === TuiActionStatus.Executing) {
      // Show executing status
      const actionLabel = activeAction ? activeAction.label : 'Action'
      overlay = React.createElement(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        React.createElement(ActionStatus, { state: actionState, label: actionLabel }),
      )
    }

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
          selected.explanation
            ? React.createElement(
                Box,
                { flexDirection: 'column', marginTop: 1 },
                selected.explanation.why
                  ? React.createElement(
                      Box,
                      { flexDirection: 'column' },
                      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Why:'),
                      React.createElement(ThemedText, { colorTheme: 'foreground' }, selected.explanation.why),
                    )
                  : null,
                selected.explanation.ifApproved
                  ? React.createElement(
                      Box,
                      { flexDirection: 'column', marginTop: 1 },
                      React.createElement(ThemedText, { colorTheme: 'muted' }, 'If approved:'),
                      React.createElement(ThemedText, { colorTheme: 'foreground' }, selected.explanation.ifApproved),
                    )
                  : null,
                selected.explanation.ifRejected
                  ? React.createElement(
                      Box,
                      { flexDirection: 'column', marginTop: 1 },
                      React.createElement(ThemedText, { colorTheme: 'muted' }, 'If rejected:'),
                      React.createElement(ThemedText, { colorTheme: 'foreground' }, selected.explanation.ifRejected),
                    )
                  : null,
                selected.explanation.source
                  ? React.createElement(
                      Box,
                      { flexDirection: 'column', marginTop: 1 },
                      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Source:'),
                      React.createElement(ThemedText, { colorTheme: 'foreground' }, selected.explanation.source),
                    )
                  : null,
              )
            : null,
          selected.category === 'github-review'
            ? React.createElement(
                Box,
                { flexDirection: 'column', marginTop: 1 },
                React.createElement(
                  Box,
                  { flexDirection: 'row' },
                  React.createElement(StatusIcon, { status: 'warn' }),
                  React.createElement(Text, null, ' '),
                  React.createElement(ThemedText, { colorTheme: 'warning' },
                    'This requires a human GitHub identity. The TUI cannot approve GitHub PRs directly.',
                  ),
                ),
                React.createElement(
                  Box,
                  { flexDirection: 'row', marginTop: 1 },
                  React.createElement(ThemedText, { colorTheme: 'muted' }, 'Use: '),
                  React.createElement(ThemedText, { colorTheme: 'accent' }, getCliSuggestion(selected.category, true, selected.prNumber)),
                ),
                React.createElement(
                  Box,
                  { flexDirection: 'row', marginTop: 1 },
                  React.createElement(ThemedText, { colorTheme: 'muted' }, 'TUI action: '),
                  React.createElement(ThemedText, { colorTheme: 'foreground' }, 'disabled for GitHub review approvals'),
                ),
              )
            : null,
          // Merge request specific note about PRMS re-check
          selected.category === 'merge-request'
            ? React.createElement(
                Box,
                { flexDirection: 'column', marginTop: 1 },
                React.createElement(
                  Box,
                  { flexDirection: 'row' },
                  React.createElement(StatusIcon, { status: 'info' }),
                  React.createElement(Text, null, ' '),
                  React.createElement(ThemedText, { colorTheme: 'info' },
                    'Merge will re-run PRMS doctor before executing to verify all gates still pass.',
                  ),
                ),
                React.createElement(
                  Box,
                  { flexDirection: 'row', marginTop: 1 },
                  React.createElement(ThemedText, { colorTheme: 'muted' }, 'Forbidden: '),
                  React.createElement(ThemedText, { colorTheme: 'error' }, 'Self-merge, auto-merge, Black Zone merge'),
                ),
              )
            : null,
          // Boundary note for workflow effects
          selected.category === 'workflow-effect'
            ? React.createElement(
                Box,
                { flexDirection: 'row', marginTop: 1 },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Boundary: '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, 'TUI confirmation resumes or cancels the workflow. GitHub PR approval is separate.'),
              )
            : null,
          // Boundary note for plans
          selected.category === 'plan'
            ? React.createElement(
                Box,
                { flexDirection: 'row', marginTop: 1 },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Boundary: '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, 'TUI confirmation approves or rejects the plan. This is not a GitHub PR approval.'),
              )
            : null,
          React.createElement(
            Box,
            { flexDirection: 'row', marginTop: 1 },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'CLI: '),
            React.createElement(ThemedText, { colorTheme: 'accent' }, getCliSuggestion(selected.category, true, selected.prNumber)),
          ),
        ),
      ),
      overlay,
      React.createElement(Divider, { length: 40 }),
      isExternalGithubReview
        ? React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Back' }),
          )
        : React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(KeyboardShortcutHint, { keys: ['a'], description: 'Approve' }),
            React.createElement(Text, null, '  '),
            React.createElement(KeyboardShortcutHint, { keys: ['r'], description: 'Reject' }),
            React.createElement(Text, null, '  '),
            React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Back' }),
          ),
    )
  }

  // --- LIST MODE ---
  const listRows: React.ReactNode[] = []
  let globalIndex = 0
  for (const group of model.groups) {
    // Group header
    listRows.push(
      React.createElement(
        Box,
        { key: `group-${group.category}`, flexDirection: 'row', marginTop: 1 },
        React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, group.label),
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, ` (${group.items.length})`),
      ),
    )
    // Group items
    for (const item of group.items) {
      const i = globalIndex
      const isSelected = i === selectedIndex
      const pointer = isSelected ? '>' : ' '
      const categoryIcon = item.category === 'plan' ? 'pass'
        : item.category === 'merge-request' ? 'warn'
        : item.category === 'workflow-effect' ? 'info'
        : item.category === 'profile-sync' ? 'info'
        : 'blocked'

      listRows.push(
        React.createElement(
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
        ),
      )
      globalIndex++
    }
  }

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack / Approvals'),
      React.createElement(Text, null, '  '),
      ...hasAnyItems
        ? summaryBadges.map(badge =>
            React.createElement(
              Text,
              { key: badge.label },
              '  ',
              React.createElement(ThemedText,
                badge.count > 0
                  ? { colorTheme: badge.colorTheme, bold: true }
                  : { colorTheme: 'muted', dim: true },
                `●${badge.label}: ${badge.count}`,
              ),
            ),
          )
        : [React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, 'No pending approvals')],
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
