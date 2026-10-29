/** Exact public ESM identities fixed by the trusted OpenSlack deployment. */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const RUNTIME_PEERS = ['@deepseek-ai/schemastery', '@deepseek-ai/cordis', '@deepseek-ai/dsh-sdk-protocol',
  '@deepseek-ai/dsh-sdk-jsonrpc-server', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-mcp-client', '@modelcontextprotocol/client', '@modelcontextprotocol/client/stdio'] as const

export function assertRuntimeBindings(serialized: string, lookup: (specifier: string) => string): void {
  const entries: unknown = JSON.parse(serialized)
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length !== RUNTIME_PEERS.length) {
    throw new Error('Missing exact approved Harness runtime identities')
  }
  for (const name of RUNTIME_PEERS) {
    const expected: unknown = entries[name as keyof typeof entries]
    const actual = fileURLToPath(lookup(name))
    if (typeof expected !== 'string' || !expected ||
      (process.platform === 'win32' ? resolve(actual).toLowerCase() !== resolve(expected).toLowerCase() : resolve(actual) !== resolve(expected))) {
      throw new Error(`External plugin resolved an unapproved runtime peer: ${name}`)
    }
  }
}
