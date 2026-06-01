import React, { useState } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useApp from '../ink/hooks/use-app.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import ListItem from '../design-system/ListItem.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import { sanitizeTerminalText } from '../sanitize.js'
import {
  sanitizeProfileActionResult,
  sanitizeProfileCheckGroups,
  type ProfileActionResult,
  type ProfileViewModel,
  type ProfileGuidedStep,
  type ProfileCheckGroup,
} from '../view-models/profile.js'

export type ProfileViewProps = {
  model: ProfileViewModel
  onBack?: () => void
  onAction?: (actionId: string) => Promise<{ success: boolean; message: string; data?: Record<string, unknown> } | void>
}

const DIFF_MAX_LINES = 30

function diffLineTheme(line: string): 'success' | 'error' | 'info' {
  if (line.startsWith('+')) return 'success'
  if (line.startsWith('-')) return 'error'
  if (line.startsWith('@@')) return 'info'
  return 'info'
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

function modeColor(mode: string): 'muted' | 'info' | 'warning' {
  if (mode === 'auto-pr') return 'warning'
  if (mode === 'watch') return 'info'
  return 'muted'
}

type StepDef = { key: ProfileGuidedStep; label: string; shortcut: string }

const GUIDED_STEPS: StepDef[] = [
  { key: 'check', label: 'Check', shortcut: 'c' },
  { key: 'preview', label: 'Preview', shortcut: 'p' },
  { key: 'create-pr', label: 'Create PR', shortcut: 'r' },
]

function stepIndex(step: ProfileGuidedStep | undefined): number {
  if (step === 'preview') return 1
  if (step === 'create-pr') return 2
  if (step === 'complete') return 3
  return 0
}

function renderGuidedStepBar(currentStep: ProfileGuidedStep | undefined): React.ReactNode {
  const current = stepIndex(currentStep)
  return React.createElement(
    Box,
    { flexDirection: 'column', marginY: 0 },
    React.createElement(
      Box,
      { flexDirection: 'row' },
      ...GUIDED_STEPS.map((st, i) => {
        const isComplete = current > i
        const isCurrent = current === i
        const icon = isComplete ? '>' : isCurrent ? '*' : ' '
        const color: 'success' | 'accent' | 'muted' = isComplete ? 'success' : isCurrent ? 'accent' : 'muted'
        const suffix = i < GUIDED_STEPS.length - 1 ? ' -> ' : ''
        return React.createElement(
          Box,
          { key: `step-${st.key}`, flexDirection: 'row' },
          React.createElement(ThemedText, { colorTheme: color, bold: isCurrent }, `${icon} ${i + 1}. ${st.label}`),
          React.createElement(Text, null, suffix),
        )
      }),
      current >= 3
        ? React.createElement(ThemedText, { colorTheme: 'success', bold: true }, ' Done')
        : null,
    ),
  )
}

export default function ProfileView({ model, onBack, onAction }: ProfileViewProps): React.JSX.Element {
  const { exit } = useApp()
  const [actionResult, setActionResult] = useState<ProfileActionResult | undefined>(() =>
    model.actionResult ? sanitizeProfileActionResult(model.actionResult) : undefined,
  )
  const [isRunning, setIsRunning] = useState(false)
  const [diffOutput, setDiffOutput] = useState<string | undefined>(() =>
    model.diffOutput ? sanitizeTerminalText(model.diffOutput) : undefined,
  )
  const [checkGroups, setCheckGroups] = useState<ProfileCheckGroup[] | undefined>(() =>
    sanitizeProfileCheckGroups(model.checkGroups),
  )
  const [guidedStep, setGuidedStep] = useState<ProfileGuidedStep | undefined>(model.guidedStep)
  const [diffScrollOffset, setDiffScrollOffset] = useState(0)

  // Whether the diff pane is visible (used to gate arrow-key scrolling)
  const diffVisible = diffOutput != null && actionResult?.actionId === 'preview' && actionResult?.success
  const diffLines = diffOutput ? diffOutput.split('\n') : []
  const diffLineCount = diffLines.length
  const diffIsLong = diffLineCount > DIFF_MAX_LINES

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      if (onBack) onBack()
      else exit()
      return
    }

    // 'b' key: go back one guided step
    if (input === 'b' && !isRunning) {
      if (guidedStep === 'create-pr') {
        setGuidedStep('preview')
        setDiffScrollOffset(0)
        return
      }
      if (guidedStep === 'preview') {
        setGuidedStep('check')
        setDiffScrollOffset(0)
        return
      }
    }

    // Arrow keys: scroll diff when diff pane is visible
    if (diffVisible && diffIsLong) {
      if (key.upArrow) {
        setDiffScrollOffset((prev) => Math.max(0, prev - DIFF_MAX_LINES))
        return
      }
      if (key.downArrow) {
        const maxOffset = Math.max(0, diffLineCount - DIFF_MAX_LINES)
        setDiffScrollOffset((prev) => Math.min(maxOffset, prev + DIFF_MAX_LINES))
        return
      }
    }

    const action = model.actions.find((a) => a.key === input)
    if (action && onAction && !isRunning) {
      setIsRunning(true)
      setActionResult({ actionId: action.id, success: true, message: 'Running...' })
      onAction(action.id)
        .then((result) => {
          if (result) {
            setActionResult(sanitizeProfileActionResult({ actionId: action.id, success: result.success, message: result.message }))
            if (action.id === 'check') {
              // Store check groups and advance step
              const groups = result.data?.checkGroups
              if (Array.isArray(groups)) setCheckGroups(sanitizeProfileCheckGroups(groups as ProfileCheckGroup[]))
              if (result.success) setGuidedStep('preview')
            } else if (action.id === 'preview' && result.success && result.data?.diff && typeof result.data.diff === 'string') {
              setDiffScrollOffset(0)
              setDiffOutput(sanitizeTerminalText(result.data.diff))
              setGuidedStep('create-pr')
            } else if (action.id === 'create-pr' && result.success) {
              setGuidedStep('complete')
            } else if (action.id !== 'preview') {
              setDiffOutput(undefined)
            }
          } else {
            setActionResult(undefined)
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          setActionResult(sanitizeProfileActionResult({ actionId: action.id, success: false, message: msg }))
        })
        .finally(() => {
          setIsRunning(false)
        })
    }
  })

  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    // Header
    React.createElement(
      Box,
      { flexDirection: 'row' },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `${model.title} - Mode: `),
      React.createElement(
        ThemedText,
        { colorTheme: modeColor(model.mode), bold: true },
        model.mode,
      ),
    ),
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

    // Guided 3-step flow indicator
    renderGuidedStepBar(guidedStep),
    React.createElement(Divider, { length: 50 }),

    // Check result groups (shown after check action)
    checkGroups && checkGroups.length > 0
      ? React.createElement(
          Pane,
          { title: 'Check Results', marginY: 0 },
          ...checkGroups.map((g, i) =>
            React.createElement(ListItem, {
              key: `check-${i}`,
              label: g.label,
              detail: g.detail,
              status: g.status === 'pass' ? 'pass' : g.status === 'fail' ? 'fail' : g.status === 'warn' ? 'warn' : 'info',
            }),
          ),
        )
      : null,

    // Failure panel (shown when sync failed)
    model.syncStatus === 'failed' && model.failureDetails
      ? React.createElement(
          Pane,
          { title: 'Sync Failed', borderTheme: 'error', marginY: 0 },
          React.createElement(ListItem, {
            label: 'Reason',
            detail: model.failureDetails.reason,
            status: 'fail',
          }),
          React.createElement(ListItem, {
            label: 'Next Action',
            detail: model.failureDetails.nextAction,
            status: 'warn',
          }),
          React.createElement(
            Box,
            { marginTop: 1 },
            React.createElement(KeyboardShortcutHint, { keys: ['i'], description: 'Create failure issue' }),
          ),
        )
      : null,

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

    // Sync Details pane (between Sync Status and Validation)
    model.syncDetails
      ? React.createElement(
          Pane,
          { title: 'Sync Details', marginY: 0 },
          model.syncDetails.sourceCommit
            ? React.createElement(ListItem, {
                label: 'Source',
                detail: `${model.syncDetails.sourceCommit}${model.syncDetails.sourceDate ? ` (${model.syncDetails.sourceDate})` : ''}`,
                status: 'info',
              })
            : null,
          model.syncDetails.targetHash
            ? React.createElement(ListItem, {
                label: 'Target hash',
                detail: model.syncDetails.targetHash,
                status: 'info',
              })
            : null,
          model.syncDetails.pendingPR
            ? React.createElement(ListItem, {
                label: 'Pending PR',
                detail: `#${model.syncDetails.pendingPR.number} (${model.syncDetails.pendingPR.status})`,
                status: 'warn',
              })
            : null,
          model.syncDetails.lastSync
            ? React.createElement(ListItem, {
                label: 'Last sync',
                detail: `${model.syncDetails.lastSync.timestamp} (${model.syncDetails.lastSync.result})`,
                status: model.syncDetails.lastSync.result === 'success' ? 'pass' : 'fail',
              })
            : null,
          React.createElement(ListItem, {
            label: 'Mode',
            detail: model.syncDetails.mode,
            status: model.syncDetails.mode === 'auto-pr' ? 'warn' : model.syncDetails.mode === 'watch' ? 'info' : 'info',
          }),
        )
      : null,

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
    actionResult
      ? React.createElement(
          Pane,
          { title: 'Action Result', marginY: 0 },
          React.createElement(ListItem, {
            label: actionResult.actionId,
            detail: actionResult.message,
            status: actionResult.success ? 'pass' : 'fail',
          }),
        )
      : null,

    // Diff Preview pane (shown after successful preview action)
    diffVisible
      ? React.createElement(
          Pane,
          { title: 'Diff Preview', marginY: 0 },
          ...diffLines.slice(diffScrollOffset, diffScrollOffset + DIFF_MAX_LINES).map((line, i) =>
            React.createElement(
              Box,
              { key: `diff-${diffScrollOffset + i}`, flexDirection: 'row' },
              React.createElement(ThemedText, { colorTheme: diffLineTheme(line) }, line),
            )
          ),
          diffIsLong
            ? React.createElement(
                Box,
                { marginTop: 1, flexDirection: 'row' },
                React.createElement(
                  ThemedText,
                  { colorTheme: 'muted', dim: true },
                  `Lines ${diffScrollOffset + 1}-${Math.min(diffScrollOffset + DIFF_MAX_LINES, diffLineCount)} of ${diffLineCount}`,
                ),
              )
            : null,
        )
      : null,

    isRunning
      ? React.createElement(
          Box,
          { marginY: 0 },
          React.createElement(ThemedText, { colorTheme: 'muted' }, 'Processing...'),
        )
      : null,

    // Actions: primary guided steps + secondary
    React.createElement(
      Pane,
      { title: 'Actions', marginY: 0 },
      // Primary actions (guided flow)
      ...model.actions.filter(a => ['check', 'preview', 'create-pr'].includes(a.id)).map((a) => {
        const isRecommended = (
          (guidedStep === 'check' && a.id === 'check') ||
          (guidedStep === 'preview' && (a.id === 'preview' || a.id === 'check')) ||
          (guidedStep === 'create-pr' && a.id === 'create-pr')
        )
        return React.createElement(ListItem, {
          key: `action-${a.id}`,
          label: `${a.key} — ${a.label}${isRecommended ? ' *' : ''}`,
          detail: a.description,
          status: a.risk === 'high' ? 'fail' : a.risk === 'medium' ? 'warn' : isRecommended ? 'pass' : 'info',
        })
      }),
      // Divider between primary and secondary
      React.createElement(Box, { key: 'action-divider', marginTop: 0, marginBottom: 0 },
        React.createElement(ThemedText, { colorTheme: 'muted', dim: true }, '── secondary ──'),
      ),
      // Secondary actions
      ...model.actions.filter(a => !['check', 'preview', 'create-pr'].includes(a.id)).map((a) =>
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
      guidedStep != null && guidedStep !== 'check' && guidedStep !== 'complete'
        ? React.createElement(KeyboardShortcutHint, { key: 'hint-back', keys: ['b'], description: 'back' })
        : null,
      React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
    ),
    diffVisible && diffIsLong
      ? React.createElement(
          Box,
          { flexDirection: 'row' },
          React.createElement(KeyboardShortcutHint, { keys: ['↑', '↓'], description: 'scroll diff' }),
        )
      : null,
  )
}
