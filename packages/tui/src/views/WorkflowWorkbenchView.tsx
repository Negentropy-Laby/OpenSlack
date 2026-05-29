import React, { useState, useCallback } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
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
import { useActionDispatch } from '../actions/use-action-dispatch.js'
import {
  TuiActionCategory,
  TuiRiskLevel,
  TuiActionStatus,
} from '../actions/types.js'
import type { TuiAction, TuiActionResult } from '../actions/types.js'
import { sanitizeTerminalText } from '../sanitize.js'
import type { WorkflowGalleryViewModel, WorkflowGalleryItem } from '../view-models/workflow-gallery.js'
import type { TuiActionHandlers } from './render-shell.js'

type ViewMode = 'gallery' | 'detail' | 'action-result'

/** Trust levels ordered from least to most privileged. */
const TRUST_LEVELS = ['untrusted', 'trusted'] as const
const PROTECTED_TRUST_LEVELS = new Set(['core', 'builtin'])

type WorkflowWorkbenchProps = {
  galleryModel: WorkflowGalleryViewModel
  actionHandlers?: TuiActionHandlers
}

/** Determine the color theme key for a trust level badge. */
function trustColorTheme(trustLevel: string): 'pass' | 'warning' | 'error' | 'info' {
  if (trustLevel === 'core') return 'pass'
  if (trustLevel === 'trusted') return 'info'
  return 'error'
}

/** Determine the status icon category for a trust level. */
function trustIconCategory(trustLevel: string): 'pass' | 'warn' | 'blocked' {
  if (trustLevel === 'core') return 'pass'
  if (trustLevel === 'trusted') return 'warn'
  return 'blocked'
}

/** Determine the status icon category for a risk level. */
function riskIconCategory(risk: string): 'pass' | 'warn' | 'fail' {
  if (risk === 'low') return 'pass'
  if (risk === 'high') return 'fail'
  return 'warn'
}

/** Determine the color theme key for a last run status. */
function lastRunColorTheme(status: string | undefined): 'success' | 'error' | 'warning' | 'muted' {
  if (!status) return 'muted'
  const lower = status.toLowerCase()
  if (lower.includes('success') || lower.includes('pass') || lower === 'ok') return 'success'
  if (lower.includes('fail') || lower.includes('error')) return 'error'
  if (lower.includes('running') || lower.includes('pending')) return 'warning'
  return 'muted'
}

export default function WorkflowWorkbenchView({ galleryModel, actionHandlers }: WorkflowWorkbenchProps): React.JSX.Element {
  const { pop } = useNavigation()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<ViewMode>('gallery')
  const [lastRunStatus, setLastRunStatus] = useState<string | undefined>(undefined)  // kept for future run-store integration

  const actionDispatch = useActionDispatch()

  const items = galleryModel.workflows
  const currentWf = items[selectedIndex] as WorkflowGalleryItem | undefined

  // --- Action factories ---

  const makePreviewAction = useCallback((wf: WorkflowGalleryItem): TuiAction => ({
    id: `preview-${wf.name}`,
    category: TuiActionCategory.WorkflowPreview,
    risk: TuiRiskLevel.Low,
    label: `Preview ${wf.name}`,
    description: `Read-only preview of workflow "${wf.name}". No changes will be made.`,
    requiresConfirmation: false,
    handler: async (): Promise<TuiActionResult> => {
      if (actionHandlers) {
        return actionHandlers.executeWorkflowRun(wf.name, 'preview')
      }
      return { success: false, message: 'Preview handler not available' }
    },
  }), [actionHandlers])

  const makeDryRunAction = useCallback((wf: WorkflowGalleryItem): TuiAction => ({
    id: `dry-run-${wf.name}`,
    category: TuiActionCategory.WorkflowDryRun,
    risk: TuiRiskLevel.Low,
    label: `Dry-run ${wf.name}`,
    description: `Simulated execution of workflow "${wf.name}". No real changes will be applied.`,
    requiresConfirmation: false,
    handler: async (): Promise<TuiActionResult> => {
      if (actionHandlers) {
        return actionHandlers.executeWorkflowRun(wf.name, 'dry-run')
      }
      return { success: false, message: 'Dry-run handler not available' }
    },
  }), [actionHandlers])

  const makeRunAction = useCallback((wf: WorkflowGalleryItem): TuiAction => ({
    id: `run-${wf.name}`,
    category: TuiActionCategory.WorkflowExecute,
    risk: wf.risk === 'high' ? TuiRiskLevel.High : wf.risk === 'medium' ? TuiRiskLevel.Medium : TuiRiskLevel.Low,
    label: `Run ${wf.name}`,
    description: `Execute workflow "${wf.name}". This will run all ${wf.phases} phase(s) and apply changes.`,
    requiresConfirmation: true,
    handler: async (): Promise<TuiActionResult> => {
      if (actionHandlers) {
        return actionHandlers.executeWorkflowRun(wf.name, 'run')
      }
      return {
        success: false,
        message: `Run is not available in TUI. Use: openslack collaboration workflow run ${wf.name}`,
        data: { cliCommand: `openslack collaboration workflow run ${wf.name}`, workflow: wf.name },
      }
    },
  }), [actionHandlers])

  const makeTrustAction = useCallback((wf: WorkflowGalleryItem): TuiAction => {
    const currentTrust = wf.trustLevel
    const isProtected = PROTECTED_TRUST_LEVELS.has(currentTrust)
    const currentIdx = TRUST_LEVELS.indexOf(currentTrust as typeof TRUST_LEVELS[number])
    const nextLevel = currentIdx >= 0 && currentIdx < TRUST_LEVELS.length - 1
      ? TRUST_LEVELS[currentIdx + 1]
      : TRUST_LEVELS[0]

    return {
      id: `trust-${wf.name}`,
      category: TuiActionCategory.TrustChange,
      risk: TuiRiskLevel.Medium,
      label: `Trust ${wf.name}: ${currentTrust} -> ${nextLevel}`,
      description: isProtected
        ? `Cannot change trust level for "${wf.name}": "${currentTrust}" workflows are protected.`
        : `Change trust level of "${wf.name}" from "${currentTrust}" to "${nextLevel}".`,
      requiresConfirmation: true,
      handler: async (): Promise<TuiActionResult> => {
        if (actionHandlers) {
          return actionHandlers.executeTrustChange(wf.name, currentTrust, nextLevel)
        }
        return {
          success: false,
          message: `Trust change is not available in TUI. Use: openslack collaboration workflow trust ${wf.name} --level ${nextLevel}`,
          data: { cliCommand: `openslack collaboration workflow trust ${wf.name} --level ${nextLevel}`, workflow: wf.name, from: currentTrust, to: nextLevel },
        }
      },
    }
  }, [actionHandlers])

  // --- Transition helpers ---

  const goToActionResult = useCallback(() => {
    setMode('action-result')
  }, [])

  const goToDetail = useCallback(() => {
    actionDispatch.reset()
    setMode('detail')
  }, [actionDispatch])

  // --- Input handler ---

  const isConfirming = actionDispatch.state.status === TuiActionStatus.Confirming
  const isExecuting = actionDispatch.state.status === TuiActionStatus.Executing
  const inputBlocked = isConfirming || isExecuting

  useInput((input, key) => {
    // Global back
    if (input === 'q' || key.escape) {
      if (mode === 'action-result') {
        goToDetail()
        return
      }
      if (mode === 'detail') {
        setMode('gallery')
        actionDispatch.reset()
        return
      }
      pop()
      return
    }

    // Gallery mode navigation
    if (mode === 'gallery') {
      if (key.upArrow) {
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : items.length - 1))
      } else if (key.downArrow) {
        setSelectedIndex(prev => (prev < items.length - 1 ? prev + 1 : 0))
      } else if (key.return && items.length > 0) {
        setMode('detail')
      }
      return
    }

    // Detail mode actions
    if (mode === 'detail' && currentWf && !inputBlocked) {
      if (input === 'p') {
        actionDispatch.dispatch(makePreviewAction(currentWf))
        goToActionResult()
        return
      }
      if (input === 'd') {
        actionDispatch.dispatch(makeDryRunAction(currentWf))
        goToActionResult()
        return
      }
      if (input === 'r') {
        actionDispatch.dispatch(makeRunAction(currentWf))
        return
      }
      if (input === 't') {
        actionDispatch.dispatch(makeTrustAction(currentWf))
        return
      }
    }

    // Action-result mode: enter to return to detail
    if (mode === 'action-result') {
      if (key.return) {
        const terminal = actionDispatch.state.status === TuiActionStatus.Success || actionDispatch.state.status === TuiActionStatus.Error
        if (terminal) {
          goToDetail()
        }
      }
    }
  })

  // --- Render helpers ---

  const renderBreadcrumbs = (suffix: string) =>
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `OpenSlack / Workflows${suffix}`),
    )

  const renderDetailHintBar = () =>
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['p'], description: 'Preview' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['d'], description: 'Dry-run' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['r'], description: 'Run' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['t'], description: 'Trust' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Back' }),
    )

  const renderTrustInfo = (wf: WorkflowGalleryItem) => {
    const isProtected = PROTECTED_TRUST_LEVELS.has(wf.trustLevel)
    const trustCat = trustIconCategory(wf.trustLevel)
    const trustCol = trustColorTheme(wf.trustLevel)

    return React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Trust: '),
      React.createElement(StatusIcon, { status: trustCat === 'pass' ? 'pass' : trustCat === 'warn' ? 'warn' : 'blocked' }),
      React.createElement(ThemedText, { colorTheme: trustCol }, ` ${wf.trustLevel}`),
      isProtected
        ? React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, ' (protected)')
        : null,
    )
  }

  const renderLastRunInfo = (wf: WorkflowGalleryItem) => {
    const status = lastRunStatus ?? wf.lastRunStatus
    if (!status) {
      return React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: 'muted' }, 'Last run: '),
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, 'never'),
      )
    }
    const colorKey = lastRunColorTheme(status)
    return React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Last run: '),
      React.createElement(ThemedText, { colorTheme: colorKey }, status),
    )
  }

  // --- Confirmation overlay for run / trust in detail mode ---
  if (mode === 'detail' && currentWf && actionDispatch.activeAction && isConfirming) {
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      renderBreadcrumbs(` / ${currentWf.name}`),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Pane,
        { title: 'Confirm Action', marginY: 0 },
        React.createElement(ConfirmationDialog, {
          action: actionDispatch.activeAction,
          onConfirm: actionDispatch.confirm,
          onCancel: () => {
            actionDispatch.cancel()
          },
          isActive: true,
        }),
      ),
      React.createElement(Divider, { length: 40 }),
      renderDetailHintBar(),
    )
  }

  // --- Action result mode ---
  if (mode === 'action-result' && currentWf) {
    const actionLabel = actionDispatch.activeAction?.label ?? 'Action'
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      renderBreadcrumbs(` / ${currentWf.name} / Result`),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Pane,
        { title: 'Action Result', marginY: 0 },
        React.createElement(ActionStatus, {
          state: actionDispatch.state,
          label: sanitizeTerminalText(actionLabel),
        }),
        actionDispatch.state.result?.data?.cliCommand
          ? React.createElement(
              Box,
              { flexDirection: 'row', marginTop: 1 },
              React.createElement(ThemedText, { colorTheme: 'muted' }, 'CLI: '),
              React.createElement(ThemedText, { colorTheme: 'accent' }, String(actionDispatch.state.result.data.cliCommand)),
            )
          : null,
      ),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc', 'Enter'], description: 'back to detail' }),
      ),
    )
  }

  // --- Detail mode ---
  if (mode === 'detail' && currentWf) {
    const wf = currentWf
    const riskCat = riskIconCategory(wf.risk)

    // Build available operations description based on trust level
    const isProtected = PROTECTED_TRUST_LEVELS.has(wf.trustLevel)
    const opsLine = isProtected
      ? 'Preview, Dry-run, Run (trust changes restricted)'
      : 'Preview, Dry-run, Run, Trust management'

    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      renderBreadcrumbs(` / ${wf.name}`),
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
          renderTrustInfo(wf),
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Risk: '),
            React.createElement(StatusIcon, { status: riskCat }),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, ` ${wf.risk}`),
          ),
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Phases: '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, String(wf.phases)),
          ),
          renderLastRunInfo(wf),
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'Operations: '),
            React.createElement(ThemedText, { colorTheme: 'info', dim: true }, opsLine),
          ),
        ),
      ),
      React.createElement(Divider, { length: 40 }),
      renderDetailHintBar(),
    )
  }

  // --- Gallery mode ---
  const galleryRows = items.map((wf, i) => {
    const isSelected = i === selectedIndex
    const pointer = isSelected ? '>' : ' '
    const trustCat = trustIconCategory(wf.trustLevel)

    return React.createElement(
      Box,
      {
        key: wf.name,
        flexDirection: 'column',
        onClick: () => {
          setSelectedIndex(i)
          setMode('detail')
          actionDispatch.reset()
        },
        onMouseEnter: () => setSelectedIndex(i),
      },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(ThemedText, { colorTheme: isSelected ? 'accent' : 'muted' }, pointer),
        React.createElement(Text, null, ' '),
        React.createElement(StatusIcon, { status: trustCat }),
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

  const summaryText = `${galleryModel.summary.total} workflows (${galleryModel.summary.yaml} YAML, ${galleryModel.summary.js} JS)`

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    renderBreadcrumbs(''),
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, ''),
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
