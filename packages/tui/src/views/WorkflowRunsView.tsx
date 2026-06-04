import React, { useCallback, useState } from 'react'
import Box from '../ink/components/Box.js'
import Text from '../ink/components/Text.js'
import useInput from '../ink/hooks/use-input.js'
import Pane from '../design-system/Pane.js'
import ThemedText from '../design-system/ThemedText.js'
import Divider from '../design-system/Divider.js'
import StatusIcon from '../design-system/StatusIcon.js'
import KeyboardShortcutHint from '../design-system/KeyboardShortcutHint.js'
import { useClampedIndex } from '../hooks/use-clamped-index.js'
import { useNavigation } from '../navigation/context.js'
import type {
  WorkflowAgentProgressItem,
  WorkflowPhaseProgressItem,
  WorkflowRunProgressItem,
  WorkflowRunProgressViewModel,
} from '../view-models/workflow-runs.js'
import type { TuiActionHandlers, WorkflowRunControlAction, WorkflowRunControlTarget } from './render-shell.js'

type ViewMode = 'runs' | 'phases' | 'agent'

export interface WorkflowRunsViewProps {
  model: WorkflowRunProgressViewModel
  actionHandlers?: TuiActionHandlers
  onBack?: () => void
}

function statusCategory(status: string): 'pass' | 'warn' | 'fail' | 'blocked' | 'info' {
  if (status === 'completed') return 'pass'
  if (status === 'failed' || status === 'cancelled') return 'fail'
  if (status === 'paused' || status === 'paused_waiting_approval') return 'blocked'
  if (status === 'running' || status === 'resuming') return 'info'
  return 'warn'
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return 'not recorded'
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function actionLabel(action: WorkflowRunControlAction): string {
  if (action === 'stopRun') return 'stop'
  if (action === 'saveScript') return 'save'
  return action
}

export default function WorkflowRunsView({ model, actionHandlers, onBack }: WorkflowRunsViewProps): React.JSX.Element {
  const { pop } = useNavigation()
  const [mode, setMode] = useState<ViewMode>('runs')
  const [message, setMessage] = useState<string | undefined>()
  const [runIndex, setRunIndex] = useClampedIndex(model.runs.length)
  const selectedRun = model.runs[runIndex] as WorkflowRunProgressItem | undefined
  const [phaseIndex, setPhaseIndex] = useClampedIndex(selectedRun?.phases.length ?? 0)
  const selectedPhase = selectedRun?.phases[phaseIndex] as WorkflowPhaseProgressItem | undefined
  const [agentIndex, setAgentIndex] = useClampedIndex(selectedPhase?.agents.length ?? 0)
  const selectedAgent = selectedPhase?.agents[agentIndex] as WorkflowAgentProgressItem | undefined

  const goBack = useCallback(() => {
    if (mode === 'agent') {
      setMode('phases')
      return
    }
    if (mode === 'phases') {
      setMode('runs')
      return
    }
    if (onBack) onBack()
    else pop()
  }, [mode, onBack, pop])

  const applyAction = useCallback(async (action: WorkflowRunControlAction) => {
    if (!selectedRun) return
    const target: WorkflowRunControlTarget | undefined = selectedAgent
      ? {
          runId: selectedRun.runId,
          phase: selectedAgent.phase,
          agentRunId: selectedAgent.agentRunId,
          agentId: selectedAgent.label,
        }
      : undefined
    if (action === 'saveScript' && actionHandlers?.saveWorkflowRunScript) {
      const result = await actionHandlers.saveWorkflowRunScript(selectedRun.runId)
      setMessage(result.message)
      return
    }
    if (actionHandlers?.controlWorkflowRun) {
      const result = await actionHandlers.controlWorkflowRun(selectedRun.runId, action, target)
      setMessage(result.message)
      return
    }
    const agentArg = target?.agentRunId ? ` --agent-run-id ${target.agentRunId}` : ''
    setMessage(`Use: openslack collaboration workflow runs control ${selectedRun.runId} --action ${action}${agentArg}`)
  }, [actionHandlers, selectedAgent, selectedRun])

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      goBack()
      return
    }
    if (mode === 'runs') {
      if (key.upArrow || input === 'k') setRunIndex(runIndex - 1)
      if (key.downArrow || input === 'j') setRunIndex(runIndex + 1)
      if (key.return && selectedRun) setMode('phases')
    } else if (mode === 'phases') {
      if (key.upArrow || input === 'k') setPhaseIndex(phaseIndex - 1)
      if (key.downArrow || input === 'j') setPhaseIndex(phaseIndex + 1)
      if (key.return && selectedPhase?.agents.length) setMode('agent')
    } else if (mode === 'agent') {
      if (key.upArrow || input === 'k') setAgentIndex(agentIndex - 1)
      if (key.downArrow || input === 'j') setAgentIndex(agentIndex + 1)
    }
    if (input === 'p') void applyAction('pause')
    if (input === 'r') void applyAction('resume')
    if (input === 'x') void applyAction('stopRun')
    if (input === 'a') void applyAction('stopAgent')
    if (input === 'R') void applyAction('restartAgent')
    if (input === 's') void applyAction('saveScript')
  })

  return React.createElement(
    Pane,
    { title: 'Dynamic Workflows / Runs', width: 100 },
    React.createElement(
      Box,
      { flexDirection: 'column', gap: 1 },
      React.createElement(ThemedText, { colorTheme: 'muted' }, `Runs ${model.summary.total} | running ${model.summary.running} | paused ${model.summary.paused} | failed ${model.summary.failed} | approvals ${model.summary.pendingApprovals}`),
      message ? React.createElement(ThemedText, { colorTheme: 'info' }, message) : null,
      React.createElement(Divider, null),
      mode === 'runs'
        ? React.createElement(RunList, { runs: model.runs, selectedIndex: runIndex })
        : mode === 'phases' && selectedRun
          ? React.createElement(PhaseList, { run: selectedRun, phases: selectedRun.phases, selectedIndex: phaseIndex })
          : selectedRun && selectedPhase && selectedAgent
            ? React.createElement(AgentDetail, { run: selectedRun, phase: selectedPhase, agent: selectedAgent })
            : React.createElement(ThemedText, { colorTheme: 'muted' }, 'No workflow run evidence recorded.'),
      React.createElement(Divider, null),
      React.createElement(Box, { gap: 2 },
        React.createElement(KeyboardShortcutHint, { keys: ['Enter'], description: 'open' }),
        React.createElement(KeyboardShortcutHint, { keys: ['p'], description: actionLabel('pause') }),
        React.createElement(KeyboardShortcutHint, { keys: ['r'], description: actionLabel('resume') }),
        React.createElement(KeyboardShortcutHint, { keys: ['x'], description: actionLabel('stopRun') }),
        React.createElement(KeyboardShortcutHint, { keys: ['a'], description: actionLabel('stopAgent') }),
        React.createElement(KeyboardShortcutHint, { keys: ['R'], description: actionLabel('restartAgent') }),
        React.createElement(KeyboardShortcutHint, { keys: ['s'], description: actionLabel('saveScript') }),
        React.createElement(KeyboardShortcutHint, { keys: ['q'], description: 'back' }),
      ),
    ),
  )
}

function RunList({ runs, selectedIndex }: { runs: WorkflowRunProgressItem[]; selectedIndex: number }): React.JSX.Element {
  if (runs.length === 0) return React.createElement(ThemedText, { colorTheme: 'muted' }, 'No workflow runs found.')
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...runs.map((run, index) => React.createElement(
      Box,
      { key: run.runId, gap: 1 },
      React.createElement(Text, null, index === selectedIndex ? '>' : ' '),
      React.createElement(StatusIcon, { status: statusCategory(run.status) }),
      React.createElement(ThemedText, { colorTheme: index === selectedIndex ? 'accent' : 'foreground' }, run.workflowName),
      React.createElement(ThemedText, { colorTheme: 'muted' }, run.runId),
      React.createElement(ThemedText, { colorTheme: 'muted' }, `${run.status} ${run.currentPhase ?? 'no phase'} ${run.budget.tokensUsed}/${run.budget.tokenBudget ?? 'unlimited'} tokens`),
    )),
  )
}

function PhaseList({ run, phases, selectedIndex }: { run: WorkflowRunProgressItem; phases: WorkflowPhaseProgressItem[]; selectedIndex: number }): React.JSX.Element {
  return React.createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    React.createElement(ThemedText, { colorTheme: 'info' }, `${run.workflowName} | ${run.status} | elapsed ${duration(run.elapsedMs)}`),
    ...phases.map((phase, index) => React.createElement(
      Box,
      { key: phase.phase, gap: 1 },
      React.createElement(Text, null, index === selectedIndex ? '>' : ' '),
      React.createElement(StatusIcon, { status: statusCategory(phase.status) }),
      React.createElement(ThemedText, { colorTheme: index === selectedIndex ? 'accent' : 'foreground' }, phase.phase),
      React.createElement(ThemedText, { colorTheme: 'muted' }, `agents ${phase.agentCount} | cached ${phase.cachedCount} | live ${phase.liveCount} | failed ${phase.failedCount} | tokens ${phase.tokenTotal}`),
    )),
  )
}

function AgentDetail({ run, phase, agent }: { run: WorkflowRunProgressItem; phase: WorkflowPhaseProgressItem; agent: WorkflowAgentProgressItem }): React.JSX.Element {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(ThemedText, { colorTheme: 'info' }, `${run.workflowName} / ${phase.phase}`),
    React.createElement(ThemedText, { colorTheme: 'foreground' }, `${agent.label}: ${agent.status}`),
    React.createElement(ThemedText, { colorTheme: 'muted' }, `model ${agent.model ?? 'not recorded'} | runtime ${agent.runtimeProvider ?? 'not recorded'} | isolation ${agent.isolation ?? 'not recorded'} | tokens ${agent.tokensUsed}`),
    React.createElement(ThemedText, { colorTheme: 'muted' }, `worktree ${agent.worktreePath ?? 'not recorded'}`),
    React.createElement(ThemedText, { colorTheme: 'muted' }, `terminal ${agent.terminalReason ?? 'not recorded'}`),
    React.createElement(ThemedText, { colorTheme: 'foreground' }, `prompt: ${agent.promptSummary}`),
    agent.resultSummary ? React.createElement(ThemedText, { colorTheme: 'foreground' }, `result: ${agent.resultSummary}`) : null,
    agent.transcriptPath ? React.createElement(ThemedText, { colorTheme: 'muted' }, `transcript: ${agent.transcriptPath}`) : null,
    React.createElement(ThemedText, { colorTheme: 'muted' }, 'Agent stop uses a live runtime handle when available; restart records replay intent unless replay input is available.'),
    ...agent.recentTools.map((tool) => React.createElement(ThemedText, { key: `${tool.type}-${tool.name}-${tool.timestamp ?? ''}`, colorTheme: 'muted' }, `tool ${tool.name}: ${tool.summary}`)),
  )
}
