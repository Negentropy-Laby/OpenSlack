import React from 'react';
import { renderTui } from '../render.js';
import { mapPrQueueToViewModel } from '../view-models/pr-queue.js';
import type { PrQueueInputItem } from '../view-models/pr-queue.js';
import PrQueueView from './PrQueueView.js';

export async function renderPrQueueTui(items: PrQueueInputItem[]): Promise<void> {
  const model = mapPrQueueToViewModel(items);
  const { unmount } = await renderTui(React.createElement(PrQueueView, { model }));
}
