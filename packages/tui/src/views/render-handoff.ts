import React from 'react'
import type { Handoff } from '@openslack/collaboration'
import { renderTui } from '../render.js'
import { mapHandoffListToViewModel, mapHandoffToViewModel } from '../view-models/handoff.js'
import HandoffListView from './HandoffListView.js'
import HandoffDetailView from './HandoffDetailView.js'

export async function renderHandoffListTui(
  handoffs: Handoff[],
  options?: { onSelect?: (item: { id: string }) => void; onBack?: () => void },
): Promise<void> {
  const model = mapHandoffListToViewModel(handoffs)
  await renderTui(
    React.createElement(HandoffListView, {
      model,
      onSelect: options?.onSelect ? item => options.onSelect(item) : undefined,
      onBack: options?.onBack,
    }),
  )
}

export async function renderHandoffDetailTui(
  handoff: Handoff,
  options?: { onBack?: () => void },
): Promise<void> {
  const model = mapHandoffToViewModel(handoff)
  await renderTui(
    React.createElement(HandoffDetailView, { model, onBack: options?.onBack }),
  )
}
