import type { CollaborationEvent } from '@openslack/collaboration'
import { sanitizeTerminalText } from '../sanitize.js'

export interface ActivityEventViewModel {
  time: string
  type: string
  summary: string
  actor: string
  objectKind: string
  objectId: string
  owner?: string
  nextAction?: string
  risk?: string
}

export interface ActivityViewModel {
  title: string
  periodHours: number
  totalEvents: number
  events: ActivityEventViewModel[]
  today: ActivityEventViewModel[]
  yesterday: ActivityEventViewModel[]
  older: ActivityEventViewModel[]
}

function formatTimeBucket(timestamp: string): 'today' | 'yesterday' | 'older' {
  const eventDate = new Date(timestamp)
  const now = new Date()
  const eventDay = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate())
  const todayDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diffMs = todayDay.getTime() - eventDay.getTime()
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  return 'older'
}

export function mapActivityToViewModel(
  events: CollaborationEvent[],
  periodHours: number,
): ActivityViewModel {
  const s = sanitizeTerminalText

  const eventsVm = events.map(e => ({
    time: e.timestamp.slice(11, 16),
    type: s(e.type),
    summary: s(e.summary ?? ''),
    actor: s(e.actor.id),
    objectKind: s(e.object.kind),
    objectId: s(e.object.id),
    owner: e.owner ? s(e.owner.id) : undefined,
    nextAction: e.nextAction ? s(e.nextAction.action) : undefined,
    risk: e.risk ? s(e.risk) : undefined,
  }))

  const today = eventsVm.filter((_, i) => formatTimeBucket(events[i].timestamp) === 'today')
  const yesterday = eventsVm.filter((_, i) => formatTimeBucket(events[i].timestamp) === 'yesterday')
  const older = eventsVm.filter((_, i) => formatTimeBucket(events[i].timestamp) === 'older')

  return {
    title: 'Activity Feed',
    periodHours,
    totalEvents: events.length,
    events: eventsVm,
    today,
    yesterday,
    older,
  }
}
