import { getReviewedHarnessToolCatalog } from '@openslack/qoder-adapter/internal/harness-tool-catalog'

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error('Reviewed OpenSlack tool schema exceeds its bound')
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key], depth + 1)]))
  return value
}

/** Extra tools never become capabilities; only uniquely present reviewed schemas pass. */
export function selectReviewedTools<T extends { name: string; inputSchema: unknown }>(tools: readonly T[], mode: 'read-only' | 'task'): readonly T[] {
  const expected = new Map(getReviewedHarnessToolCatalog(mode).map(tool => [tool.name as string, tool]))
  const selected = new Map<string, T>()
  for (const tool of tools) {
    const contract = expected.get(tool.name)
    if (!contract) continue
    if (selected.has(tool.name)) throw new Error('Required OpenSlack tool is duplicated')
    const encoded = JSON.stringify(tool.inputSchema)
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 64 * 1024 ||
      JSON.stringify(canonical(tool.inputSchema)) !== JSON.stringify(canonical(contract.inputSchema))) throw new Error('Reviewed OpenSlack tool schema changed')
    selected.set(tool.name, tool)
  }
  if (selected.size !== expected.size) throw new Error('Required OpenSlack tool is missing')
  return Object.freeze([...expected.keys()].map(name => selected.get(name)!))
}
