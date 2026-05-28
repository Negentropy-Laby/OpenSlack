import React from 'react'
import type { WorkflowPreview } from '@openslack/collaboration'
import { renderTui } from '../render.js'
import { mapWorkflowPreviewToViewModel } from '../view-models/workflow-preview.js'
import WorkflowPreviewView from './WorkflowPreviewView.js'

export async function renderWorkflowPreviewTui(preview: WorkflowPreview): Promise<void> {
  const model = mapWorkflowPreviewToViewModel(preview)
  const { unmount } = await renderTui(
    React.createElement(WorkflowPreviewView, { model }),
  )
}
