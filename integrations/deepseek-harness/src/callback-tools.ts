/** Shared bearer-free local projection; caller/worker query ownership remains an injected policy. */
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ConfirmationVault } from './confirmation-vault.ts'

export const CALLBACK_DISCONNECT_REASON = 'OpenSlack MCP disconnected; preserve and reconcile without replay'
export type CallbackOperation = 'query' | 'preview' | 'confirm' | 'cancel'
interface CallbackProjection {
  operation: CallbackOperation
  definition: ToolDefinition
  vault: ConfirmationVault
  current(exec: ToolRunContext): Promise<void>
  permitsQuery(runId: unknown): boolean
  before?(input: unknown, exec: ToolRunContext): Promise<void>
  after?(result: unknown, exec: ToolRunContext): Promise<void>
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Raw upstream write definitions remain private; only planId reaches a local confirmation wrapper. */
export function projectCallbackTool(options: CallbackProjection): ToolDefinition {
  const { operation, definition, vault } = options
  return {
    name: definition.name, description: definition.description,
    parameters: operation === 'confirm' || operation === 'cancel'
      ? { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'], additionalProperties: false }
      : definition.parameters,
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const input = structuredClone(args)
      await options.current(exec)
      await options.before?.(input, exec)
      let result: unknown
      if (operation === 'preview') result = await vault.preview(definition, input, exec)
      else if (operation === 'confirm' || operation === 'cancel') result = await vault.settle(definition, input, exec, operation)
      else {
        if (!object(input) || input.objectKind !== 'workflow' || !options.permitsQuery(input.objectId) ||
          Object.keys(input).some(key => !['objectKind', 'objectId', 'limit'].includes(key))) throw new Error('Query only this bound OpenSlack run')
        result = await definition.execute(input, exec)
      }
      await options.current(exec)
      await options.after?.(result, exec)
      return result
    },
  }
}
