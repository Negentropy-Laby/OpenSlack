import type { DigestSummary, DigestGroup, CollaborationEvent } from '@openslack/collaboration'
import { sanitizeTerminalText } from '../sanitize.js'

export interface DigestEventViewModel {
  time: string
  type: string
  summary: string
  objectKind: string
  objectId: string
}

export interface DigestGroupViewModel {
  label: string
  count: number
  status: 'pass' | 'warn' | 'fail' | 'info'
  events: DigestEventViewModel[]
}

export interface DigestViewModel {
  title: string
  periodHours: number
  totalEvents: number
  groups: DigestGroupViewModel[]
  recommendedNext: Array<{
    objectKind: string
    objectId: string
    action: string
  }>
}

function groupStatus(label: string): 'pass' | 'warn' | 'fail' | 'info' {
  switch (label) {
    case 'Completed':
      return 'pass'
    case 'Needs Human':
      return 'warn'
    case 'Blocked':
      return 'fail'
    case 'Agent Activity':
      return 'info'
    case 'Governance':
      return 'info'
    default:
      return 'info'
  }
}

export function mapDigestToViewModel(digest: DigestSummary): DigestViewModel {
  const s = sanitizeTerminalText

  return {
    title: 'OpenSlack Digest',
    periodHours: digest.periodHours,
    totalEvents: digest.totalEvents,
    groups: digest.groups.map(g => ({
      label: s(g.label),
      count: g.events.length,
      status: groupStatus(g.label),
      events: g.events.map(e => ({
        time: e.timestamp.slice(11, 16),
        type: s(e.type),
        summary: s(e.summary ?? ''),
        objectKind: s(e.object.kind),
        objectId: s(e.object.id),
      })),
    })),
    recommendedNext: digest.recommendedNext.map(e => ({
      objectKind: s(e.object.kind),
      objectId: s(e.object.id),
      action: s(e.nextAction?.action ?? ''),
    })),
  }
}
