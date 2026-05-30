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
        const baseModel = mapWorkflowLifecycleToViewModel({
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

        // Async-fetch GitHub-derived lifecycle data
        try {
          const { fetchWorkflowLifecycleIssues } = await import('@openslack/github')
          const gh = await fetchWorkflowLifecycleIssues(workflowName)

          const stages: import('../view-models/workflow-lifecycle.js').LifecycleStage[] = []

          if (gh.proposalIssue) {
            stages.push({
              name: 'proposal',
              label: 'Proposal',
              status: gh.proposalIssue.state === 'open' ? 'pending' : 'complete',
              icon: '\u{1F4DD}',
              issueNumber: gh.proposalIssue.number,
              issueUrl: gh.proposalIssue.url,
              detail: `Proposal issue #${gh.proposalIssue.number}`,
            })
          }

          if (gh.reviewIssue) {
            stages.push({
              name: 'review',
              label: 'Review',
              status: gh.reviewIssue.state === 'open' ? 'in-progress' : 'complete',
              icon: '\u{1F50D}',
              issueNumber: gh.reviewIssue.number,
              issueUrl: gh.reviewIssue.url,
              detail: `Review issue #${gh.reviewIssue.number}`,
            })
          }

          if (gh.splitIssue) {
            stages.push({
              name: 'split',
              label: 'Split',
              status: gh.splitIssue.state === 'open' ? 'pending' : 'complete',
              icon: '⚡',
              issueNumber: gh.splitIssue.number,
              issueUrl: gh.splitIssue.url,
              detail: `Split into ${gh.phaseIssues.length} phase${gh.phaseIssues.length === 1 ? '' : 's'}`,
            })
          }

          for (const pi of gh.phaseIssues) {
            stages.push({
              name: `phase-${pi.phase}`,
              label: `Phase: ${pi.phase}`,
              status: pi.state === 'open' ? (pi.blockedBy && pi.blockedBy.length > 0 ? 'blocked' : 'in-progress') : 'complete',
              icon: pi.blockedBy && pi.blockedBy.length > 0 ? '\u{1F512}' : '✓',
              issueNumber: pi.number,
              issueUrl: pi.url,
              detail: pi.blockedBy && pi.blockedBy.length > 0
                ? `Blocked by #${pi.blockedBy.join(', #')}`
                : `Phase issue #${pi.number}`,
            })
          }

          if (gh.runIssues.length > 0) {
            const latest = gh.runIssues[0]
            stages.push({
              name: 'run',
              label: 'Run Audit',
              status: latest.status === 'completed' ? 'complete' : latest.status === 'failed' ? 'failed' : 'in-progress',
              icon: '\u{1F3C3}',
              issueNumber: latest.number,
              issueUrl: latest.url,
              detail: `Run ${latest.runId} — ${latest.status}`,
            })
          }

          if (gh.improvementIssues.length > 0) {
            stages.push({
              name: 'improvement',
              label: 'Improvements',
              status: gh.improvementIssues.every(i => i.state === 'closed') ? 'complete' : 'in-progress',
              icon: '\u{1F4A1}',
              detail: `${gh.improvementIssues.length} improvement issue${gh.improvementIssues.length === 1 ? '' : 's'}`,
            })
          }

          if (gh.linkedPRs.length > 0) {
            const pr = gh.linkedPRs[0]
            stages.push({
              name: 'pr',
              label: 'Pull Request',
              status: pr.state === 'closed' ? 'complete' : pr.state === 'merged' ? 'complete' : 'in-progress',
              icon: '\u{1F4E6}',
              detail: `PR #${pr.number}`,
            })
          }

          const phaseIssues: import('../view-models/workflow-lifecycle.js').PhaseIssueItem[] = gh.phaseIssues.map(pi => ({
            phase: pi.phase,
            issueNumber: pi.number,
            status: pi.state,
            blockedBy: pi.blockedBy?.map(String),
          }))

          // Determine next action from lifecycle state
          let nextAction: string | undefined
          if (!gh.proposalIssue) {
            nextAction = 'Publish proposal issue (p in Issues menu)'
          } else if (gh.proposalIssue.state === 'open') {
            nextAction = 'Awaiting proposal approval'
          } else if (!gh.reviewIssue) {
            nextAction = 'Request security review (r in Issues menu)'
          } else if (gh.reviewIssue.state === 'open') {
            nextAction = 'Security review in progress'
          } else if (!gh.splitIssue && gh.phaseIssues.length === 0) {
            nextAction = 'Split into phase issues (s in Issues menu)'
          } else if (gh.phaseIssues.some(p => p.state === 'open')) {
            nextAction = `Complete ${gh.phaseIssues.filter(p => p.state === 'open').length} open phase issue(s)`
          } else if (gh.runIssues.length === 0) {
            nextAction = 'Run workflow audit (r to run)'
          } else if (gh.linkedPRs.length === 0) {
            nextAction = 'Create PR and finalize'
          } else if (gh.linkedPRs[0].state === 'open') {
            nextAction = 'Awaiting PR merge'
          } else {
            nextAction = 'Lifecycle complete'
          }

          const enrichedModel = mapWorkflowLifecycleToViewModel({
            workflowName,
            workflowHash: baseData?.workflowHash ?? '',
            trustLevel: baseData?.trustLevel ?? 'untrusted',
            risk: baseData?.risk ?? 'unknown',
            sourcePath: baseData?.sourcePath ?? '',
            stages,
            phaseIssues,
            currentRun: baseData?.currentRun
              ? {
                  runId: baseData.currentRun.runId,
                  status: baseData.currentRun.status,
                  startedAt: baseData.currentRun.startedAt,
                  phaseIndex: 0,
                }
              : undefined,
            prNumber: gh.linkedPRs[0]?.number,
            prStatus: gh.linkedPRs[0]?.state,
            nextAction,
            subIssueMode: gh.subIssueMode,
            dependencyMode: gh.dependencyMode,
          })

          if (!cancelled) {
            setModel(enrichedModel)
            setLoading(false)
          }
        } catch {
          // Fall back to base model without GitHub data
          if (!cancelled) {
            setModel(baseModel)
            setLoading(false)
          }
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
