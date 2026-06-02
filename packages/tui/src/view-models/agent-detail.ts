import type { SubagentDefinition } from '@openslack/kernel'
import { sanitizeTerminalText } from '../sanitize.js'

export interface AgentDetailItem {
  name: string
  source: string
  description: string
  model?: string
  tools: string[]
  deniedTools: string[]
  memory: string
  isolation: string
  canSpawn: boolean
  maxTurns?: number
}

export function mapSubagentToViewModel(agent: SubagentDefinition): AgentDetailItem {
  const s = sanitizeTerminalText

  return {
    name: s(agent.name),
    source: agent.source,
    description: s(agent.description),
    model: agent.model ? s(agent.model) : undefined,
    tools: (agent.tools ?? []).map(s),
    deniedTools: (agent.disallowedTools ?? []).map(s),
    memory: agent.memory ?? 'none',
    isolation: agent.isolation ?? 'none',
    canSpawn: (agent.tools ?? []).some(t => t === 'spawn_subagent' || t === 'Task'),
    maxTurns: agent.maxTurns,
  }
}
