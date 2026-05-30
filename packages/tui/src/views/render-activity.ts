import React from 'react'
import type { CollaborationEvent } from '@openslack/collaboration'
import { renderTui } from '../render.js'
import { mapActivityToViewModel } from '../view-models/activity.js'
import ActivityView from './ActivityView.js'

export async function renderActivityTui(
  events: CollaborationEvent[],
  options?: { periodHours?: number; onBack?: () => void },
): Promise<void> {
  const model = mapActivityToViewModel(events, options?.periodHours ?? 24)
  await renderTui(
    React.createElement(ActivityView, { model, onBack: options?.onBack }),
  )
}
