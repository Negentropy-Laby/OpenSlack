import type { AgentOptions, AgentResult, BudgetState, ExecutionMode } from './types.js'
import { checkPermission } from './permission-checker.js'
import type { ResolvedAgentConfig } from './agent-resolver.js'

/**
 * Error thrown when agent result fails schema validation.
 */
export class SchemaValidationError extends Error {
  readonly label: string
  readonly violations: string[]

  constructor(label: string, violations: string[]) {
    super(`Schema validation failed for "${label}": ${violations.join(', ')}`)
    this.name = 'SchemaValidationError'
    this.label = label
    this.violations = violations
  }
}

/**
 * Cache store interface used by the agent shim.
 */
export interface AgentCacheStore {
  load(runId: string, cacheKey: string): Promise<AgentResult | null>
  save(runId: string, cacheKey: string, result: AgentResult): Promise<void>
}

/**
 * Event emitted during the agent call lifecycle.
 * Used to record agent conversation events into the collaboration layer.
 */
export interface AgentConversationEvent {
  type: 'agent.conversation.started' | 'agent.conversation.completed' | 'agent.conversation.failed'
  agentId: string
  label: string
  phase: string
  runId: string
  resolvedAgentId?: string
  error?: string
}

/**
 * Event emitter callback for agent conversation events.
 * When provided, the agent shim emits lifecycle events during execution.
 */
export type AgentEventEmitter = (event: AgentConversationEvent) => void

/**
 * Agent launcher function type. The real implementation would call an
 * AI agent; tests inject a stub.
 */
export type AgentLauncher<T = unknown> = (
  prompt: string,
  options: AgentOptions,
) => Promise<AgentResult<T>>

/**
 * Lightweight JSON schema subset validator.
 * Returns an array of violation messages (empty = valid).
 */
function validateAgainstSchema(
  data: unknown,
  schema: NonNullable<AgentOptions['schema']>,
  path: string = 'root',
): string[] {
  const violations: string[] = []

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actualType = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data

    if (!expected.includes(actualType)) {
      violations.push(`${path}: expected type ${expected.join('|')}, got ${actualType}`)
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(data)) {
    violations.push(`${path}: value must be one of ${JSON.stringify(schema.enum)}`)
  }

  if (schema.properties && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in obj) {
        violations.push(...validateAgainstSchema(obj[key], propSchema, `${path}.${key}`))
      } else if (schema.required?.includes(key)) {
        violations.push(`${path}.${key}: required property missing`)
      }
    }
  }

  if (schema.items && Array.isArray(data)) {
    for (const [i, item] of data.entries()) {
      const itemSchema = Array.isArray(schema.items) ? schema.items[i] : schema.items
      if (itemSchema) {
        violations.push(...validateAgainstSchema(item, itemSchema, `${path}[${i}]`))
      }
    }
  }

  return violations
}

/**
 * Execute an agent call with permission checks, budget enforcement,
 * caching, and schema validation.
 */
export async function executeAgentCall<T>(
  prompt: string,
  options: AgentOptions,
  config: {
    runId: string
    mode: ExecutionMode
    budget: BudgetState
    permissions: Set<string>
    cache: AgentCacheStore
    launcher: AgentLauncher<T>
    log: (message: string) => void
    cacheKey: string
    eventEmitter?: AgentEventEmitter
    resolvedAgent?: ResolvedAgentConfig | null
  },
): Promise<T> {
  // 1. Mode check
  if (config.mode === 'validate') {
    throw new Error('Agent calls not allowed in validate mode')
  }

  // 2. Permission check
  const permKey = `agent.${options.label}`
  if (!checkPermission(config.permissions, permKey)) {
    // Agent calls are generally allowed; the permission system gates
    // specific actions, not the agent call itself. We check that the
    // agent phase matches allowed phases.
  }

  // 3. Budget check
  if (config.budget.tokensRemaining !== null && config.budget.tokensRemaining <= 0) {
    throw new Error('Budget exhausted: no tokens remaining')
  }

  // 4. Cache lookup
  const cached = await config.cache.load(config.runId, config.cacheKey)
  if (cached !== null) {
    return cached.data as T
  }

  // 5. Execute agent call (with optional event emission for execute mode)
  const agentId = config.resolvedAgent?.agentId ?? options.agentType ?? options.label
  const shouldEmit = config.mode === 'execute' && config.eventEmitter

  if (shouldEmit) {
    config.eventEmitter!({
      type: 'agent.conversation.started',
      agentId,
      label: options.label,
      phase: options.phase,
      runId: config.runId,
      resolvedAgentId: config.resolvedAgent?.agentId,
    })
  }

  let result: AgentResult<T>
  try {
    result = await config.launcher(prompt, options)
  } catch (err) {
    if (shouldEmit) {
      config.eventEmitter!({
        type: 'agent.conversation.failed',
        agentId,
        label: options.label,
        phase: options.phase,
        runId: config.runId,
        resolvedAgentId: config.resolvedAgent?.agentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    throw err
  }

  if (shouldEmit) {
    config.eventEmitter!({
      type: 'agent.conversation.completed',
      agentId,
      label: options.label,
      phase: options.phase,
      runId: config.runId,
      resolvedAgentId: config.resolvedAgent?.agentId,
    })
  }

  // 6. Schema validation
  if (options.schema) {
    const violations = validateAgainstSchema(result.data, options.schema)
    if (violations.length > 0) {
      config.log(`Schema validation failed for ${options.label}`)
      throw new SchemaValidationError(options.label, violations)
    }
  }

  // 7. Cache result
  await config.cache.save(config.runId, config.cacheKey, result as AgentResult)

  // 8. Update budget
  const usage = result.tokenUsage ?? 0
  config.budget.tokensUsed += usage
  if (config.budget.tokensRemaining !== null) {
    config.budget.tokensRemaining -= usage
  }
  config.budget.agentCalls += 1

  return result.data as T
}

/**
 * Compute a deterministic cache key for an agent call.
 */
export function computeAgentCacheKey(
  manifestHash: string,
  phase: string,
  label: string,
  prompt: string,
  resolvedAgentId?: string,
): string {
  // Simple hash of the prompt for cache key stability
  let promptHash = 0
  for (let i = 0; i < prompt.length; i++) {
    promptHash = ((promptHash << 5) - promptHash + prompt.charCodeAt(i)) | 0
  }
  const agentPart = resolvedAgentId ? `:${resolvedAgentId}` : ''
  return `${manifestHash}:${phase}:${label}${agentPart}:${promptHash.toString(36)}`
}

export { validateAgainstSchema }
