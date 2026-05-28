import type { PRQueueItem } from '@openslack/pr'
import { sanitizeTerminalText } from '../sanitize.js'

export interface PrQueueViewModel {
  title: string
  totalPRs: number
  readyCount: number
  blockedCount: number
  pendingCount: number
  items: Array<{
    prNumber: number
    title: string
    author: string
    decision: string
    blockerCategory: string
    owner: string
    canMerge: boolean
    riskZone: string
    nextAction: string
    rerunCommand: string
  }>
}

export function mapPrQueueToViewModel(items: PRQueueItem[]): PrQueueViewModel {
  const s = sanitizeTerminalText

  const readyCount = items.filter(i => i.canMerge).length
  const blockedCount = items.filter(i => i.blockerCategory !== 'none' && !i.canMerge).length
  const pendingCount = items.filter(i => i.blockerCategory === 'checks').length

  return {
    title: 'PR Queue',
    totalPRs: items.length,
    readyCount,
    blockedCount,
    pendingCount,
    items: items.map(item => ({
      prNumber: item.prNumber,
      title: s(item.title),
      author: s(item.author),
      decision: s(item.decision),
      blockerCategory: s(item.blockerCategory),
      owner: s(item.owner),
      canMerge: item.canMerge,
      riskZone: s(item.riskZone),
      nextAction: s(item.nextAction),
      rerunCommand: s(item.rerunCommand),
    })),
  }
}
