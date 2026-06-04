import React from 'react'
import { renderTui } from '../render.js'
import ShellView from './ShellView.js'
import type { DashboardViewModel } from '../view-models/dashboard.js'
import type { PrQueueViewModel } from '../view-models/pr-queue.js'
import type { StatusViewModel } from '../view-models/status.js'
import type { WorkflowGalleryViewModel } from '../view-models/workflow-gallery.js'
import type { ApprovalCenterViewModel } from '../view-models/approval-center.js'
import type { DigestViewModel } from '../view-models/digest.js'
import type { HandoffListViewModel } from '../view-models/handoff.js'
import type { DecisionListViewModel } from '../view-models/decision.js'
import type { WorkflowLifecycleViewModel } from '../view-models/workflow-lifecycle.js'
import type { ProfileViewModel } from '../view-models/profile.js'
import type { AgentRuntimeDiagnosticsViewModel } from '../view-models/agent-runtime.js'
import type { AgentConversationThread, AgentConversationMessage } from '@openslack/collaboration'
import type { WorkflowRunControlAction, WorkflowRunControlTarget } from '@openslack/workflows'
import type { WorkflowRunProgressItem } from '../view-models/workflow-runs.js'

export type { WorkflowRunControlAction, WorkflowRunControlTarget } from '@openslack/workflows'

export interface WorkflowLifecycleBaseData {
  workflowHash: string
  trustLevel: string
  risk: string
  sourcePath: string
  currentRun?: { runId: string; status: string; startedAt: string }
}
import type { TuiActionResult } from '../actions/types.js'
export type WorkflowSaveTarget = 'project' | 'user' | 'claude-project'

export type WorkflowLifecycleLoader = (
  workflowName: string,
  baseData?: WorkflowLifecycleBaseData,
) => Promise<WorkflowLifecycleViewModel | null>

export interface ApprovalExecutionParams {
  id: string
  category: 'plan' | 'merge-request' | 'workflow-effect' | 'profile-sync' | 'github-review'
  title: string
  planId?: string
  prNumber?: number
  workflowName?: string
  profileSyncAction?: string
}

export interface ProfileActionHandlers {
  checkProfileSync: () => Promise<TuiActionResult>
  previewProfileSync: () => Promise<TuiActionResult>
  dryRunProfileSync: () => Promise<TuiActionResult>
  createProfileSyncPR: () => Promise<TuiActionResult>
  openProfileSyncPR: (prUrl: string) => Promise<TuiActionResult>
  createProfileSyncFailureIssue: (error: string) => Promise<TuiActionResult>
}

export interface TuiActionHandlers {
  executeApproval: (params: ApprovalExecutionParams, isApprove: boolean) => Promise<TuiActionResult>
  executeTrustChange: (workflowName: string, fromLevel: string, toLevel: string) => Promise<TuiActionResult>
  executeWorkflowRun: (workflowName: string, mode: 'preview' | 'dry-run' | 'run') => Promise<TuiActionResult>
  startWorkflowFromPrompt?: (prompt: string) => Promise<TuiActionResult>
  startWorkflowFromPattern?: (patternId: string) => Promise<TuiActionResult>
  controlWorkflowRun?: (runId: string, action: WorkflowRunControlAction, target?: WorkflowRunControlTarget) => Promise<TuiActionResult>
  saveWorkflowRunScript?: (runId: string, target?: WorkflowSaveTarget) => Promise<TuiActionResult>
  publishWorkflowAsIssue?: (workflowName: string) => Promise<TuiActionResult>
  requestWorkflowReview?: (workflowName: string) => Promise<TuiActionResult>
  splitWorkflowIntoIssues?: (workflowName: string, parentIssue: number) => Promise<TuiActionResult>
  openWorkflowLifecycle?: (workflowName: string) => Promise<TuiActionResult>
  finalizeWorkflowPr?: (workflowName: string, prNumber: number) => Promise<TuiActionResult>
  profileSync?: ProfileActionHandlers
}

export interface ShellViewData {
  rootDir?: string
  dashboard?: DashboardViewModel
  prQueue?: PrQueueViewModel
  status?: StatusViewModel
  workflowGallery?: WorkflowGalleryViewModel
  approvals?: ApprovalCenterViewModel
  digest?: DigestViewModel
  handoffs?: HandoffListViewModel
  decisions?: DecisionListViewModel
  workflowLifecycle?: WorkflowLifecycleViewModel
  workflowLifecycleBase?: Record<string, WorkflowLifecycleBaseData>
  workflowLifecycleLoader?: WorkflowLifecycleLoader
  workflowRuns?: import('../view-models/workflow-runs.js').WorkflowRunProgressViewModel
  workflowRunProgress?: WorkflowRunProgressItem[]
  profile?: ProfileViewModel
  agentRuntime?: AgentRuntimeDiagnosticsViewModel
  conversations?: {
    threads: AgentConversationThread[]
    messages: Record<string, AgentConversationMessage[]>
  }
  actionHandlers?: TuiActionHandlers
}

export async function renderShellTui(data?: ShellViewData): Promise<void> {
  const { unmount } = await renderTui(
    React.createElement(ShellView, { data }),
  )
}
