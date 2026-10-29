/** Public-API-only, read-only capacity prediction; it never refreshes the native observation policy. */
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BRIDGE_MESSAGE_MAX_BYTES } from '@openslack/agent-runtime/internal/bridge-wire'

export const TEXT_LIMIT_BYTES = 1024 * 1024
const RESULT_MARGIN_BYTES = 64 * 1024
export interface NativeEvidencePreview { version?: FsVersion; targetPath: string; maxResultBytes: number }
/** Host-supplied denial constraint, not a task grant or a model-selectable claim mode. */
export type HarnessEligibilityRestriction = Readonly<{ mode: 'required'; expiresAt: number } | { mode: 'not_applicable' }>

/** Validate private host ACK data independently of any execution-authorization handle. */
export function readEligibilityRestriction(value: unknown): HarnessEligibilityRestriction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing live OpenSlack eligibility restriction')
  const keys = Object.keys(value).sort().join(',')
  if ('mode' in value && value.mode === 'not_applicable' && keys === 'mode') return Object.freeze({ mode: 'not_applicable' })
  if ('mode' in value && value.mode === 'required' && keys === 'expiresAt,mode' && 'expiresAt' in value &&
    typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && Date.now() < value.expiresAt) {
    return Object.freeze({ mode: 'required', expiresAt: value.expiresAt })
  }
  throw new Error('Live OpenSlack eligibility restriction is missing or its lease expired')
}

export function assertEligibilityRestriction(value: HarnessEligibilityRestriction): void {
  readEligibilityRestriction(value)
}

function text(value: unknown): value is string { return typeof value === 'string' && Buffer.byteLength(value) <= TEXT_LIMIT_BYTES }
function normalized(value: string): string { return value.replaceAll('\r\n', '\n') }
function refuse(): never { throw new Error('OpenSlack cannot prove this tool evidence fits the approved capacity') }

/** Count expansion before allocating; this independent implementation follows the public literal-edit contract. */
export function previewLiteralEdit(before: string, oldText: string, newText: string, replaceAll: boolean): string {
  if (!text(before) || !text(oldText) || !text(newText)) refuse()
  const source = normalized(before), oldValue = normalized(oldText), newValue = normalized(newText)
  if (!oldValue || oldValue === newValue) refuse()
  let matches = 0, offset = 0
  while (offset <= source.length) {
    const found = source.indexOf(oldValue, offset)
    if (found < 0) break
    matches++
    offset = found + oldValue.length
  }
  if (!matches || (!replaceAll && matches !== 1)) refuse()
  const bytes = Buffer.byteLength(source) - matches * Buffer.byteLength(oldValue) + matches * Buffer.byteLength(newValue)
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > TEXT_LIMIT_BYTES) refuse()
  const proposed = source.split(oldValue).join(newValue)
  // CRLF restoration is backend-owned; use a conservative raw-storage upper bound.
  if (before.includes('\r\n') && bytes + (proposed.match(/\n/g)?.length ?? 0) > TEXT_LIMIT_BYTES) refuse()
  return proposed
}

/** Preview only through public FS reads and pure public tool projections. No execute(), fs/observed or new intent. */
export async function previewNativeEvidence(ctx: Context, definition: ToolDefinition, input: Record<string, unknown>,
  exec: ToolRunContext, target: FsTarget, toolName: 'read' | 'write' | 'edit', current: () => void): Promise<NativeEvidencePreview> {
  current()
  const first = await ctx.fs.stat(target, exec.signal)
  current()
  if (first && (first.type !== 'file' || (first.size !== undefined && first.size > TEXT_LIMIT_BYTES))) refuse()
  let before: string | undefined
  if (first) {
    const stream = await ctx.fs.streamText(target, exec.signal)
    current()
    const parts: string[] = []
    let bytes = 0
    for await (const part of stream) {
      current()
      bytes += Buffer.byteLength(part)
      if (bytes > TEXT_LIMIT_BYTES || parts.length >= 16384) refuse()
      parts.push(part)
    }
    before = parts.join('')
  }
  const second = await ctx.fs.stat(target, exec.signal)
  current()
  if (first?.version !== second?.version || first?.type !== second?.type) refuse()
  const path = ctx.fs.processPath(target)
  let budget: number
  if (toolName === 'read') {
    // Three public representations (canonical lines, Native content, metadata),
    // with bounded line headers. A tighter profile may use less, never more.
    const limit = input.limit === undefined ? 2000 : input.limit
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 2000) refuse()
    const source = before ?? ''
    budget = 3 * Buffer.byteLength(JSON.stringify(source)) + (limit as number) * (256 + Buffer.byteLength(path)) + RESULT_MARGIN_BYTES
  } else {
    let after: string
    if (toolName === 'write') {
      if (!text(input.content)) refuse()
      after = normalized(input.content)
    } else {
      if (before === undefined || !text(input.old_string) || !text(input.new_string) ||
        (input.replace_all !== undefined && typeof input.replace_all !== 'boolean')) refuse()
      after = previewLiteralEdit(before, input.old_string, input.new_string, input.replace_all === true)
    }
    const beforeText = before === undefined ? undefined : normalized(before)
    // Reject a conservatively large diff before invoking the public presentation
    // function: path repetition across many hunks must not allocate unboundedly.
    const lineCount = beforeText === after || beforeText === undefined ? 0 :
      (beforeText.match(/\n/g)?.length ?? 0) + (after.match(/\n/g)?.length ?? 0) + 2
    const coarse = Buffer.byteLength(JSON.stringify(beforeText ?? null)) * 2 + Buffer.byteLength(JSON.stringify(after)) * 2 +
      lineCount * (Buffer.byteLength(JSON.stringify(path)) + 256) + RESULT_MARGIN_BYTES
    if (coarse > BRIDGE_MESSAGE_MAX_BYTES) refuse()
    const variants: Array<Record<string, string | null>> = toolName === 'write'
      ? [{ path, operation: before === undefined ? 'create' : 'update', before: beforeText ?? null, after },
        { path, operation: before === undefined ? 'create' : 'update', before: null, after }]
      : [{ path, before: beforeText!, after }]
    budget = Math.max(...variants.map(value => {
      const content = definition.output.render(input, value)
      const meta = definition.output.presentationMeta?.(input, value)
      return Buffer.byteLength(JSON.stringify({ value, content, ...(meta === undefined ? {} : { meta }) })) + RESULT_MARGIN_BYTES
    }))
  }
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > BRIDGE_MESSAGE_MAX_BYTES) refuse()
  return { ...(first ? { version: first.version } : {}), targetPath: path, maxResultBytes: budget }
}

/** Keep Write and Edit's different public intent shapes intact. */
export function assertPreviewIntent(preview: NativeEvidencePreview, intent: unknown, edit: boolean): void {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) refuse()
  if (edit) {
    if (preview.version === undefined || !('version' in intent) || intent.version !== preview.version) refuse()
  } else if (preview.version === undefined) {
    if (!('kind' in intent) || intent.kind !== 'createIfAbsent') refuse()
  } else if (!('kind' in intent) || intent.kind !== 'replaceIfVersion' || !('version' in intent) || intent.version !== preview.version) refuse()
}
