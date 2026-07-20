import React from 'react';
import { renderTui } from '../render.js';
import { mapDoctorToViewModel } from '../view-models/doctor.js';
import type { DoctorReportInput, ProfileSyncGate } from '../view-models/doctor.js';
import DoctorView from './DoctorView.js';

export interface RenderDoctorTuiOptions {
  evidence?: string[];
  profileSyncGate?: ProfileSyncGate;
}

export async function renderDoctorTui(
  report: DoctorReportInput,
  options?: RenderDoctorTuiOptions,
): Promise<void> {
  const model = mapDoctorToViewModel(report, options);
  const { unmount } = await renderTui(React.createElement(DoctorView, { model }));
}
