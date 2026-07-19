import React from 'react';
import { renderTui } from '../render.js';
import {
  mapRepositoryPrProjectionToViewModel,
  type RepositoryPrProjectionInput,
} from '../view-models/repository-pr-projection.js';
import RepositoryPrProjectionView from './RepositoryPrProjectionView.js';

export async function renderRepositoryPrProjectionTui(
  input: RepositoryPrProjectionInput,
): Promise<void> {
  const model = mapRepositoryPrProjectionToViewModel(input);
  await renderTui(React.createElement(RepositoryPrProjectionView, { model }));
}
