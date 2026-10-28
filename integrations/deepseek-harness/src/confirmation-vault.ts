/** Per-agent bearer storage. No token or upstream exception crosses this module's result API. @module */
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Host-owned task and transport identity, independent of model-supplied arguments. */
interface ConfirmationScopeBase {
  taskId: string
  principalId: string
  generation: string
  /** Revalidate host binding and backing MCP definitions before and after every await. */
  assertCurrent: () => Promise<void>
}
/** Chosen by the trusted plugin composition, never inferred from model arguments. */
export type ConfirmationScope = ConfirmationScopeBase & (
  { mode: 'worker'; runId: string } | { mode: 'initiator'; runId?: never }
)

interface Entry { token: string; expiresAt: number }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function copyInput(value: unknown): unknown {
  try { return structuredClone(value) }
  catch { throw new ConfirmationFailure() }
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
  constructor(scope: ConfirmationScope) {
    if (!scope.taskId || !scope.principalId || !scope.generation || typeof scope.assertCurrent !== 'function' ||
      (scope.mode === 'worker' ? !/^RUN-[A-Z0-9-]+$/.test(scope.runId) : scope.mode !== 'initiator' || scope.runId !== undefined)) {
      throw new ConfirmationFailure()
    }
    this.scope = Object.freeze({ ...scope })
  }

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
    // A local typo has not attempted an upstream effect and cannot invalidate
    // unrelated, still-live confirmation capabilities.
    const input = copyInput(args)
    if (!object(input) || !object(input.input) || Object.keys(input).sort().join(',') !== 'input,workflowId') throw new ConfirmationFailure()
    if (this.scope.mode === 'initiator') {
      if (input.workflowId !== 'harness.task.dispatch' || input.input.taskId !== this.scope.taskId ||
        Object.keys(input.input).sort().join(',') !== 'requestId,taskId' ||
        typeof input.input.requestId !== 'string' || this.admittedRun) throw new ConfirmationFailure()
    } else if (input.workflowId !== 'harness.task.report' || input.input.runId !== this.scope.runId ||
        Object.keys(input.input).sort().join(',') !== 'evidenceRefs,reportId,runId,summary' ||
        typeof input.input.reportId !== 'string' || typeof input.input.summary !== 'string' ||
        !Array.isArray(input.input.evidenceRefs) || input.input.evidenceRefs.some(ref => typeof ref !== 'string')) throw new ConfirmationFailure()
    try { await this.assertCurrent() }
    catch { this.dispose(); throw new ConfirmationFailure() }
    // A confirmation may have admitted the initiator's run during the await.
    // This is a local refusal, not an ambiguous upstream request.
    if (this.scope.mode === 'initiator' && this.admittedRun) throw new ConfirmationFailure()
    try {
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
    const input = copyInput(args)
    if (!object(input) || typeof input.planId !== 'string' || Object.keys(input).length !== 1) throw new ConfirmationFailure()
    try { await this.assertCurrent() }
    catch { this.dispose(); throw new ConfirmationFailure() }
    // Look up and consume only after the authority await. Concurrent duplicate
    // calls cannot consume twice or dispose the legitimate in-flight request.
    const entry = this.entries.get(input.planId)
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(input.planId)
      throw new ConfirmationFailure()
    }
    const bearer = entry.token
    this.entries.delete(input.planId)
    try {
      const result = await raw.execute({ planId: input.planId, confirmationToken: bearer }, exec)
      await this.assertCurrent()
      if (!object(result) || !object(result.structuredContent)) throw new ConfirmationFailure()
      if (this.scope.mode === 'initiator' && operation === 'confirm') {
        const upstream = result.structuredContent
        const data = upstream.data
        const outcomes = object(data) && Array.isArray(data.outcomes) ? data.outcomes : []
        const outcome = outcomes.length === 1 && object(outcomes[0]) ? outcomes[0] : undefined
        const receipt = outcome?.data
        let observedRun: string | undefined
        if (upstream.status === 'completed') {
          if (!object(receipt) || receipt.taskId !== this.scope.taskId || typeof receipt.runId !== 'string' ||
            !/^RUN-[A-Z0-9-]+$/.test(receipt.runId) || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(String(receipt.status))) {
            throw new ConfirmationFailure()
          }
          observedRun = receipt.runId
        } else if (upstream.status === 'blocked' && object(data) && data.settlement !== undefined) {
          const governance = upstream.governance
          if (upstream.planId !== input.planId || data.kind !== 'workflow.start' || data.state !== 'succeeded' ||
            data.settlement !== 'unconfirmed' || data.requiresReconciliation !== true || !object(governance) || governance.blocker !== 'GOVERNED_MUTATION_SETTLEMENT_UNCONFIRMED' ||
            outcome?.actionId !== 'harness.task.dispatch' || outcome.status !== 'succeeded' || !object(receipt) ||
            receipt.taskId !== this.scope.taskId || typeof receipt.runId !== 'string' || !/^RUN-[A-Z0-9-]+$/.test(receipt.runId) ||
            !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(String(receipt.status))) throw new ConfirmationFailure()
          // Durable admission is not a second confirmation or execution grant.
          // It binds only the route that the original caller must reconcile.
          observedRun = receipt.runId
        } else if (object(receipt) && receipt.admission !== undefined) {
          // A duplicate may observe an exclusively owned admission before its
          // visibility publication finishes. This host-bound route grants only
          // query access, never a pending/completed execution or another dispatch.
          const admission = receipt.admission
          if (upstream.status !== 'blocked' || upstream.planId !== input.planId ||
            !object(data) || data.state !== 'blocked' || outcome?.status !== 'blocked' ||
            outcome.actionId !== 'harness.task.dispatch' || receipt.taskId !== this.scope.taskId ||
            !object(admission) || Object.keys(admission).sort().join(',') !== 'canonicalRunPresent,disposition,kind,requestHash,runId' ||
            admission.kind !== 'admission' || typeof admission.runId !== 'string' || !/^RUN-[A-Z0-9-]+$/.test(admission.runId) ||
            typeof admission.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(admission.requestHash) ||
            typeof admission.canonicalRunPresent !== 'boolean' || !['in_progress', 'reconcile_required'].includes(String(admission.disposition))) {
            throw new ConfirmationFailure()
          }
          observedRun = admission.runId
        }
        if (observedRun !== undefined) {
          if (this.admittedRun !== undefined && this.admittedRun !== observedRun) throw new ConfirmationFailure()
          this.admittedRun = observedRun
        }
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
