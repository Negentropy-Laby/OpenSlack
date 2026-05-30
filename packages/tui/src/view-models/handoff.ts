import type { Handoff } from '@openslack/collaboration'
import { sanitizeTerminalText } from '../sanitize.js'

export interface HandoffListItemViewModel {
  id: string
  from: string
  to: string
  status: string
  context: string
  age: string
  ref: string
}

export interface HandoffListViewModel {
  title: string
  totalCount: number
  openCount: number
  items: HandoffListItemViewModel[]
}

export interface HandoffDetailViewModel {
  id: string
  status: string
  from: string
  to: string
  createdAt: string
  acceptedAt?: string
  closedAt?: string
  issueRef?: string
  prRef?: string
  context: string
  nextSteps: string[]
  notes?: string
  canAccept: boolean
  canClose: boolean
}

function formatAge(createdAt: string): string {
  const created = new Date(createdAt).getTime()
  const now = Date.now()
  const hours = Math.floor((now - created) / 3600000)
  if (hours < 1) return '<1h'
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function mapHandoffListToViewModel(handoffs: Handoff[]): HandoffListViewModel {
  const s = sanitizeTerminalText
  const sorted = [...handoffs].sort((a, b) => {
    // Open first, then by date descending
    if (a.status === 'open' && b.status !== 'open') return -1
    if (a.status !== 'open' && b.status === 'open') return 1
    return b.createdAt.localeCompare(a.createdAt)
  })

  return {
    title: 'Handoffs',
    totalCount: handoffs.length,
    openCount: handoffs.filter(h => h.status === 'open').length,
    items: sorted.map(h => ({
      id: s(h.id),
      from: s(h.from),
      to: s(h.to),
      status: h.status,
      context: s(h.context),
      age: formatAge(h.createdAt),
      ref: h.issueRef ? `issue:${h.issueRef}` : h.prRef ? `pr:${h.prRef}` : 'no ref',
    })),
  }
}

export function mapHandoffToViewModel(handoff: Handoff): HandoffDetailViewModel {
  const s = sanitizeTerminalText

  return {
    id: s(handoff.id),
    status: handoff.status,
    from: s(handoff.from),
    to: s(handoff.to),
    createdAt: handoff.createdAt,
    acceptedAt: handoff.acceptedAt,
    closedAt: handoff.closedAt,
    issueRef: handoff.issueRef,
    prRef: handoff.prRef,
    context: s(handoff.context),
    nextSteps: handoff.nextSteps.map(s),
    notes: handoff.notes ? s(handoff.notes) : undefined,
    canAccept: handoff.status === 'open',
    canClose: handoff.status !== 'closed',
  }
}
