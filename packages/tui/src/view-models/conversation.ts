import type {
  AgentConversationThread,
  AgentConversationMessage,
  AgentParticipant,
  ConversationLinkedObject,
} from '@openslack/collaboration'
import { sanitizeTerminalText } from '../sanitize.js'

// --- Conversation List ---

export interface ConversationListItem {
  id: string
  title: string
  participantCount: number
  lastActivity: string
  status: string
  linkedObjects: ConversationLinkedObject[]
}

export interface ConversationListViewModel {
  title: string
  totalCount: number
  activeCount: number
  items: ConversationListItem[]
}

function formatTimestamp(iso: string): string {
  const created = new Date(iso).getTime()
  const now = Date.now()
  const minutes = Math.floor((now - created) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

const TITLE_MAX_LENGTH = 60

function truncateTitle(title: string): string {
  if (title.length <= TITLE_MAX_LENGTH) return title
  return title.slice(0, TITLE_MAX_LENGTH - 1) + '…'
}

export function mapConversationListToViewModel(
  threads: AgentConversationThread[],
): ConversationListViewModel {
  const s = sanitizeTerminalText
  const sorted = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return {
    title: 'Conversations',
    totalCount: threads.length,
    activeCount: threads.filter(t => t.status === 'active' || t.status === 'open').length,
    items: sorted.map(thread => ({
      id: s(thread.id),
      title: truncateTitle(s(thread.title)),
      participantCount: thread.participants.length,
      lastActivity: formatTimestamp(thread.updatedAt),
      status: thread.status,
      linkedObjects: thread.linkedObjects,
    })),
  }
}

// --- Thread Detail ---

export interface ThreadMessageItem {
  id: string
  kind: AgentConversationMessage['kind']
  authorDisplay: string
  timestamp: string
  content: string
  metadata?: Record<string, string>
}

export interface ThreadViewModel {
  id: string
  title: string
  status: string
  participants: Array<{ id: string; displayName: string; kind: string }>
  messages: ThreadMessageItem[]
  linkedObjects: ConversationLinkedObject[]
  nextAction?: { owner: string; action: string; command?: string }
}

function resolveAuthorDisplay(
  authorId: string,
  participants: AgentParticipant[],
): string {
  const participant = participants.find(p => p.id === authorId)
  if (participant) return participant.displayName
  return authorId
}

function mapMessageToItem(
  msg: AgentConversationMessage,
  participants: AgentParticipant[],
): ThreadMessageItem {
  const s = sanitizeTerminalText
  const authorDisplay = resolveAuthorDisplay(msg.authorId, participants)
  const timestamp = new Date(msg.timestamp).toLocaleTimeString()

  switch (msg.kind) {
    case 'user_message':
      return {
        id: msg.id,
        kind: 'user_message',
        authorDisplay: 'You',
        timestamp,
        content: s(msg.text),
        metadata: msg.source ? { source: `${msg.source.kind}:${msg.source.ref}` } : undefined,
      }
    case 'agent_response':
      return {
        id: msg.id,
        kind: 'agent_response',
        authorDisplay,
        timestamp,
        content: s(msg.text),
      }
    case 'tool_event':
      return {
        id: msg.id,
        kind: 'tool_event',
        authorDisplay,
        timestamp,
        content: s(msg.toolName),
        metadata: {
          ...(msg.input != null ? { input: typeof msg.input === 'string' ? s(msg.input) : JSON.stringify(msg.input) } : {}),
          ...(msg.output != null ? { output: typeof msg.output === 'string' ? s(msg.output) : JSON.stringify(msg.output) } : {}),
        },
      }
    case 'plan':
      return {
        id: msg.id,
        kind: 'plan',
        authorDisplay,
        timestamp,
        content: msg.steps.map((step, i) => `${i + 1}. ${s(step)}`).join('\n'),
        metadata: { planId: s(msg.planId) },
      }
    case 'approval_request':
      return {
        id: msg.id,
        kind: 'approval_request',
        authorDisplay,
        timestamp,
        content: s(msg.targetAction),
        metadata: { riskLevel: s(msg.riskLevel) },
      }
    case 'decision':
      return {
        id: msg.id,
        kind: 'decision',
        authorDisplay,
        timestamp,
        content: s(msg.summary),
        metadata: { decisionId: s(msg.decisionId) },
      }
    case 'handoff':
      return {
        id: msg.id,
        kind: 'handoff',
        authorDisplay,
        timestamp,
        content: s(msg.summary),
        metadata: { handoffId: s(msg.handoffId), toParticipant: s(msg.toParticipant) },
      }
    default: {
      const _exhaustive: never = msg
      throw new Error(`Unhandled message kind: ${(msg as { kind: string }).kind}`)
    }
  }
}

export function mapThreadToViewModel(
  thread: AgentConversationThread,
  messages: AgentConversationMessage[],
): ThreadViewModel {
  const s = sanitizeTerminalText
  const sortedMessages = [...messages].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  )

  return {
    id: s(thread.id),
    title: truncateTitle(s(thread.title)),
    status: thread.status,
    participants: thread.participants.map(p => ({
      id: s(p.id),
      displayName: s(p.displayName),
      kind: p.kind,
    })),
    messages: sortedMessages.map(msg => mapMessageToItem(msg, thread.participants)),
    linkedObjects: thread.linkedObjects,
    nextAction: thread.nextAction
      ? {
          owner: s(thread.nextAction.owner),
          action: s(thread.nextAction.action),
          command: thread.nextAction.command ? s(thread.nextAction.command) : undefined,
        }
      : undefined,
  }
}
