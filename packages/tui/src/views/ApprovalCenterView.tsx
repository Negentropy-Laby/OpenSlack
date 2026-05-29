import React, { useState, useCallback } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import ThemedBox from '../design-system/ThemedBox.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import ConfirmationDialog from '../design-system/ConfirmationDialog.js'
import ActionStatus from '../design-system/ActionStatus.js'
import { useNavigation } from '../navigation/context.js'
import { getCategoryLabel } from '../view-models/approval-center.js'
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
      case 'github-review':
        return 'Approve review'
    }
  }
  switch (category) {
    case 'plan':
      return 'Reject plan'
    case 'merge-request':
      return 'Cancel merge'
    case 'workflow-effect':
      return 'Cancel effect'
    case 'github-review':
      return 'Dismiss review'
  }
}

/** CLI command suggestion for a given category. */
function getCliSuggestion(category: ApprovalCategory, isApprove: boolean): string {
  if (category === 'github-review') {
    return isApprove
      ? 'gh pr review <PR> --approve'
      : 'gh pr review <PR> --request-changes'
  }
  if (category === 'merge-request') {
    return 'openslack pr merge <PR>'
  }
  return 'openslack collaboration decision record --topic "..." --decision "..."'
}

export default function ApprovalCenterView({ model, actionHandlers }: ApprovalCenterViewProps): React.JSX.Element {
  const { pop } = useNavigation()
  const [selectedIndex, setSelectedIndex] = useState(0)
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

  const items = model.pendingApprovals
  const selected: ApprovalItem | undefined = items[selectedIndex]

  /** Build a TuiAction for the selected item. */
  const buildAction = useCallback((isApprove: boolean): TuiAction | null => {
    if (!selected) return null
    const verb = getActionVerb(selected.category, isApprove)
    const suggestion = getCliSuggestion(selected.category, isApprove)
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

  // Summary bar
  const summaryParts: string[] = []
  if (model.summary.plans > 0) summaryParts.push(`Plans: ${model.summary.plans}`)
  if (model.summary.mergeRequests > 0) summaryParts.push(`Merge: ${model.summary.mergeRequests}`)
  if (model.summary.workflowEffects > 0) summaryParts.push(`Effects: ${model.summary.workflowEffects}`)
  if (model.summary.githubReviews > 0) summaryParts.push(`Reviews: ${model.summary.githubReviews}`)

  const summaryText = summaryParts.length > 0 ? summaryParts.join(' | ') : 'No pending approvals'

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
          React.createElement(
            Box,
            { flexDirection: 'row', marginTop: 1 },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'CLI: '),
            React.createElement(ThemedText, { colorTheme: 'accent' }, getCliSuggestion(selected.category, true)),
          ),
        ),
      ),
      overlay,
      React.createElement(Divider, { length: 40 }),
      React.createElement(
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
  const listRows = items.map((item, i) => {
    const isSelected = i === selectedIndex
    const pointer = isSelected ? '>' : ' '
    const categoryIcon = item.category === 'plan' ? 'pass'
      : item.category === 'merge-request' ? 'warn'
      : item.category === 'workflow-effect' ? 'info'
      : 'blocked'

    return React.createElement(
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
    )
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'OpenSlack / Approvals'),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, summaryText),
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
