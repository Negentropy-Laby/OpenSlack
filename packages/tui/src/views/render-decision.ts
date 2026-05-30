import React from 'react'
import type { Decision } from '@openslack/collaboration'
import { renderTui } from '../render.js'
import { mapDecisionListToViewModel, mapDecisionToViewModel } from '../view-models/decision.js'
import DecisionListView from './DecisionListView.js'
import DecisionDetailView from './DecisionDetailView.js'

export async function renderDecisionListTui(
  decisions: Decision[],
  options?: { onSelect?: (item: { id: string }) => void; onBack?: () => void },
): Promise<void> {
  const model = mapDecisionListToViewModel(decisions)
  await renderTui(
    React.createElement(DecisionListView, {
      model,
      onSelect: options?.onSelect ? item => options.onSelect(item) : undefined,
      onBack: options?.onBack,
    }),
  )
}

export async function renderDecisionDetailTui(
  decision: Decision,
  options?: { onBack?: () => void },
): Promise<void> {
  const model = mapDecisionToViewModel(decision)
  await renderTui(
    React.createElement(DecisionDetailView, { model, onBack: options?.onBack }),
  )
}
