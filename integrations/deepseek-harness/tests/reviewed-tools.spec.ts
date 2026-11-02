import { describe, expect, it } from 'vitest'
import { getReviewedHarnessToolCatalog } from '@openslack/qoder-adapter/internal/harness-tool-catalog'
import { selectReviewedTools } from '../src/reviewed-tools.ts'

describe('reviewed native MCP tool subset', () => {
  it.each(['read-only', 'task'] as const)('ignores unreviewed %s additions without widening the exposed catalog', mode => {
    const required = getReviewedHarnessToolCatalog(mode)
    const extra = { name: 'openslack_future_mutation', inputSchema: { type: 'object' } }
    const selected = selectReviewedTools([...required, extra], mode)
    expect(selected.map(tool => tool.name)).toEqual(required.map(tool => tool.name))
    expect(selected).not.toContain(extra)
    if (mode === 'read-only') expect(selected.some(tool => tool.name === 'openslack_confirm_plan')).toBe(false)
  })
  it.each(['missing', 'duplicate', 'schema'] as const)('refuses a %s required tool', fault => {
    const required = getReviewedHarnessToolCatalog('task').map(tool => structuredClone(tool))
    if (fault === 'missing') required.pop()
    if (fault === 'duplicate') required.push(required[0]!)
    if (fault === 'schema') required[0] = { ...required[0]!, inputSchema: { type: 'object', properties: { unreviewed: { type: 'string' } }, additionalProperties: false } }
    expect(() => selectReviewedTools(required, 'task')).toThrow()
  })
});
