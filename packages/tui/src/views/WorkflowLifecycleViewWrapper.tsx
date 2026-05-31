import React, { useState, useEffect } from 'react'
import Box from '../ink/components/Box.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import WorkflowLifecycleView from './WorkflowLifecycleView.js'
import { mapWorkflowLifecycleToViewModel } from '../view-models/workflow-lifecycle.js'
import type { WorkflowLifecycleViewModel } from '../view-models/workflow-lifecycle.js'
import type { TuiActionHandlers, WorkflowLifecycleLoader } from './render-shell.js'

export type WorkflowLifecycleViewWrapperProps = {
  workflowName: string
  baseData?: {
    workflowHash?: string
    trustLevel?: string
    risk?: string
    sourcePath?: string
    currentRun?: { runId: string; status: string; startedAt: string }
  }
  loadLifecycle?: WorkflowLifecycleLoader
  actionHandlers?: TuiActionHandlers
  onBack?: () => void
}

export default function WorkflowLifecycleViewWrapper({
  workflowName,
  baseData,
  loadLifecycle,
  actionHandlers,
  onBack,
}: WorkflowLifecycleViewWrapperProps): React.JSX.Element {
  const [model, setModel] = useState<WorkflowLifecycleViewModel | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const normalizedBaseData = {
          workflowHash: baseData?.workflowHash ?? '',
          trustLevel: baseData?.trustLevel ?? 'untrusted',
          risk: baseData?.risk ?? 'unknown',
          sourcePath: baseData?.sourcePath ?? '',
          currentRun: baseData?.currentRun,
        }
        const baseModel = mapWorkflowLifecycleToViewModel({
          workflowName,
          workflowHash: normalizedBaseData.workflowHash,
          trustLevel: normalizedBaseData.trustLevel,
          risk: normalizedBaseData.risk,
          sourcePath: normalizedBaseData.sourcePath,
          stages: [],
          phaseIssues: [],
          currentRun: normalizedBaseData.currentRun
            ? {
                runId: normalizedBaseData.currentRun.runId,
                status: normalizedBaseData.currentRun.status,
                startedAt: normalizedBaseData.currentRun.startedAt,
                phaseIndex: 0,
              }
            : undefined,
        })

        if (loadLifecycle) {
          try {
            const loadedModel = await loadLifecycle(workflowName, normalizedBaseData)
            if (!cancelled) {
              setModel(loadedModel ?? baseModel)
              setLoading(false)
            }
            return
          } catch {
            // Fall back to base model without external lifecycle data.
          }
        }

        if (!cancelled) {
          setModel(baseModel)
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
  }, [workflowName, baseData, loadLifecycle])

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
