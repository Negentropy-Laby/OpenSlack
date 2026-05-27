import React from 'react'
import type { DashboardProjection } from '@openslack/collaboration'
import { renderTui } from '../render.js'
import { mapDashboardToViewModel } from '../view-models/dashboard.js'
import DashboardView from './DashboardView.js'

export async function renderDashboardTui(projection: DashboardProjection): Promise<void> {
  const model = mapDashboardToViewModel(projection)
  const { unmount } = await renderTui(
    React.createElement(DashboardView, { model }),
  )
}
