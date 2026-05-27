import React from 'react'
import type { PRReviewReport } from '@openslack/pr'
import { renderTui } from '../render.js'
import { mapDoctorToViewModel } from '../view-models/doctor.js'
import DoctorView from './DoctorView.js'

export interface RenderDoctorTuiOptions {
  evidence?: string[]
}

export async function renderDoctorTui(
  report: PRReviewReport,
  options?: RenderDoctorTuiOptions,
): Promise<void> {
  const model = mapDoctorToViewModel(report, options?.evidence)
  const { unmount } = await renderTui(
    React.createElement(DoctorView, { model }),
  )
}
