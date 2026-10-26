/** Per-agent bearer storage. No token or upstream exception crosses this module's result API. @module */
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Host-owned task and transport identity, independent of model-supplied arguments. */
export interface ConfirmationScope {
  taskId: string
  /** Worker callbacks use a fixed run. Initiators learn one run only from a successful admission receipt. */
  runId?: string
  mode?: 'worker' | 'initiator'
  principalId: string
  generation: string
  /** Revalidate host binding and backing MCP definitions before and after every await. */
  assertCurrent: () => Promise<void>
}

interface Entry { token: string; expiresAt: number }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Carries only stable nonsecret diagnostics. */
export class ConfirmationFailure extends Error {
  /** Stable nonsecret failure identifier; never an authorization capability. */
  readonly code = 'OPENSLACK_CONFIRMATION_UNAVAILABLE'
  constructor() { super('Confirmation is unavailable; query this run before creating another plan'); this.name = 'ConfirmationFailure' }
}

/** One agent, one task, one connection generation. Dispose on any uncertain upstream outcome. */
export class ConfirmationVault {
  private readonly entries = new Map<string, Entry>()
  private disposed = false
  private admittedRun: string | undefined

  private readonly scope: ConfirmationScope
  constructor(scope: ConfirmationScope) { this.scope = { ...scope } }

  /** Irreversibly invalidate all pending confirmation capabilities. */
  dispose(): void { this.disposed = true; this.entries.clear() }

  /**
   * No model-supplied run becomes a query capability.
   * @param runId - proposed query target, not a source of authority.
   * @returns whether the live scope already owns that exact admitted run.
   */
  permitsQuery(runId: unknown): boolean {
    return !this.disposed && typeof runId === 'string' &&
      runId === (this.scope.mode === 'initiator' ? this.admittedRun : this.scope.runId)
  }

  /**
   * Hide the bearer and canonicalize both MCP projections before the caller can persist them.
   * @param raw - native preview definition from the bound connection.
   * @param args - inert preview intent, copied before any await.
   * @param exec - original tool execution, including its owned Agent and cancellation signal.
   * @returns sanitized canonical and text projections; the bearer stays private in memory.
   */
  async preview(raw: ToolDefinition, args: unknown, exec: ToolRunContext): Promise<unknown> {
    try {
      const input = structuredClone(args)
      await this.assertCurrent()
      if (!object(input) || !object(input.input) || Object.keys(input).sort().join(',') !== 'input,workflowId') throw new ConfirmationFailure()
      if (this.scope.mode === 'initiator') {
        if (input.workflowId !== 'harness.task.dispatch' || input.input.taskId !== this.scope.taskId ||
          Object.keys(input.input).sort().join(',') !== 'requestId,taskId' ||
          typeof input.input.requestId !== 'string' || this.admittedRun) throw new ConfirmationFailure()
      } else if (input.workflowId !== 'harness.task.report' || input.input.runId !== this.scope.runId ||
          Object.keys(input.input).sort().join(',') !== 'evidenceRefs,reportId,runId,summary' ||
          typeof input.input.reportId !== 'string' || typeof input.input.summary !== 'string' ||
          !Array.isArray(input.input.evidenceRefs) || input.input.evidenceRefs.some(ref => typeof ref !== 'string')) throw new ConfirmationFailure()
      const result = await raw.execute(input, exec)
      await this.assertCurrent()
      if (!object(result) || !object(result.structuredContent)) throw new ConfirmationFailure()
      const upstream = result.structuredContent
      const token = upstream.confirmationToken
      const planId = upstream.planId
      const data = upstream.data
      if (upstream.status !== 'needs_confirmation' || typeof token !== 'string' ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(token) || typeof planId !== 'string' ||
        !object(data) || typeof data.expiresAt !== 'string') throw new ConfirmationFailure()
      const expiresAt = Date.parse(data.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || this.entries.has(planId)) throw new ConfirmationFailure()
      const safe = scrub(upstream, token)
      this.entries.set(planId, { token, expiresAt })
      return project(safe)
    } catch {
      // Upstream messages can include bearer material. Never attach the caught cause.
      this.dispose()
      throw new ConfirmationFailure()
    }
  }

  /**
   * Supply the bearer internally once. A failed or cancelled confirmation cannot be replayed.
   * @param raw - native confirm or cancel definition from the bound connection.
   * @param args - local planId-only input, copied before any await.
   * @param exec - original tool execution and actor.
   * @param operation - host wrapper's fixed confirm/cancel selection, never a model-selected authority.
   * @returns sanitized upstream outcome; uncertainty invalidates all outstanding capabilities.
   */
  async settle(raw: ToolDefinition, args: unknown, exec: ToolRunContext, operation: 'confirm' | 'cancel' = 'confirm'): Promise<unknown> {
    let bearer: string | undefined
    try {
      const input = structuredClone(args)
      await this.assertCurrent()
      if (!object(input) || typeof input.planId !== 'string' || Object.keys(input).length !== 1) throw new ConfirmationFailure()
      const entry = this.entries.get(input.planId)
      if (!entry || entry.expiresAt <= Date.now()) throw new ConfirmationFailure()
      bearer = entry.token
      this.entries.delete(input.planId)
      const result = await raw.execute({ planId: input.planId, confirmationToken: bearer }, exec)
      await this.assertCurrent()
      if (!object(result) || !object(result.structuredContent)) throw new ConfirmationFailure()
      if (this.scope.mode === 'initiator' && operation === 'confirm' && result.structuredContent.status === 'completed') {
        const data = result.structuredContent.data
        const outcomes = object(data) && Array.isArray(data.outcomes) ? data.outcomes : []
        const receipt = outcomes.length === 1 && object(outcomes[0]) ? outcomes[0].data : undefined
        if (!object(receipt) || receipt.taskId !== this.scope.taskId || typeof receipt.runId !== 'string' ||
          !/^RUN-[A-Z0-9-]{1,124}$/.test(receipt.runId) || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(String(receipt.status))) {
          throw new ConfirmationFailure()
        }
        this.admittedRun = receipt.runId
      }
      return project(scrub(result.structuredContent, bearer))
    } catch {
      this.dispose()
      throw new ConfirmationFailure()
    }
  }

  private async assertCurrent(): Promise<void> {
    this.assertActive()
    await this.scope.assertCurrent()
    this.assertActive()
  }

  private assertActive(): void {
    if (this.disposed) throw new ConfirmationFailure()
  }
}

function scrub(value: unknown, token: string): unknown {
  if (typeof value === 'string') return value.split(token).join('[redacted]')
  if (Array.isArray(value)) return value.map(item => scrub(item, token))
  if (!object(value)) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/confirmationtoken/i.test(key))
    .map(([key, item]) => [key.split(token).join('[redacted]'), scrub(item, token)]))
}

function project(value: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}
