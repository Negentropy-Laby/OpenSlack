import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertPreviewIntent, assertEligibilityRestriction, readEligibilityRestriction,
  previewLiteralEdit, previewNativeEvidence, TEXT_LIMIT_BYTES } from '../src/scope-evidence.ts'

const target = {} as FsTarget
const exec = { signal: new AbortController().signal } as ToolRunContext
function fixture(content: string | undefined) {
  const stat = vi.fn(async () => content === undefined ? undefined : { type: 'file', version: 'v1', size: Buffer.byteLength(content) })
  const emit = vi.fn()
  const ctx = { emit, fs: { stat, processPath: () => '/workspace/fixture.txt',
    streamText: vi.fn(async () => (async function* () { yield content ?? '' })()) } } as unknown as Context
  const definition: ToolDefinition = { name: 'write', description: '', parameters: {},
    execute: vi.fn(async () => ({})), output: { schema: {}, render: vi.fn((_args, value) => [{ type: 'text', text: JSON.stringify(value) }]),
      presentationMeta: vi.fn(() => ({ fixture: true })) } }
  return { ctx, definition, stat, emit }
}

describe('native pre-effect evidence capacity', () => {
  it('requires an explicit private host restriction and preserves exact expiry as a denial constraint', () => {
    const expiry = Date.now() + 60_000
    const live = readEligibilityRestriction({ mode: 'required', expiresAt: expiry })
    expect(live).toEqual({ mode: 'required', expiresAt: expiry })
    expect(Object.isFrozen(live)).toBe(true)
    expect(readEligibilityRestriction({ mode: 'not_applicable' })).toEqual({ mode: 'not_applicable' })
    for (const value of [undefined, null, {}, { mode: 'required' }, { mode: 'required', expiresAt: 'future' },
      { mode: 'required', expiresAt: Date.now() }, { mode: 'not_applicable', expiresAt: expiry }, { mode: 'unknown' }]) {
      expect(() => readEligibilityRestriction(value)).toThrow(/eligibility restriction|lease expired/)
    }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiry)
    try { expect(() => assertEligibilityRestriction(live)).toThrow(/lease expired/) }
    finally { clock.mockRestore() }
  })

  it('counts replace-all expansion before allocating a prospective terabyte string', () => {
    expect(() => previewLiteralEdit('a'.repeat(TEXT_LIMIT_BYTES), 'a', 'b'.repeat(TEXT_LIMIT_BYTES), true)).toThrow(/capacity/)
    expect(previewLiteralEdit('alpha\r\nbeta\r\n', 'beta\r\n', 'gamma\n', false)).toBe('alpha\ngamma\n')
  })

  it('previews using public streams and pure projections without effects or native observations', async () => {
    const f = fixture('old text')
    const preview = await previewNativeEvidence(f.ctx, f.definition, { file_path: 'fixture.txt', content: 'new text' }, exec, target, 'write', () => {})
    expect(preview).toMatchObject({ version: 'v1', targetPath: '/workspace/fixture.txt' })
    expect(preview.maxResultBytes).toBeGreaterThan(0)
    expect(f.definition.output.render).toHaveBeenCalled()
    expect(f.definition.output.presentationMeta).toHaveBeenCalled()
    expect(f.definition.execute).not.toHaveBeenCalled()
    expect(f.emit).not.toHaveBeenCalled()
  })

  it('rejects drift across the read and a stream that exceeds its initial stat size', async () => {
    const drift = fixture('text')
    drift.stat.mockResolvedValueOnce({ type: 'file', version: 'v1', size: 4 }).mockResolvedValueOnce({ type: 'file', version: 'v2', size: 4 })
    await expect(previewNativeEvidence(drift.ctx, drift.definition, { content: 'new' }, exec, target, 'write', () => {})).rejects.toThrow(/capacity/)
    expect(drift.definition.execute).not.toHaveBeenCalled()
    const growing = fixture('tiny')
    vi.mocked(growing.ctx.fs.streamText).mockResolvedValue((async function* () { yield 'x'.repeat(TEXT_LIMIT_BYTES); yield 'x' })())
    await expect(previewNativeEvidence(growing.ctx, growing.definition, { content: 'new' }, exec, target, 'write', () => {})).rejects.toThrow(/capacity/)
    expect(growing.definition.output.render).not.toHaveBeenCalled()
  })

  it('rejects excessive diff capacity before invoking the public diff projector', async () => {
    const f = fixture(('a\n').repeat(TEXT_LIMIT_BYTES / 2))
    await expect(previewNativeEvidence(f.ctx, f.definition, { content: ('b\n').repeat(TEXT_LIMIT_BYTES / 2) }, exec, target, 'write', () => {})).rejects.toThrow(/capacity/)
    expect(f.definition.output.presentationMeta).not.toHaveBeenCalled()
    expect(f.definition.execute).not.toHaveBeenCalled()
  })

  it('preserves the distinct Write and Edit original CAS intent shapes', () => {
    const preview = { version: 'v1' as FsVersion, targetPath: '/fixture', maxResultBytes: 1 }
    expect(() => assertPreviewIntent(preview, { kind: 'replaceIfVersion', version: 'v1' }, false)).not.toThrow()
    expect(() => assertPreviewIntent(preview, { version: 'v1' }, true)).not.toThrow()
    expect(() => assertPreviewIntent({ targetPath: '/fixture', maxResultBytes: 1 }, { kind: 'createIfAbsent' }, false)).not.toThrow()
    for (const bad of [undefined, { version: 'v2' }, { kind: 'createIfAbsent' }]) expect(() => assertPreviewIntent(preview, bad, true)).toThrow()
    expect(() => assertPreviewIntent(preview, { kind: 'replaceIfVersion', version: 'v2' }, false)).toThrow()
    expect(() => assertPreviewIntent(preview, undefined, false)).toThrow()
  })
})
