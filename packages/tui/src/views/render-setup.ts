import React from 'react';
import type { SetupReport } from '@openslack/runtime';
import { renderTui } from '../render.js';
import { mapSetupToViewModel } from '../view-models/setup.js';
import SetupView from './SetupView.js';

export async function renderSetupTui(report: SetupReport): Promise<void> {
  const model = mapSetupToViewModel(report);
  await renderTui(React.createElement(SetupView, { model }));
}
