import React, { useState, useCallback } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import ConfirmationDialog from '../design-system/ConfirmationDialog.js'
import ActionStatus from '../design-system/ActionStatus.js'
import { useNavigation } from '../navigation/context.js'
import { useClampedIndex } from '../hooks/use-clamped-index.js'
import { useActionDispatch } from '../actions/use-action-dispatch.js'
import { TuiActionCategory, TuiRiskLevel, TuiActionStatus } from '../actions/types.js'
import type { TuiAction, TuiActionResult } from '../actions/types.js'
import type { WorkflowLifecycleViewModel, LifecycleStage, PhaseIssueItem } from '../view-models/workflow-lifecycle.js'
import { mapCanonicalStages } from '../view-models/workflow-lifecycle.js'
import type { CanonicalStageSlot, CanonicalStageStatus } from '../view-models/workflow-lifecycle.js'
import type { TuiActionHandlers } from './render-shell.js'

export type WorkflowLifecycleViewProps = {
  model: WorkflowLifecycleViewModel
  actionHandlers?: TuiActionHandlers
  onBack?: () => void
}

type ViewMode = 'stages' | 'detail' | 'action-result'

/** Map a stage status string to a StatusIcon category. */
function stageStatusCategory(status: string): 'pass' | 'warn' | 'fail' | 'blocked' | 'info' {
  const lower = status.toLowerCase()
  if (lower === 'complete' || lower === 'done' || lower === 'merged' || lower === 'approved') return 'pass'
  if (lower === 'in-progress' || lower === 'running' || lower === 'active') return 'info'
  if (lower === 'blocked' || lower === 'waiting') return 'blocked'
  if (lower === 'failed' || lower === 'error' || lower === 'rejected') return 'fail'
  return 'warn'
}

/** Map a phase issue status string to a StatusIcon category. */
function issueStatusCategory(status: string): 'pass' | 'warn' | 'fail' | 'blocked' | 'info' {
  const lower = status.toLowerCase()
  if (lower === 'closed' || lower === 'merged' || lower === 'resolved') return 'pass'
  if (lower === 'blocked' || lower === 'waiting') return 'blocked'
  if (lower === 'failed' || lower === 'error') return 'fail'
  if (lower === 'open' || lower === 'in-progress') return 'info'
  return 'warn'
}

/** Determine the color theme key for a trust level badge. */
function trustColorTheme(trustLevel: string): 'pass' | 'warning' | 'error' | 'info' {
  if (trustLevel === 'core') return 'pass'
  if (trustLevel === 'trusted') return 'info'
  return 'error'
}

/** Determine the color theme key for a risk level badge. */
function riskColorTheme(risk: string): 'warning' | 'error' | 'muted' {
  if (risk === 'high' || risk === 'critical') return 'error'
  if (risk === 'medium') return 'warning'
  return 'muted'
}

/** Determine the color theme key for a PR status. */
function prStatusColorTheme(status: string | undefined): 'success' | 'error' | 'warning' | 'muted' {
  if (!status) return 'muted'
  const lower = status.toLowerCase()
  if (lower.includes('open') || lower.includes('draft')) return 'warning'
  if (lower.includes('merged') || lower.includes('closed')) return 'success'
  if (lower.includes('fail') || lower.includes('rejected')) return 'error'
  return 'muted'
}

/** Determine the color theme key for sub-issue mode badge. */
function subIssueModeColorTheme(mode: string | undefined): 'pass' | 'info' | 'warning' | 'muted' {
  if (mode === 'native') return 'pass'
  if (mode === 'mixed') return 'warning'
  if (mode === 'fallback') return 'info'
  return 'muted'
}

/** Determine the color theme key for dependency mode badge. */
function dependencyModeColorTheme(mode: string | undefined): 'pass' | 'info' | 'warning' | 'muted' {
  if (mode === 'native') return 'pass'
  if (mode === 'mixed') return 'warning'
  if (mode === 'fallback') return 'info'
  return 'muted'
}

export default function WorkflowLifecycleView({ model, actionHandlers, onBack }: WorkflowLifecycleViewProps): React.JSX.Element {
  const { pop } = useNavigation()
  const [mode, setMode] = useState<ViewMode>('stages')

  const {
    state: actionState,
    activeAction,
    dispatch: dispatchAction,
    confirm: confirmAction,
    cancel: cancelAction,
    reset: resetAction,
  } = useActionDispatch()

  const stages = model.stages
  const [selectedIndex, setSelectedIndex] = useClampedIndex(stages.length)
  const selectedStage: LifecycleStage | undefined = stages[selectedIndex]

  const handleBack = useCallback(() => {
    if (onBack) {
      onBack()
    } else {
      pop()
    }
  }, [onBack, pop])

  /** Build a TuiAction for running the workflow. */
  const buildRunAction = useCallback((): TuiAction | null => {
    return {
      id: `run-lifecycle-${model.workflowName}`,
      category: TuiActionCategory.WorkflowExecute,
      risk: model.risk === 'high' ? TuiRiskLevel.High : model.risk === 'medium' ? TuiRiskLevel.Medium : TuiRiskLevel.Low,
      label: `Run ${model.workflowName}`,
      description: `Execute workflow "${model.workflowName}" from the lifecycle board.`,
      requiresConfirmation: true,
      handler: async (): Promise<TuiActionResult> => {
        if (actionHandlers) {
          return actionHandlers.executeWorkflowRun(model.workflowName, 'run')
        }
        return {
          success: false,
          message: `Run is not available in TUI. Use: openslack collaboration workflow run ${model.workflowName}`,
          data: { cliCommand: `openslack collaboration workflow run ${model.workflowName}`, workflow: model.workflowName },
        }
      },
    }
  }, [model.workflowName, model.risk, actionHandlers])

  /** Build a TuiAction for dry-running the workflow. */
  const buildDryRunAction = useCallback((): TuiAction | null => {
    return {
      id: `dry-run-lifecycle-${model.workflowName}`,
      category: TuiActionCategory.WorkflowDryRun,
      risk: TuiRiskLevel.Low,
      label: `Dry-run ${model.workflowName}`,
      description: `Simulated execution of workflow "${model.workflowName}". No real changes will be applied.`,
      requiresConfirmation: false,
      handler: async (): Promise<TuiActionResult> => {
        if (actionHandlers) {
          return actionHandlers.executeWorkflowRun(model.workflowName, 'dry-run')
        }
        return { success: false, message: 'Dry-run handler not available' }
      },
    }
  }, [model.workflowName, actionHandlers])

  /** Transition to action-result once execution finishes. */
  React.useEffect(() => {
    if (
      mode === 'detail' &&
      (actionState.status === TuiActionStatus.Success || actionState.status === TuiActionStatus.Error)
    ) {
      setMode('action-result')
    }
  }, [actionState.status, mode])

  // Main input handler
  useInput((input, key) => {
    // action-result mode: any key returns to stages
    if (mode === 'action-result') {
      resetAction()
      setMode('stages')
      return
    }

    // When confirmation dialog is showing, input is handled by ConfirmationDialog
    if (actionState.status === TuiActionStatus.Confirming) return

    // action-status executing: swallow keys
    if (actionState.status === TuiActionStatus.Executing) return

    if (input === 'q' || key.escape) {
      if (mode === 'detail') {
        setMode('stages')
      } else {
        handleBack()
      }
      return
    }

    if (mode === 'stages') {
      if (key.upArrow) {
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : stages.length - 1))
      } else if (key.downArrow) {
        setSelectedIndex(prev => (prev < stages.length - 1 ? prev + 1 : 0))
      } else if (key.return && stages.length > 0) {
        setMode('detail')
      } else if (input === 'r' || input === 'R') {
        if (selectedStage) {
          setMode('detail')
          const action = buildRunAction()
          if (action) {
            dispatchAction(action)
          }
        }
      } else if (input === 'd' || input === 'D') {
        const action = buildDryRunAction()
        if (action) {
          dispatchAction(action)
          setMode('action-result')
        }
      } else if (input === 'f' || input === 'F') {
        if (model.prNumber && actionHandlers?.finalizeWorkflowPr) {
          const action: TuiAction = {
            id: `finalize-pr-${model.workflowName}`,
            category: TuiActionCategory.WorkflowExecute,
            risk: TuiRiskLevel.Low,
            label: `Finalize PR #${model.prNumber}`,
            description: `Finalize PR #${model.prNumber} for workflow "${model.workflowName}".`,
            requiresConfirmation: true,
            handler: async (): Promise<TuiActionResult> => {
              return actionHandlers.finalizeWorkflowPr!(model.workflowName, model.prNumber!)
            },
          }
          dispatchAction(action)
        }
      }
      return
    }

    if (mode === 'detail') {
      if (input === 'r' || input === 'R') {
        const action = buildRunAction()
        if (action) {
          dispatchAction(action)
        }
      } else if (input === 'd' || input === 'D') {
        const action = buildDryRunAction()
        if (action) {
          dispatchAction(action)
          setMode('action-result')
        }
      } else if (input === 'f' || input === 'F') {
        if (model.prNumber && actionHandlers?.finalizeWorkflowPr) {
          const action: TuiAction = {
            id: `finalize-pr-${model.workflowName}`,
            category: TuiActionCategory.WorkflowExecute,
            risk: TuiRiskLevel.Low,
            label: `Finalize PR #${model.prNumber}`,
            description: `Finalize PR #${model.prNumber} for workflow "${model.workflowName}".`,
            requiresConfirmation: true,
            handler: async (): Promise<TuiActionResult> => {
              return actionHandlers.finalizeWorkflowPr!(model.workflowName, model.prNumber!)
            },
          }
          dispatchAction(action)
        }
      }
    }
  })

  // --- ACTION-RESULT MODE ---
  if (mode === 'action-result') {
    const actionLabel = activeAction ? activeAction.label : 'Action'
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `OpenSlack / Lifecycle / ${model.workflowName}`),
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
        React.createElement(KeyboardShortcutHint, { keys: ['any key'], description: 'back to stages' }),
      ),
    )
  }

  // --- DETAIL MODE ---
  if (mode === 'detail' && selectedStage) {
    const stage = selectedStage
    const stageCat = stageStatusCategory(stage.status)

    let overlay: React.ReactNode = null

    if (actionState.status === TuiActionStatus.Confirming && activeAction) {
      overlay = React.createElement(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        React.createElement(ConfirmationDialog, {
          action: activeAction,
          onConfirm: confirmAction,
          onCancel: cancelAction,
          isActive: true,
        }),
      )
    } else if (actionState.status === TuiActionStatus.Executing) {
      const actionLabel = activeAction ? activeAction.label : 'Action'
      overlay = React.createElement(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        React.createElement(ActionStatus, { state: actionState, label: actionLabel }),
      )
    }

    // Find phase issue for this stage, if any
    const phaseIssue = model.phaseIssues.find(pi => pi.phase === stage.name)

    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `OpenSlack / Lifecycle / ${model.workflowName}`),
      ),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Pane,
        { title: `${stage.label}`, marginY: 0 },
        React.createElement(Box, { flexDirection: 'column' },
          React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Status: '),
            React.createElement(StatusIcon, { status: stage.status }),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, ` ${stage.status}`),
          ),
          stage.detail
            ? React.createElement(
                Box,
                { flexDirection: 'column', marginTop: 1 },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Detail:'),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, stage.detail),
              )
            : null,
          stage.issueNumber
            ? React.createElement(
                Box,
                { flexDirection: 'row', marginTop: 1 },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Issue: #'),
                React.createElement(ThemedText, { colorTheme: 'accent' }, String(stage.issueNumber)),
              )
            : null,
          phaseIssue
            ? React.createElement(
                Box,
                { flexDirection: 'column', marginTop: 1 },
                React.createElement(
                  Box,
                  { flexDirection: 'row' },
                  React.createElement(ThemedText, { colorTheme: 'muted' }, 'Phase Issue: #'),
                  React.createElement(ThemedText, { colorTheme: 'accent' }, String(phaseIssue.issueNumber)),
                  React.createElement(Text, null, ' '),
                  React.createElement(StatusIcon, { status: phaseIssue.status }),
                  React.createElement(ThemedText, { colorTheme: 'foreground' }, ` ${phaseIssue.status}`),
                ),
                phaseIssue.blockedBy && phaseIssue.blockedBy.length > 0
                  ? React.createElement(
                      Box,
                      { flexDirection: 'row', marginTop: 1 },
                      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Blocked by: '),
                      React.createElement(ThemedText, { colorTheme: 'foreground' }, phaseIssue.blockedBy.join(', ')),
                    )
                  : null,
              )
            : null,
        ),
      ),
      overlay,
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(KeyboardShortcutHint, { keys: ['r'], description: 'Run' }),
        React.createElement(Text, null, '  '),
        React.createElement(KeyboardShortcutHint, { keys: ['d'], description: 'Dry-run' }),
        React.createElement(Text, null, '  '),
        React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Back' }),
      ),
    )
  }

  // --- STAGES MODE (default) ---
  const canonicalSlots: CanonicalStageSlot[] = mapCanonicalStages(stages)

  // Map canonical status to a StatusIcon-compatible status string
  function canonicalStatusIcon(status: CanonicalStageStatus): string {
    if (status === 'complete') return 'complete'
    if (status === 'current') return 'in-progress'
    if (status === 'failed') return 'failed'
    return 'pending'
  }

  // Build the horizontal progress bar nodes and connectors
  const progressBarNodes: React.ReactNode[] = []
  for (let i = 0; i < canonicalSlots.length; i++) {
    const slot = canonicalSlots[i]!
    const isCurrent = slot.status === 'current'
    const iconStatus = canonicalStatusIcon(slot.status)

    // Stage node: icon + label
    const node = React.createElement(
      Box,
      { key: `stage-${slot.key}`, flexDirection: 'column' },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(StatusIcon, { status: iconStatus }),
        React.createElement(Text, null, ' '),
        isCurrent
          ? React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, slot.label)
          : slot.status === 'complete'
            ? React.createElement(ThemedText, { colorTheme: 'pass' }, slot.label)
            : slot.status === 'failed'
              ? React.createElement(ThemedText, { colorTheme: 'error' }, slot.label)
              : React.createElement(ThemedText, { colorTheme: 'muted' }, slot.label),
        slot.issueNumber
          ? React.createElement(
              Box,
              { flexDirection: 'row' },
              React.createElement(Text, null, ' '),
              React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `#${slot.issueNumber}`),
            )
          : null,
      ),
    )
    progressBarNodes.push(node)

    // Connector between stages (not after last)
    if (i < canonicalSlots.length - 1) {
      const nextSlot = canonicalSlots[i + 1]!
      const allUpToHereComplete = slot.status === 'complete'
      const connectorText = allUpToHereComplete ? '───' : '- -'

      progressBarNodes.push(
        React.createElement(
          Box,
          { key: `conn-${slot.key}-${nextSlot.key}`, flexDirection: 'row' },
          React.createElement(Text, null, ' '),
          allUpToHereComplete
            ? React.createElement(ThemedText, { colorTheme: 'pass' }, connectorText)
            : React.createElement(ThemedText, { colorTheme: 'muted' }, connectorText),
          React.createElement(Text, null, ' '),
        ),
      )
    }
  }

  // Find current stage name for the bold label below progress bar
  const currentCanonical = canonicalSlots.find(s => s.status === 'current')

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `OpenSlack / Lifecycle / ${model.workflowName}`),
    ),
    React.createElement(Divider, { length: 40 }),
    // Metadata bar
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Hash: '),
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, model.workflowHash),
    ),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Source: '),
      React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, model.sourcePath),
    ),
    React.createElement(
      Box,
      { flexDirection: 'row', marginBottom: 1 },
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Trust: '),
      React.createElement(ThemedText, { colorTheme: trustColorTheme(model.trustLevel) }, model.trustLevel),
      React.createElement(Text, null, '  '),
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Risk: '),
      React.createElement(ThemedText, { colorTheme: riskColorTheme(model.risk) }, model.risk),
      model.subIssueMode
        ? React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(Text, null, '  '),
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Sub-issues: '),
            React.createElement(ThemedText, { colorTheme: subIssueModeColorTheme(model.subIssueMode) }, model.subIssueMode),
          )
        : null,
      model.dependencyMode
        ? React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(Text, null, '  '),
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Deps: '),
            React.createElement(ThemedText, { colorTheme: dependencyModeColorTheme(model.dependencyMode) }, model.dependencyMode),
          )
        : null,
    ),
    // Horizontal progress bar
    stages.length > 0
      ? React.createElement(
          Pane,
          { title: 'Lifecycle Stages', marginY: 0 },
          React.createElement(
            Box,
            { flexDirection: 'row', flexWrap: 'wrap' },
            ...progressBarNodes,
          ),
          // Current stage label below the progress bar
          currentCanonical
            ? React.createElement(
                Box,
                { flexDirection: 'row', marginTop: 1 },
                React.createElement(ThemedText, { colorTheme: 'muted' }, 'Current: '),
                React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, currentCanonical.label),
              )
            : null,
        )
      : React.createElement(
          Box,
          { flexDirection: 'column', marginY: 1 },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'No GitHub issues found for this workflow.'),
          React.createElement(
            Box,
            { flexDirection: 'row', marginTop: 1 },
            React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, 'Use the Issues menu ('),
            React.createElement(ThemedText, { colorTheme: 'accent' }, 'i'),
            React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, ') to publish.'),
          ),
        ),
    // Phase issues summary
    model.phaseIssues.length > 0
      ? React.createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Phase Issues: '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, String(model.phaseIssues.length)),
          ),
          model.phaseIssues.map((pi: PhaseIssueItem) =>
            React.createElement(
              Box,
              { key: pi.phase, flexDirection: 'row', marginLeft: 2 },
              React.createElement(StatusIcon, { status: pi.status }),
              React.createElement(Text, null, ' '),
              React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, pi.issueNumber ? `#${pi.issueNumber} ${pi.phase}` : pi.phase),
            ),
          ),
        )
      : null,
    model.fallbackReasons && model.fallbackReasons.length > 0
      ? React.createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Fallback Reasons:'),
          model.fallbackReasons.slice(0, 3).map((reason, idx) =>
            React.createElement(
              Box,
              { key: `fallback-${idx}`, flexDirection: 'row', marginLeft: 2 },
              React.createElement(ThemedText, { colorTheme: 'info' }, '- '),
              React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, reason),
            ),
          ),
        )
      : null,
    // Current run info
    model.currentRun
      ? React.createElement(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Current Run: '),
            React.createElement(ThemedText, { colorTheme: 'info' }, model.currentRun.runId),
          ),
          React.createElement(
            Box,
            { flexDirection: 'row', marginLeft: 2 },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Status: '),
            React.createElement(ThemedText, { colorTheme: model.currentRun.status === 'running' ? 'warning' : 'success' }, model.currentRun.status),
            React.createElement(Text, null, '  '),
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Phase: '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, String(model.currentRun.phaseIndex)),
          ),
        )
      : null,
    // PR info
    model.prNumber
      ? React.createElement(
          Box,
          { flexDirection: 'row', marginTop: 1 },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'PR: #' ),
          React.createElement(ThemedText, { colorTheme: 'accent' }, String(model.prNumber)),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: prStatusColorTheme(model.prStatus) }, model.prStatus ?? ''),
        )
      : null,
    // Next action hint
    model.nextAction
      ? React.createElement(
          Box,
          { flexDirection: 'row', marginTop: 1 },
          React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, 'Next: '),
          React.createElement(ThemedText, { colorTheme: 'foreground' }, model.nextAction),
        )
      : null,
    React.createElement(Divider, { length: 40 }),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Up/Down'], description: 'navigate' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'inspect' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['r'], description: 'run' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['d'], description: 'dry-run' }),
      model.prNumber && actionHandlers?.finalizeWorkflowPr
        ? React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(Text, null, '  '),
            React.createElement(KeyboardShortcutHint, { keys: ['f'], description: 'finalize PR' }),
          )
        : null,
    ),
  )
}
