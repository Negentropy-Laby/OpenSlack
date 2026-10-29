/** Strict read-only OpenSlack STDIO composition; no identity or credential bootstrap. @module */
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as Connection from './connection.ts'
import { assertRuntimeBindings } from './runtime-bindings.ts'

/** Loader identity. */
export const name = 'openslack-readonly'
/** The native MCP client requires the existing tool registry. */
export const inject = ['tools']

/** Nonsecret, deployment-owned paths. No commands or identity fields reach model input. */
export interface Config {
  /** Absolute native OpenSlack workspace path used as the read-only server's working directory. */
  workspaceRoot: string
  /** Absolute built OpenSlack CLI JavaScript module; no command text is accepted. */
  cliModule: string
  /** Positive per-call MCP timeout in milliseconds. */
  timeoutMs: number
  runtimeEntries: string
}

/** Missing configuration fails before a subprocess starts. */
export const Config: z<Config> = z.object({
  workspaceRoot: z.string().required(), cliModule: z.string().required(),
  timeoutMs: z.number().min(1).required(), runtimeEntries: z.string().required(),
})

/** Mount the original MCP client with exactly the read-only profile and no automatic reconnect. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  assertRuntimeBindings(config.runtimeEntries, import.meta.resolve)
  if (!isAbsolute(config.workspaceRoot) || !isAbsolute(config.cliModule) ||
    !statSync(config.workspaceRoot).isDirectory() || !statSync(config.cliModule).isFile() ||
    !config.cliModule.endsWith('.js') || !Number.isSafeInteger(config.timeoutMs)) {
    throw new Error('OpenSlack read-only connection requires a native workspace and built CLI module')
  }
  await ctx.plugin(Connection, { mode: 'read-only', workspaceRoot: config.workspaceRoot,
    cliModule: config.cliModule, timeoutMs: config.timeoutMs })
}
