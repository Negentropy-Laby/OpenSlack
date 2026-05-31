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

export interface WorkflowLifecycleBaseData {
  workflowHash: string
  trustLevel: string
  risk: string
  sourcePath: string
  currentRun?: { runId: string; status: string; startedAt: string }
}
import type { TuiActionResult } from '../actions/types.js'

export type WorkflowLifecycleLoader = (
  workflowName: string,
  baseData?: WorkflowLifecycleBaseData,
) => Promise<WorkflowLifecycleViewModel | null>

export interface ApprovalExecutionParams {
  id: string
  category: 'plan' | 'merge-request' | 'workflow-effect' | 'github-review'
  title: string
  planId?: string
  prNumber?: number
  workflowName?: string
}

export interface TuiActionHandlers {
  executeApproval: (params: ApprovalExecutionParams, isApprove: boolean) => Promise<TuiActionResult>
  executeTrustChange: (workflowName: string, fromLevel: string, toLevel: string) => Promise<TuiActionResult>
  executeWorkflowRun: (workflowName: string, mode: 'preview' | 'dry-run' | 'run') => Promise<TuiActionResult>
  publishWorkflowAsIssue?: (workflowName: string) => Promise<TuiActionResult>
  requestWorkflowReview?: (workflowName: string) => Promise<TuiActionResult>
  splitWorkflowIntoIssues?: (workflowName: string, parentIssue: number) => Promise<TuiActionResult>
  openWorkflowLifecycle?: (workflowName: string) => Promise<TuiActionResult>
  finalizeWorkflowPr?: (workflowName: string, prNumber: number) => Promise<TuiActionResult>
}

export interface ShellViewData {
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
  profile?: ProfileViewModel
  actionHandlers?: TuiActionHandlers
}

export async function renderShellTui(data?: ShellViewData): Promise<void> {
  const { unmount } = await renderTui(
    React.createElement(ShellView, { data }),
  )
}
