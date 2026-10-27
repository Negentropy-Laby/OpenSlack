/** Process-local services owned by this external package, not additions to Harness. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ProcessExitReceipt } from './process-observer.ts'
export interface OpenSlackConnection {
  readonly connected: boolean
  tool(name: string): ToolDefinition | undefined
  stop(deadlineAt?: number): Promise<ProcessExitReceipt>
}
declare module '@deepseek-ai/cordis' {
  interface Context { openslackConnection: OpenSlackConnection }
  interface Events {
    'openslack/connection-state'(serverName: string): boolean | undefined
    'openslack/connection-lost'(serverName: string): void
    'openslack/is-closing'(): boolean | undefined
    'openslack/closing'(): void
    'openslack/host-request'(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> | undefined
  }
}
