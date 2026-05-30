import React from 'react'
import type { DigestSummary } from '@openslack/collaboration'
import { renderTui } from '../render.js'
import { mapDigestToViewModel } from '../view-models/digest.js'
import DigestView from './DigestView.js'

export async function renderDigestTui(
  digest: DigestSummary,
  options?: { onBack?: () => void },
): Promise<void> {
  const model = mapDigestToViewModel(digest)
  const { unmount } = await renderTui(
    React.createElement(DigestView, { model, onBack: options?.onBack }),
  )
}
