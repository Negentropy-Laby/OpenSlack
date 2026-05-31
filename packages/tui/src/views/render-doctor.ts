import React from 'react'
import { renderTui } from '../render.js'
import { mapDoctorToViewModel } from '../view-models/doctor.js'
import type { DoctorReportInput } from '../view-models/doctor.js'
import DoctorView from './DoctorView.js'

export interface RenderDoctorTuiOptions {
  evidence?: string[]
}

export async function renderDoctorTui(
  report: DoctorReportInput,
  options?: RenderDoctorTuiOptions,
): Promise<void> {
  const model = mapDoctorToViewModel(report, options?.evidence)
  const { unmount } = await renderTui(
    React.createElement(DoctorView, { model }),
  )
}
