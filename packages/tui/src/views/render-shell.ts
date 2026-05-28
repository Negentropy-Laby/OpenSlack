import React from 'react'
import { renderTui } from '../render.js'
import ShellView from './ShellView.js'
import type { DashboardViewModel } from '../view-models/dashboard.js'
import type { PrQueueViewModel } from '../view-models/pr-queue.js'
import type { StatusViewModel } from '../view-models/status.js'
import type { WorkflowGalleryViewModel } from '../view-models/workflow-gallery.js'
import type { ApprovalCenterViewModel } from '../view-models/approval-center.js'

export interface ShellViewData {
  dashboard?: DashboardViewModel
  prQueue?: PrQueueViewModel
  status?: StatusViewModel
  workflowGallery?: WorkflowGalleryViewModel
  approvals?: ApprovalCenterViewModel
}

export async function renderShellTui(data?: ShellViewData): Promise<void> {
  const { unmount } = await renderTui(
    React.createElement(ShellView, { data }),
  )
}
