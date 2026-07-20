import React from 'react';
import { renderTui } from '../render.js';
import { mapStatusToViewModel } from '../view-models/status.js';
import StatusView from './StatusView.js';
import type { StatusViewModel } from '../view-models/status.js';

export type StatusTuiData = Parameters<typeof mapStatusToViewModel>[0];

export async function renderStatusTui(data: StatusTuiData): Promise<void> {
  const model = mapStatusToViewModel(data);
  const { unmount } = await renderTui(React.createElement(StatusView, { model }));
}
