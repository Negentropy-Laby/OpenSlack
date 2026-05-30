import React, { useState, useEffect } from 'react'
import Box from '../ink/components/Box.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import WorkflowLifecycleView from './WorkflowLifecycleView.js'
import { mapWorkflowLifecycleToViewModel } from '../view-models/workflow-lifecycle.js'
import type { WorkflowLifecycleViewModel } from '../view-models/workflow-lifecycle.js'
import type { TuiActionHandlers } from './render-shell.js'

export type WorkflowLifecycleViewWrapperProps = {
  workflowName: string
  baseData?: {
    workflowHash?: string
    trustLevel?: string
    risk?: string
    sourcePath?: string
    currentRun?: { runId: string; status: string; startedAt: string }
  }
  actionHandlers?: TuiActionHandlers
  onBack?: () => void
}

export default function WorkflowLifecycleViewWrapper({
  workflowName,
  baseData,
  actionHandlers,
  onBack,
}: WorkflowLifecycleViewWrapperProps): React.JSX.Element {
  const [model, setModel] = useState<WorkflowLifecycleViewModel | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        // Build model from pre-fetched local data.
        // GitHub-derived stages/phaseIssues are left empty for now;
        // a future enhancement can async-fetch them here.
        const lifecycleModel = mapWorkflowLifecycleToViewModel({
          workflowName,
          workflowHash: baseData?.workflowHash ?? '',
          trustLevel: baseData?.trustLevel ?? 'untrusted',
          risk: baseData?.risk ?? 'unknown',
          sourcePath: baseData?.sourcePath ?? '',
          stages: [],
          phaseIssues: [],
          currentRun: baseData?.currentRun
            ? {
                runId: baseData.currentRun.runId,
                status: baseData.currentRun.status,
                startedAt: baseData.currentRun.startedAt,
                phaseIndex: 0,
              }
            : undefined,
        })
        if (!cancelled) {
          setModel(lifecycleModel)
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [workflowName, baseData])

  if (loading) {
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `Workflow: ${workflowName}`),
      React.createElement(Divider, { length: 40 }),
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Loading lifecycle data...'),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
      ),
    )
  }

  if (!model) {
    return React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(ThemedText, { colorTheme: 'accent', bold: true }, `Workflow: ${workflowName}`),
      React.createElement(Divider, { length: 40 }),
      React.createElement(ThemedText, { colorTheme: 'muted' }, 'Lifecycle data unavailable.'),
      React.createElement(Divider, { length: 40 }),
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(KeyboardShortcutHint, { keys: ['q', 'Esc'], description: 'back' }),
      ),
    )
  }

  return React.createElement(WorkflowLifecycleView, { model, actionHandlers, onBack })
}
