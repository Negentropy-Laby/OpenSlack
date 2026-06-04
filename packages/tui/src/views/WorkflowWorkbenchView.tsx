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
import {
  TuiActionCategory,
  TuiRiskLevel,
  TuiActionStatus,
} from '../actions/types.js'
import type { TuiAction, TuiActionResult } from '../actions/types.js'
import { sanitizeTerminalText } from '../sanitize.js'
import type { WorkflowGalleryViewModel, WorkflowGalleryItem, WorkflowStartPatternItem } from '../view-models/workflow-gallery.js'
import type { TuiActionHandlers } from './render-shell.js'

type ViewMode = 'gallery' | 'start-menu' | 'prompt-input' | 'pattern-start' | 'detail' | 'issues-menu' | 'action-result'

/** Trust levels ordered from least to most privileged. */
const TRUST_LEVELS = ['untrusted', 'trusted'] as const
const PROTECTED_TRUST_LEVELS = new Set(['core', 'builtin'])
const MAX_PROMPT_INPUT_LENGTH = 280

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

/** Determine the color theme key for a format badge. */
function formatColorTheme(format: string): 'accent' | 'info' | 'muted' {
  if (format === 'claude-ambient') return 'accent'
  if (format === 'openslack-native') return 'info'
  return 'muted'
}

/** Build contextual recommendations for a workflow. */
function getRecommendations(wf: WorkflowGalleryItem): string[] {
  const recs: string[] = []
  if (wf.trustLevel === 'untrusted') {
    recs.push('Trust this workflow or request a security review before running.')
  }
  const status = wf.lastRunStatus?.toLowerCase() ?? ''
  if (status.includes('paused') || status.includes('awaiting')) {
    recs.push('Visit the Approval Center to resolve pending confirmations.')
  }
  if (wf.risk === 'high') {
    recs.push('Consider a dry-run before executing this high-risk workflow.')
  }
  if (recs.length === 0) {
    recs.push('Preview the workflow or create an issue to track changes.')
  }
  return recs
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
  const { pop, push } = useNavigation()
  const [mode, setMode] = useState<ViewMode>('gallery')
  const [lastRunStatus] = useState<string | undefined>(undefined)

  const actionDispatch = useActionDispatch()

  const items = galleryModel.workflows
  const patterns = galleryModel.patterns ?? []
  const [selectedIndex, setSelectedIndex] = useClampedIndex(items.length)
  const currentWf = items[selectedIndex] as WorkflowGalleryItem | undefined
  const [patternIndex, setPatternIndex] = useClampedIndex(patterns.length)
  const currentPattern = patterns[patternIndex] as WorkflowStartPatternItem | undefined
  const [promptInput, setPromptInput] = useState('')
  const [resultReturnMode, setResultReturnMode] = useState<ViewMode>('gallery')

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

  const makeStartPromptAction = useCallback((prompt: string): TuiAction => ({
    id: 'workflow-start-prompt',
    category: TuiActionCategory.WorkflowPreview,
    risk: TuiRiskLevel.Low,
    label: 'Start workflow from prompt',
    description: 'Generate a safe dynamic workflow draft from the entered prompt.',
    requiresConfirmation: false,
    handler: async (): Promise<TuiActionResult> => {
      if (actionHandlers?.startWorkflowFromPrompt) {
        return actionHandlers.startWorkflowFromPrompt(prompt)
      }
      return {
        success: false,
        message: 'Workflow prompt start is not available in TUI.',
        data: { cliCommand: `openslack collaboration workflow start --prompt "${prompt}"` },
      }
    },
  }), [actionHandlers])

  const makeStartPatternAction = useCallback((pattern: WorkflowStartPatternItem): TuiAction => ({
    id: `workflow-start-pattern-${pattern.id}`,
    category: TuiActionCategory.WorkflowPreview,
    risk: TuiRiskLevel.Low,
    label: `Start pattern ${pattern.id}`,
    description: `Generate a safe workflow draft from pattern "${pattern.id}".`,
    requiresConfirmation: false,
    handler: async (): Promise<TuiActionResult> => {
      if (actionHandlers?.startWorkflowFromPattern) {
        return actionHandlers.startWorkflowFromPattern(pattern.id)
      }
      return {
        success: false,
        message: 'Workflow pattern start is not available in TUI.',
        data: { cliCommand: `openslack collaboration workflow start --pattern ${pattern.id}` },
      }
    },
  }), [actionHandlers])

  // --- Transition helpers ---

  const goToActionResult = useCallback((returnMode: ViewMode = currentWf ? 'detail' : 'gallery') => {
    setResultReturnMode(returnMode === 'action-result' ? 'gallery' : returnMode)
    setMode('action-result')
  }, [currentWf])

  const returnFromActionResult = useCallback(() => {
    actionDispatch.reset()
    setMode(resultReturnMode)
  }, [actionDispatch, resultReturnMode])

  // --- Input handler ---

  const isConfirming = actionDispatch.state.status === TuiActionStatus.Confirming
  const isExecuting = actionDispatch.state.status === TuiActionStatus.Executing
  const inputBlocked = isConfirming || isExecuting

  useInput((input, key) => {
    // Global back
    if (input === 'q' || key.escape) {
      if (mode === 'action-result') {
        returnFromActionResult()
        return
      }
      if (mode === 'start-menu' || mode === 'prompt-input' || mode === 'pattern-start') {
        setMode('gallery')
        return
      }
      if (mode === 'issues-menu') {
        setMode('detail')
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
      } else if (input === '1') {
        setMode('start-menu')
      } else if (input === '2') {
        push({ view: 'workflow-runs' })
      } else if (input === '3') {
        push({ view: 'approvals' })
      } else if (input === '4') {
        push({ view: 'workflow-runs' })
      } else if (input === '5') {
        const publishAction: TuiAction = currentWf && actionHandlers?.publishWorkflowAsIssue
          ? {
              id: `publish-issue-${currentWf.name}`,
              category: TuiActionCategory.WorkflowPreview,
              risk: TuiRiskLevel.Low,
              label: `Publish ${currentWf.name} to GitHub Issues`,
              description: `Create a GitHub proposal issue for workflow "${currentWf.name}".`,
              requiresConfirmation: false,
              handler: () => actionHandlers.publishWorkflowAsIssue!(currentWf.name),
            }
          : {
              id: 'publish-issue-unavailable',
              category: TuiActionCategory.WorkflowPreview,
              risk: TuiRiskLevel.Low,
              label: 'Publish workflow to GitHub Issues',
              description: 'A workflow selection and publish handler are required before publishing.',
              requiresConfirmation: false,
              handler: async () => ({
                success: false,
                message: currentWf
                  ? 'Publish is not available in this TUI session.'
                  : 'Select a workflow before publishing to GitHub Issues.',
                data: { cliCommand: 'openslack collaboration workflow publish <workflow-name>' },
              }),
            }
        actionDispatch.dispatch(publishAction)
        goToActionResult('gallery')
      }
      return
    }

    if (mode === 'start-menu') {
      if (input === 'p') {
        setPromptInput('')
        setMode('prompt-input')
        return
      }
      if (input === 't') {
        setMode('pattern-start')
        return
      }
      if (input === 's') {
        setMode('gallery')
        return
      }
    }

    if (mode === 'prompt-input' && !inputBlocked) {
      if (key.return) {
        const prompt = promptInput.trim()
        if (prompt) {
          actionDispatch.dispatch(makeStartPromptAction(prompt))
          goToActionResult('gallery')
        }
        return
      }
      if (key.backspace || key.delete) {
        setPromptInput(prev => prev.slice(0, -1))
        return
      }
      if (input && input.length > 0) {
        setPromptInput(prev => `${prev}${input}`.slice(0, MAX_PROMPT_INPUT_LENGTH))
      }
      return
    }

    if (mode === 'pattern-start' && !inputBlocked) {
      if (key.upArrow) {
        setPatternIndex(prev => (prev > 0 ? prev - 1 : patterns.length - 1))
      } else if (key.downArrow) {
        setPatternIndex(prev => (prev < patterns.length - 1 ? prev + 1 : 0))
      } else if (key.return && currentPattern) {
        actionDispatch.dispatch(makeStartPatternAction(currentPattern))
        goToActionResult('gallery')
      }
      return
    }

    // Detail mode actions
    if (mode === 'detail' && currentWf && !inputBlocked) {
      if (input === 'p') {
        actionDispatch.dispatch(makePreviewAction(currentWf))
        goToActionResult('detail')
        return
      }
      if (input === 'd') {
        actionDispatch.dispatch(makeDryRunAction(currentWf))
        goToActionResult('detail')
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
      if (input === 'i') {
        setMode('issues-menu')
        return
      }
      if (input === 'u' && actionHandlers?.publishWorkflowAsIssue) {
        actionDispatch.dispatch({
          id: `publish-issue-${currentWf.name}`,
          category: TuiActionCategory.WorkflowPreview,
          risk: TuiRiskLevel.Low,
          label: `Publish ${currentWf.name} as proposal issue`,
          description: `Create a GitHub proposal issue for workflow "${currentWf.name}".`,
          requiresConfirmation: false,
          handler: () => actionHandlers.publishWorkflowAsIssue!(currentWf.name),
        })
        goToActionResult('detail')
        return
      }
      if (input === 'v' && actionHandlers?.requestWorkflowReview) {
        actionDispatch.dispatch({
          id: `review-issue-${currentWf.name}`,
          category: TuiActionCategory.WorkflowPreview,
          risk: TuiRiskLevel.Low,
          label: `Request review for ${currentWf.name}`,
          description: `Create a security review issue for workflow "${currentWf.name}".`,
          requiresConfirmation: false,
          handler: () => actionHandlers.requestWorkflowReview!(currentWf.name),
        })
        goToActionResult('detail')
        return
      }
      if (input === 'm' && actionHandlers?.splitWorkflowIntoIssues) {
        actionDispatch.dispatch({
          id: `split-issue-${currentWf.name}`,
          category: TuiActionCategory.WorkflowPreview,
          risk: TuiRiskLevel.Low,
          label: `Split ${currentWf.name} into phase issues`,
          description: `Create a new parent issue and sub-issues for each phase of workflow "${currentWf.name}".`,
          requiresConfirmation: true,
          handler: () => actionHandlers.splitWorkflowIntoIssues!(currentWf.name),
        })
        return
      }
      if (input === 'l') {
        push({ view: 'workflow-lifecycle', params: { workflowName: currentWf.name } })
        return
      }
    }

    // Issues-menu mode actions
    if (mode === 'issues-menu' && currentWf && !inputBlocked) {
      if (input === 'p' && actionHandlers?.publishWorkflowAsIssue) {
        actionDispatch.dispatch({
          id: `publish-issue-${currentWf.name}`,
          category: TuiActionCategory.WorkflowPreview,
          risk: TuiRiskLevel.Low,
          label: `Publish ${currentWf.name} as proposal issue`,
          description: `Create a GitHub proposal issue for workflow "${currentWf.name}".`,
          requiresConfirmation: false,
          handler: () => actionHandlers.publishWorkflowAsIssue!(currentWf.name),
        })
        goToActionResult('detail')
        return
      }
      if (input === 'r' && actionHandlers?.requestWorkflowReview) {
        actionDispatch.dispatch({
          id: `review-issue-${currentWf.name}`,
          category: TuiActionCategory.WorkflowPreview,
          risk: TuiRiskLevel.Low,
          label: `Request review for ${currentWf.name}`,
          description: `Create a security review issue for workflow "${currentWf.name}".`,
          requiresConfirmation: false,
          handler: () => actionHandlers.requestWorkflowReview!(currentWf.name),
        })
        goToActionResult('detail')
        return
      }
      if (input === 's' && actionHandlers?.splitWorkflowIntoIssues) {
        actionDispatch.dispatch({
          id: `split-issue-${currentWf.name}`,
          category: TuiActionCategory.WorkflowPreview,
          risk: TuiRiskLevel.Low,
          label: `Split ${currentWf.name} into phase issues`,
          description: `Create a new parent issue and sub-issues for each phase of workflow "${currentWf.name}".`,
          requiresConfirmation: true,
          handler: () => actionHandlers.splitWorkflowIntoIssues!(currentWf.name),
        })
        return
      }
      if (input === 'b') {
        setMode('detail')
        return
      }
    }

    // Action-result mode: enter to return to detail
    if (mode === 'action-result') {
      if (key.return) {
        const terminal = actionDispatch.state.status === TuiActionStatus.Success || actionDispatch.state.status === TuiActionStatus.Error
        if (terminal) {
          returnFromActionResult()
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
      React.createElement(KeyboardShortcutHint, { keys: ['u'], description: 'Publish' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['v'], description: 'Review' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['m'], description: 'Split' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['l'], description: 'Lifecycle' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['i'], description: 'More issues' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Back' }),
    )

  const renderGalleryHintBar = () =>
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['1'], description: 'Start' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['2'], description: 'Watch' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['3'], description: 'Approvals' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['4'], description: 'Save/share' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['5'], description: 'Publish' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'inspect saved' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    )

  const renderStartHintBar = () =>
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['p'], description: 'Prompt draft' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['t'], description: 'Pattern' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['s'], description: 'Saved workflow' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Back' }),
    )

  const renderPromptHintBar = () =>
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'Generate draft' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Backspace'], description: 'edit' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Back' }),
    )

  const renderPatternHintBar = () =>
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['Up/Down'], description: 'choose pattern' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'Generate draft' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'Back' }),
    )

  const renderActionResultHintBar = () =>
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc', 'Enter'], description: 'back' }),
    )

  const renderIssuesMenuHintBar = () =>
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(KeyboardShortcutHint, { keys: ['p'], description: 'Publish' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['r'], description: 'Review' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['s'], description: 'Split' }),
      React.createElement(Text, null, '  '),
      React.createElement(KeyboardShortcutHint, { keys: ['b'], description: 'Back' }),
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

  // --- Confirmation overlay for run / trust / issue split actions ---
  if (actionDispatch.activeAction && isConfirming) {
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      renderBreadcrumbs(currentWf ? ` / ${currentWf.name}` : ''),
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
      currentWf ? renderDetailHintBar() : renderGalleryHintBar(),
    )
  }

  // --- Workflow start menu ---
  if (mode === 'start-menu') {
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      renderBreadcrumbs(' / Start'),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Pane,
        { title: 'Start A Workflow', marginY: 0 },
        React.createElement(Box, { flexDirection: 'column' },
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'accent' }, '[p] '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, 'Prompt draft'),
            React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '  generate a safe draft from a task prompt'),
          ),
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'accent' }, '[t] '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, 'Pattern start'),
            React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '  choose a Dynamic Workflow pattern'),
          ),
          React.createElement(Box, { flexDirection: 'row' },
            React.createElement(ThemedText, { colorTheme: 'accent' }, '[s] '),
            React.createElement(ThemedText, { colorTheme: 'foreground' }, 'Saved workflow'),
            React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '  preview, dry-run, or run a discovered workflow'),
          ),
        ),
      ),
      React.createElement(Divider, { length: 40 }),
      renderStartHintBar(),
    )
  }

  // --- Prompt start mode ---
  if (mode === 'prompt-input') {
    const displayPrompt = promptInput.length > 0 ? promptInput : 'type a workflow task prompt'
    const isAtPromptLimit = promptInput.length >= MAX_PROMPT_INPUT_LENGTH
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      renderBreadcrumbs(' / Start / Prompt'),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Pane,
        { title: 'Prompt Draft', marginY: 0 },
        React.createElement(Box, { flexDirection: 'column' },
          React.createElement(ThemedText, { colorTheme: promptInput.length > 0 ? 'foreground' : 'muted' }, displayPrompt),
          React.createElement(ThemedText, { colorTheme: isAtPromptLimit ? 'warning' : 'muted', dim: !isAtPromptLimit }, `Prompt length: ${promptInput.length}/${MAX_PROMPT_INPUT_LENGTH}`),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, 'Creates a draft in .openslack/workflows/drafts/ using workflow start semantics.'),
        ),
      ),
      React.createElement(Divider, { length: 40 }),
      renderPromptHintBar(),
    )
  }

  // --- Pattern start mode ---
  if (mode === 'pattern-start') {
    const patternRows = patterns.map((pattern, i) => {
      const isSelected = i === patternIndex
      return React.createElement(
        Box,
        { key: pattern.id, flexDirection: 'column' },
        React.createElement(Box, { flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: isSelected ? 'accent' : 'muted' }, isSelected ? '>' : ' '),
          React.createElement(Text, null, ' '),
          React.createElement(ThemedText, { colorTheme: isSelected ? 'accent' : 'foreground', bold: isSelected }, pattern.id),
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, `  ${pattern.name}`),
        ),
        React.createElement(Box, { marginLeft: 3 },
          React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, pattern.description),
        ),
      )
    })

    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      renderBreadcrumbs(' / Start / Pattern'),
      React.createElement(Divider, { length: 40 }),
      patterns.length > 0
        ? React.createElement(Pane, { title: 'Pattern Start', marginY: 0 },
            React.createElement(Box, { flexDirection: 'column' }, ...patternRows),
          )
        : React.createElement(Pane, { title: 'Pattern Start', marginY: 0 },
            React.createElement(ThemedText, { colorTheme: 'muted' }, 'No Dynamic Workflow patterns discovered.'),
          ),
      React.createElement(Divider, { length: 40 }),
      renderPatternHintBar(),
    )
  }

  // --- Issues menu mode ---
  if (mode === 'issues-menu' && currentWf) {
    const wf = currentWf
    const hasPublish = !!actionHandlers?.publishWorkflowAsIssue
    const hasReview = !!actionHandlers?.requestWorkflowReview
    const hasSplit = !!actionHandlers?.splitWorkflowIntoIssues

    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      renderBreadcrumbs(` / ${wf.name} / Issues`),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Pane,
        { title: 'Workflow Issues', marginY: 0 },
        React.createElement(Box, { flexDirection: 'column' },
          hasPublish
            ? React.createElement(Box, { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'accent' }, '[p] '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, 'Publish as proposal issue'),
              )
            : React.createElement(Box, { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '[p] Publish (unavailable)'),
              ),
          hasReview
            ? React.createElement(Box, { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'accent' }, '[r] '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, 'Request security review'),
              )
            : React.createElement(Box, { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '[r] Review request (unavailable)'),
              ),
          hasSplit
            ? React.createElement(Box, { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'accent' }, '[s] '),
                React.createElement(ThemedText, { colorTheme: 'foreground' }, 'Split into phase issues'),
              )
            : React.createElement(Box, { flexDirection: 'row' },
                React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '[s] Split (unavailable)'),
              ),
        ),
      ),
      React.createElement(Divider, { length: 40 }),
      renderIssuesMenuHintBar(),
    )
  }

  // --- Action result mode ---
  if (mode === 'action-result') {
    const actionLabel = actionDispatch.activeAction?.label ?? 'Action'
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      renderBreadcrumbs(currentWf ? ` / ${currentWf.name} / Result` : ' / Result'),
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
      renderActionResultHintBar(),
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
            React.createElement(ThemedText, { colorTheme: formatColorTheme(wf.format) }, wf.format.toUpperCase()),
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
      React.createElement(
        Pane,
        { title: 'Publish Actions', marginY: 0 },
        React.createElement(Box, { flexDirection: 'column' },
          React.createElement(ThemedText, { colorTheme: actionHandlers?.publishWorkflowAsIssue ? 'foreground' : 'muted' }, '[u] Publish workflow to GitHub Issues'),
          React.createElement(ThemedText, { colorTheme: actionHandlers?.requestWorkflowReview ? 'foreground' : 'muted' }, '[v] Request workflow review'),
          React.createElement(ThemedText, { colorTheme: actionHandlers?.splitWorkflowIntoIssues ? 'foreground' : 'muted' }, '[m] Split workflow phases into issues'),
        ),
      ),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Pane,
        { title: 'Recommended Next', marginY: 0 },
        React.createElement(Box, { flexDirection: 'column' },
          ...getRecommendations(wf).map((rec, idx) =>
            React.createElement(Box, { key: `rec-${idx}`, flexDirection: 'row' },
              React.createElement(ThemedText, { colorTheme: 'accent' }, '  '),
              React.createElement(ThemedText, { colorTheme: 'foreground' }, rec),
            ),
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
        React.createElement(ThemedText, { colorTheme: formatColorTheme(wf.format), dim: true }, wf.format.toUpperCase()),
      ),
      React.createElement(
        Box,
        { marginLeft: 3 },
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, wf.description),
      ),
    )
  })

  const summaryText = `${galleryModel.summary.total} workflows (${galleryModel.summary.yaml} YAML, ${galleryModel.summary.js} JS)`

  const workflowHomeActions = [
    { key: '1', label: 'Start', detail: 'Generate from prompt, choose pattern, or open a saved workflow' },
    { key: '2', label: 'Watch', detail: 'Open running and paused workflow runs' },
    { key: '3', label: 'Approve', detail: 'Resolve workflow side effects and budget pauses' },
    { key: '4', label: 'Reuse', detail: 'Save, export, or share workflow outputs' },
    { key: '5', label: 'Publish', detail: 'Push workflow lifecycle to GitHub Issues' },
  ]

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
    React.createElement(Pane, { title: 'Dynamic Workflows', marginY: 0 },
      React.createElement(Box, { flexDirection: 'column' },
        ...workflowHomeActions.map((action) =>
          React.createElement(Box, { key: action.key, flexDirection: 'column' },
            React.createElement(Box, { flexDirection: 'row' },
              React.createElement(ThemedText, { colorTheme: 'accent' }, `[${action.key}] `),
              React.createElement(ThemedText, { colorTheme: 'foreground' }, action.label),
            ),
            React.createElement(Box, { marginLeft: 4 },
              React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, action.detail),
            ),
          ),
        ),
      ),
    ),
    React.createElement(Divider, { length: 40 }),
    items.length > 0
      ? React.createElement(Pane, { title: 'Workflow Gallery', marginY: 0 },
          React.createElement(Box, { flexDirection: 'column' }, ...galleryRows),
        )
      : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No workflows discovered.'),
    React.createElement(Divider, { length: 40 }),
    renderGalleryHintBar(),
  )
}
