import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { parseManifest, validateManifest, computeManifestHash } from './manifest.js'
import { getEmbeddedBuiltin, listEmbeddedBuiltins } from './embedded-builtins.js'
import type {
  WorkflowMeta,
  WorkflowFormat,
  WorkflowModule,
  WorkflowSource,
} from './types.js'

/**
 * Ordered discovery paths for workflow files.
 * Later entries have lower priority (earlier match wins).
 */
export const DISCOVERY_PATHS = [
  '.openslack/workflows',       // project-local TypeScript
  '.claude/workflows',          // Anthropic-compatible legacy
] as const

/**
 * Built-in workflows shipped with @openslack/workflows.
 */
const BUILTINS_DIR = join(import.meta.dirname, 'builtins')

export function resolveBuiltinTemplatesDir(): string | undefined {
  const candidates = [
    resolve(import.meta.dirname, '..', '..', '..', 'templates', 'workflows'),
    join(dirname(process.execPath), 'assets', 'workflows'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

/**
 * Map a discovery directory to its WorkflowSource label.
 */
function sourceForDir(dir: string, cwd: string): WorkflowSource {
  if (dir === resolve(cwd, '.openslack/workflows')) return 'openslack-project'
  if (dir === resolve(cwd, '.claude/workflows')) return 'claude-project'
  if (dir === join(homedir(), '.claude', 'workflows')) return 'claude-user'
  if (dir === BUILTINS_DIR) return 'builtin'
  return 'builtin' // fallback
}

/**
 * Check whether a filename has a supported workflow extension (.ts, .js, .mjs).
 */
function hasWorkflowExtension(entry: string): boolean {
  return entry.endsWith('.ts') || entry.endsWith('.js') || entry.endsWith('.mjs')
}

/**
 * Strip the workflow extension from a filename.
 */
function stripWorkflowExtension(entry: string): string {
  return entry.replace(/\.(ts|js|mjs)$/, '')
}

/**
 * Discover all available workflow names across discovery paths.
 * Returns an array of { name, path, source } objects, deduplicated by name
 * (first discovery path wins).
 */
export async function discoverWorkflows(
  cwd: string = process.cwd(),
): Promise<Array<{ name: string; path: string; source: WorkflowSource }>> {
  const seen = new Set<string>()
  const results: Array<{ name: string; path: string; source: WorkflowSource }> = []

  for (const relPath of DISCOVERY_PATHS) {
    const dir = resolve(cwd, relPath)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue // directory doesn't exist, skip
    }

    for (const entry of entries) {
      if (!hasWorkflowExtension(entry)) continue

      const name = stripWorkflowExtension(entry)
      if (seen.has(name)) continue
      seen.add(name)

      results.push({ name, path: join(dir, entry), source: sourceForDir(dir, cwd) })
    }
  }

  // Discover user-home workflows (~/.claude/workflows)
  const homeClaudeDir = join(homedir(), '.claude', 'workflows')
  try {
    const entries = await readdir(homeClaudeDir)
    for (const entry of entries) {
      if (!hasWorkflowExtension(entry)) continue

      const name = stripWorkflowExtension(entry)
      if (seen.has(name)) continue
      seen.add(name)

      results.push({ name, path: join(homeClaudeDir, entry), source: 'claude-user' })
    }
  } catch {
    // home workflows dir doesn't exist, that's fine
  }

  // Also discover built-in workflows
  for (const builtin of listEmbeddedBuiltins()) {
    if (seen.has(builtin.name)) continue
    seen.add(builtin.name)
    results.push({ name: builtin.name, path: builtin.path, source: 'builtin' })
  }

  // Source checkouts may contain additional development-only built-ins.
  try {
    const entries = await readdir(BUILTINS_DIR)
    for (const entry of entries) {
      if (!hasWorkflowExtension(entry)) continue
      const name = stripWorkflowExtension(entry)
      if (seen.has(name)) continue
      seen.add(name)
      results.push({ name, path: join(BUILTINS_DIR, entry), source: 'builtin' })
    }
  } catch {
    // builtins dir doesn't exist yet, that's fine
  }

  return results
}

/**
 * Load a workflow module from a file path.
 * Performs static analysis before module import, then detects format.
 * For claude-ambient workflows, returns source without importing.
 */
export async function loadWorkflow(filePath: string): Promise<WorkflowModule> {
  const embedded = getEmbeddedBuiltin(filePath)
  if (embedded) {
    const errors = validateManifest(embedded.meta)
    if (errors.length > 0) {
      throw new Error(`Invalid embedded workflow manifest in ${filePath}:\n${errors.join('\n')}`)
    }
    return {
      ...embedded,
      format: detectFormat(embedded as unknown as Record<string, unknown>),
      hash: computeManifestHash(embedded.meta),
    }
  }

  // Step 1: Read file and compute hash
  const source = await readFile(filePath, 'utf-8')
  const hash = computeFileHash(source)

  // Step 2: Static analysis — extract meta without executing module code
  const meta = analyzeStaticMeta(source)

  // Step 3: Validate extracted meta
  const errors = validateManifest(meta)
  if (errors.length > 0) {
    throw new Error(`Invalid workflow manifest in ${filePath}:\n${errors.join('\n')}`)
  }

  // Step 4: Detect format from source text BEFORE importing
  const sourceFormat = detectFormatFromSource(source)

  if (sourceFormat === 'claude-ambient') {
    return { meta, format: 'claude-ambient', hash, sourceBody: source }
  }

  // Step 5: Dynamic import (only after static analysis passes, and not claude-ambient)
  const resolvedPath = resolve(filePath)
  const moduleUrl = pathToFileURL(resolvedPath).href
  const mod = await import(moduleUrl) as Record<string, unknown>

  // Step 6: Detect format from module exports
  const format = detectFormat(mod)

  if (format === 'invalid') {
    throw new Error(
      `Workflow ${filePath} has invalid format: must export "meta" and at least one of "preview" or "run"`,
    )
  }

  return {
    meta,
    preview: typeof mod.preview === 'function'
      ? mod.preview as WorkflowModule['preview']
      : undefined,
    run: typeof mod.run === 'function'
      ? mod.run as WorkflowModule['run']
      : undefined,
    format,
    hash,
  }
}

/**
 * Detect the format of a workflow module from its exports.
 */
export function detectFormat(
  module: Record<string, unknown>,
): WorkflowFormat {
  const hasMeta = typeof module.meta === 'object' && module.meta !== null
  const hasPreview = typeof module.preview === 'function'
  const hasRun = typeof module.run === 'function'

  if (hasMeta && (hasPreview || hasRun)) return 'openslack-native'
  if (hasMeta) return 'anthropic-compatible'
  return 'invalid'
}

/**
 * Detect workflow format from source text (no import needed).
 *
 * Logic:
 * - No meta export -> "invalid"
 * - meta + "export function preview" or "export function run" -> "openslack-native"
 * - meta + top-level usage of DSL globals after meta object -> "claude-ambient"
 * - meta only -> "anthropic-compatible"
 */
export function detectFormatFromSource(source: string): WorkflowFormat {
  // Check for meta export
  const metaExportPattern = /export\s+const\s+meta\s*(?::\s*\w+)?\s*=/m
  if (!metaExportPattern.test(source)) return 'invalid'

  // Check for export function preview or run
  if (/export\s+(?:async\s+)?function\s+preview\b/m.test(source)) return 'openslack-native'
  if (/export\s+(?:async\s+)?function\s+run\b/m.test(source)) return 'openslack-native'

  // Find where the meta object ends, then check remaining source for ambient usage
  const metaMatch = source.match(metaExportPattern)!
  const metaStartIdx = metaMatch.index! + metaMatch[0].length

  // Find the end of the meta object literal (balanced braces)
  const metaEnd = findBalancedEnd(source, metaStartIdx, '{', '}')
  if (metaEnd === null) {
    // Can't determine meta boundaries; treat as anthropic-compatible
    return 'anthropic-compatible'
  }

  const afterMeta = source.slice(metaEnd + 1)
  if (hasAmbientDslUsage(afterMeta)) return 'claude-ambient'

  return 'anthropic-compatible'
}

/**
 * Find the closing index of a balanced delimiter pair starting at startIdx.
 */
function findBalancedEnd(
  source: string,
  startIdx: number,
  open: string,
  close: string,
): number | null {
  let depth = 0
  let i = startIdx
  let inString: string | null = null
  let escaped = false

  while (i < source.length) {
    const ch = source[i]

    if (escaped) {
      escaped = false
      i++
      continue
    }

    if (ch === '\\') {
      escaped = true
      i++
      continue
    }

    if (inString) {
      if (ch === inString) inString = null
      i++
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      i++
      continue
    }

    if (ch === open) depth++
    if (ch === close) {
      depth--
      if (depth === 0) return i
    }
    i++
  }

  return null
}

/**
 * Check whether source text after the meta export contains top-level usage of
 * Claude Code DSL globals (phase/log/agent/parallel/pipeline/await) that are
 * NOT inside an export function body.
 *
 * Heuristic: strip out all "export function ..." and "export async function ..."
 * blocks, then look for bare await / DSL global calls at the top level.
 */
function hasAmbientDslUsage(afterMeta: string): boolean {
  // Remove all export function bodies (balanced braces after export function ... {)
  const stripped = stripExportFunctions(afterMeta)

  // DSL globals that indicate ambient usage
  const dslGlobals = /\b(?:phase|log|agent|parallel|pipeline)\s*\(/

  // Top-level await statements
  const topLevelAwait = /(?:^|\n)\s*await\s+/m

  // Top-level const/let/var with DSL globals
  const topLevelDslAssign = /(?:^|\n)\s*(?:const|let|var)\s+.*\b(?:phase|log|agent|parallel|pipeline)\s*\(/m

  if (dslGlobals.test(stripped) || topLevelAwait.test(stripped) || topLevelDslAssign.test(stripped)) {
    return true
  }

  return false
}

/**
 * Strip export function bodies from source text so we can detect top-level
 * statements only. Removes content inside balanced braces following
 * "export function ..." declarations.
 */
function stripExportFunctions(source: string): string {
  // Match "export [async] function <name>(...) {" and remove the body
  const pattern = /export\s+(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/g
  let match: RegExpExecArray | null

  // We need to iteratively find and strip function bodies
  const segments: Array<{ start: number; end: number }> = []
  pattern.lastIndex = 0

  while ((match = pattern.exec(source)) !== null) {
    const braceStart = match.index + match[0].length - 1
    const braceEnd = findBalancedEnd(source, braceStart, '{', '}')
    if (braceEnd !== null) {
      segments.push({ start: match.index, end: braceEnd + 1 })
    }
  }

  // Build result excluding function bodies (replace with spaces to preserve offsets)
  if (segments.length === 0) return source
  let rebuilt = ''
  let lastEnd = 0
  for (const seg of segments) {
    rebuilt += source.slice(lastEnd, seg.start)
    rebuilt += ' ' // placeholder
    lastEnd = seg.end
  }
  rebuilt += source.slice(lastEnd)
  return rebuilt
}

/**
 * Perform static analysis on workflow source text to extract the meta object.
 * Extracts the `export const meta = { ... }` literal without executing code.
 *
 * IMPORTANT: This function must NOT fall back to executing the module.
 * If the meta cannot be extracted statically, it throws.
 */
export function analyzeStaticMeta(source: string): WorkflowMeta {
  // Try to extract `export const meta = { ... }` or `export const meta: WorkflowMeta = { ... }`
  const metaExportPattern = /export\s+const\s+meta\s*(?::\s*\w+)?\s*=\s*/m
  const match = source.match(metaExportPattern)

  if (!match) {
    throw new Error(
      'Cannot extract workflow meta: no "export const meta = ..." found in source. ' +
      'Meta must be a pure object literal export.',
    )
  }

  const startIdx = match.index! + match[0].length
  const jsonObject = extractObjectLiteral(source, startIdx)

  if (jsonObject === null) {
    throw new Error(
      'Cannot extract workflow meta: the exported meta is not a pure object literal. ' +
      'Computed property names, function calls, or external references are not allowed.',
    )
  }

  // Validate it's JSON-parseable (no function calls, no computed keys)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonObject)
  } catch {
    throw new Error(
      'Cannot extract workflow meta: the object literal is not JSON-parseable. ' +
      'Only JSON-serializable values are allowed in meta.',
    )
  }

  return parseManifest(parsed)
}

/**
 * Extract a balanced-brace object literal from source starting at position.
 * Returns the raw string of the object, or null if it cannot be extracted.
 * Checks for computed property names and other non-literal constructs.
 */
function extractObjectLiteral(source: string, startIdx: number): string | null {
  if (source[startIdx] !== '{') return null

  const raw = extractBalanced(source, startIdx, '{', '}')
  if (raw === null) return null

  // Check for computed property names: `[` used as key (not inside strings)
  // We look for patterns like: { [expr]: ... } which is distinct from arrays
  if (hasComputedPropertyNames(raw)) return null

  // Convert JS object literal to valid JSON
  return jsObjectToJson(raw)
}

/**
 * Extract balanced delimiters from source starting at a position.
 */
function extractBalanced(
  source: string,
  startIdx: number,
  open: string,
  close: string,
): string | null {
  let depth = 0
  let i = startIdx
  let inString: string | null = null
  let escaped = false

  while (i < source.length) {
    const ch = source[i]

    if (escaped) {
      escaped = false
      i++
      continue
    }

    if (ch === '\\') {
      escaped = true
      i++
      continue
    }

    if (inString) {
      if (ch === inString) inString = null
      i++
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      i++
      continue
    }

    if (ch === open) depth++
    if (ch === close) {
      depth--
      if (depth === 0) {
        return source.slice(startIdx, i + 1)
      }
    }
    i++
  }

  return null
}

/**
 * Check if a JS object literal string contains computed property names.
 * Computed property names look like: { [expr]: value }
 * We need to distinguish this from normal array usage like [1, 2, 3].
 */
function hasComputedPropertyNames(js: string): boolean {
  // Look for `[` that appears after a newline/comma/`{` and before `]:`
  // This indicates a computed property name
  const computedPattern = /[{,]\s*\[.*?\]\s*:/
  return computedPattern.test(js)
}

/**
 * Best-effort conversion of a JS object literal to JSON.
 * Handles: unquoted keys, trailing commas, single-quoted strings.
 */
function jsObjectToJson(js: string): string | null {
  // Tokenize and rebuild as JSON
  const tokens = tokenizeJs(js)
  if (tokens === null) return null

  let result = ''
  let i = 0

  while (i < tokens.length) {
    const token = tokens[i]

    if (token.type === 'string') {
      result += '"' + token.value + '"'
    } else if (token.type === 'word') {
      // Check if this word is an object key (next meaningful token is `:`)
      let nextIdx = i + 1
      while (nextIdx < tokens.length && tokens[nextIdx].type === 'whitespace') nextIdx++
      if (nextIdx < tokens.length && tokens[nextIdx].type === 'colon') {
        // It's an unquoted key
        result += '"' + token.value + '"'
      } else {
        // It's a bare identifier like true, false, null, undefined
        if (token.value === 'true' || token.value === 'false' || token.value === 'null') {
          result += token.value
        } else {
          return null // unknown identifier, not JSON-safe
        }
      }
    } else if (token.type === 'comma') {
      // Look ahead for trailing comma before } or ]
      let nextIdx = i + 1
      while (nextIdx < tokens.length && tokens[nextIdx].type === 'whitespace') nextIdx++
      if (nextIdx < tokens.length && (tokens[nextIdx].value === '}' || tokens[nextIdx].value === ']')) {
        // Skip trailing comma
      } else {
        result += ','
      }
    } else if (token.type === 'whitespace') {
      result += ' '
    } else {
      result += token.value
    }
    i++
  }

  return result
}

interface Token {
  type: 'string' | 'word' | 'whitespace' | 'comma' | 'colon' | 'other'
  value: string
}

/**
 * Tokenize a JS object literal into simple tokens.
 */
function tokenizeJs(js: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0

  while (i < js.length) {
    const ch = js[i]

    // Whitespace
    if (/\s/.test(ch)) {
      let end = i
      while (end < js.length && /\s/.test(js[end])) end++
      tokens.push({ type: 'whitespace', value: js.slice(i, end) })
      i = end
      continue
    }

    // Single-line comment
    if (ch === '/' && js[i + 1] === '/') {
      let end = i
      while (end < js.length && js[end] !== '\n') end++
      // Treat comment as whitespace
      tokens.push({ type: 'whitespace', value: ' ' })
      i = end
      continue
    }

    // Multi-line comment
    if (ch === '/' && js[i + 1] === '*') {
      let end = i + 2
      while (end < js.length && !(js[end] === '*' && js[end + 1] === '/')) end++
      tokens.push({ type: 'whitespace', value: ' ' })
      i = end + 2
      continue
    }

    // String literal
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      let content = ''
      i++ // skip opening quote
      while (i < js.length) {
        const c = js[i]
        if (c === '\\' && i + 1 < js.length) {
          // Handle escape sequences
          const next = js[i + 1]
          if (next === 'n') { content += '\n'; i += 2; continue }
          if (next === 't') { content += '\t'; i += 2; continue }
          if (next === 'r') { content += '\r'; i += 2; continue }
          if (next === '\\') { content += '\\'; i += 2; continue }
          if (next === quote) { content += quote; i += 2; continue }
          if (next === '"') { content += '"'; i += 2; continue }
          // Unknown escape — not JSON-safe
          content += c + next
          i += 2
          continue
        }
        if (c === quote) {
          i++ // skip closing quote
          break
        }
        // Template literal interpolation
        if (c === '$' && quote === '`' && js[i + 1] === '{') {
          return null
        }
        content += c
        i++
      }
      tokens.push({ type: 'string', value: content })
      continue
    }

    // Word (identifier)
    if (/[a-zA-Z_$]/.test(ch)) {
      let end = i
      while (end < js.length && /[a-zA-Z0-9_$]/.test(js[end])) end++
      tokens.push({ type: 'word', value: js.slice(i, end) })
      i = end
      continue
    }

    // Comma
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ',' })
      i++
      continue
    }

    // Colon
    if (ch === ':') {
      tokens.push({ type: 'colon', value: ':' })
      i++
      continue
    }

    // Everything else (brackets, numbers, etc.)
    tokens.push({ type: 'other', value: ch })
    i++
  }

  return tokens
}

/**
 * Find a single workflow by name across discovery paths and builtins.
 * Returns the { name, path, source } entry or undefined if not found.
 */
export async function findWorkflow(
  name: string,
  cwd: string = process.cwd(),
): Promise<{ name: string; path: string; source: WorkflowSource } | undefined> {
  const all = await discoverWorkflows(cwd)
  return all.find((w) => w.name === name)
}

/**
 * Categorized workflow summary for listing purposes.
 */
export interface WorkflowSummary {
  /** Workflow name / ID */
  name: string
  /** Display name from manifest (JS modules) or template name (YAML) */
  displayName: string
  /** Source type / where the workflow was discovered */
  source: 'yaml-template' | 'js-module' | import('./types.js').WorkflowSource
  /** Number of phases */
  phases: number
  /** Number of inputs (YAML templates) or 0 (JS modules) */
  inputs: number
  /** File basename */
  file: string
  /** Description (JS modules only) */
  description?: string
  /** Format (JS modules only) */
  format?: WorkflowFormat
}

/**
 * Discover all YAML workflow templates from a directory.
 * Used by the CLI to list built-in templates alongside JS modules.
 */
export async function discoverYamlTemplates(
  templatesDir: string,
): Promise<WorkflowSummary[]> {
  const results: WorkflowSummary[] = []

  let entries: string[]
  try {
    entries = await readdir(templatesDir)
  } catch {
    return results
  }

  for (const entry of entries) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue

    const filePath = join(templatesDir, entry)
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      continue
    }

    // Minimal parse to extract id, name, phases, inputs
    const template = parseYamlMinimal(content)
    if (!template) continue

    results.push({
      name: template.id ?? entry.replace(/\.ya?ml$/, ''),
      displayName: template.name ?? template.id ?? entry,
      source: 'yaml-template',
      phases: Array.isArray(template.phases) ? template.phases.length : 0,
      inputs: Array.isArray(template.inputs) ? template.inputs.length : 0,
      file: entry,
    })
  }

  return results
}

/**
 * Discover all JS/TS workflow modules and return categorized summaries.
 */
export async function discoverJsWorkflows(
  cwd: string = process.cwd(),
): Promise<WorkflowSummary[]> {
  const discovered = await discoverWorkflows(cwd)
  const results: WorkflowSummary[] = []

  for (const { name, path: filePath, source: wfSource } of discovered) {
    let meta: WorkflowMeta
    let sourceText: string
    try {
      const embedded = getEmbeddedBuiltin(filePath)
      if (embedded) {
        meta = embedded.meta
        sourceText = ''
      } else {
        sourceText = await readFile(filePath, 'utf-8')
        meta = analyzeStaticMeta(sourceText)
      }
    } catch {
      // Skip modules that fail static analysis
      continue
    }

    const embedded = getEmbeddedBuiltin(filePath)
    const format = embedded
      ? detectFormat(embedded as unknown as Record<string, unknown>)
      : detectFormatFromSource(sourceText)
    const ext = filePath.endsWith('.ts') ? '.ts' : filePath.endsWith('.mjs') ? '.mjs' : '.js'
    results.push({
      name,
      displayName: meta.name,
      source: wfSource,
      phases: meta.phases.length,
      inputs: Object.keys(meta.inputs ?? {}).length,
      file: `${name}${ext}`,
      description: meta.description,
      format,
    })
  }

  return results
}

/**
 * Minimal YAML parse for workflow template listing.
 * Extracts id, name, phases count, inputs count without full validation.
 */
function parseYamlMinimal(content: string): {
  id?: string
  name?: string
  phases?: unknown[]
  inputs?: unknown[]
} | null {
  // Quick regex extraction to avoid a full YAML parser dependency
  // in the workflows package (which doesn't depend on 'yaml')
  const idMatch = content.match(/^id:\s*(.+)$/m)
  const nameMatch = content.match(/^name:\s*(.+)$/m)

  // Count phases by looking for "  - name:" patterns under phases:
  let phasesCount = 0
  const phasesMatch = content.match(/^phases:\s*$/m)
  if (phasesMatch) {
    const phasesStart = phasesMatch.index! + phasesMatch[0].length
    const phasesSection = content.slice(phasesStart)
    // Count top-level phase entries (lines starting with "  - name:")
    const phaseEntries = phasesSection.match(/^\s+- name:/gm)
    phasesCount = phaseEntries ? phaseEntries.length : 0
  }

  // Count inputs
  let inputsCount = 0
  const inputsMatch = content.match(/^inputs:\s*$/m)
  if (inputsMatch) {
    const inputsStart = inputsMatch.index! + inputsMatch[0].length
    const inputsSection = content.slice(inputsStart)
    // Stop at next top-level key
    const nextKeyMatch = inputsSection.match(/^\w/m)
    const relevantSection = nextKeyMatch
      ? inputsSection.slice(0, nextKeyMatch.index)
      : inputsSection
    const inputEntries = relevantSection.match(/^\s+- name:/gm)
    inputsCount = inputEntries ? inputEntries.length : 0
  }

  return {
    id: idMatch?.[1]?.trim(),
    name: nameMatch?.[1]?.trim(),
    phases: Array.from({ length: phasesCount }),
    inputs: Array.from({ length: inputsCount }),
  }
}

/**
 * Compute SHA-256 hash of a file's source content.
 */
function computeFileHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}
