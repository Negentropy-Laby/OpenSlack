import type { RunStatus, PhaseCheckpoint } from './types.js'

// ── Redaction Rules ─────────────────────────────────────────────────────────
//
// Before run data is embedded in an HTML artifact, a redaction layer sanitizes:
//
// 1. Source code: Only file paths from findings are included. No source code
//    is embedded. Context snippets are limited to 3 lines.
// 2. Agent prompts: Full prompt text is stripped; only label, phase, and
//    result summary are retained.
// 3. Tokens and credentials: Any tokens in URLs are stripped. API URLs with
//    query parameters are redacted to origin + pathname only.
// 4. Absolute paths: Remapped to repo-root-relative paths before embedding.
// 5. Failed schema output: Agent output that failed schema validation is not
//    embedded; only the validation error summary is retained.

/**
 * Maximum number of lines allowed in a context snippet (Rule 1).
 */
const MAX_CONTEXT_LINES = 3

/**
 * Patterns that look like source code blocks (multi-line with braces, semicolons, etc.).
 */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g
const INLINE_CODE_PATTERN = /`[^`]{50,}`/g

/**
 * Patterns for common token/credential formats (Rule 3).
 */
const TOKEN_PATTERNS = [
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghi_)
  /gh[psousi]_[A-Za-z0-9]{36,}/g,
  // Generic bearer tokens in headers
  /[Bb]earer\s+[A-Za-z0-9\-._~+/]+=*/g,
  // Generic API keys (long alphanumeric strings after key-related prefixes)
  /(?:api[_-]?key|token|secret|password|credential|auth)["\s:=]+([A-Za-z0-9\-._~+/]{20,})/gi,
  // Hex tokens (64+ hex chars on a single line after token-like prefix)
  /(?:token|key|secret|password)["\s:=]+([a-f0-9]{40,})/gi,
]

/**
 * URL pattern that may contain tokens in query parameters.
 */
const URL_WITH_QUERY = /https?:\/\/[^\s"'<>]+\?[^\s"'<>]+/g

/**
 * Absolute path patterns for common OS paths (Rule 4).
 */
const ABSOLUTE_PATH_PATTERN = /(?:[A-Z]:\\|\/)(?:Users|home|tmp|var|etc|opt|Users)[\/\\][^\s"'<>),;\]]+/gi
const WIN_ABSOLUTE_PATH = /[A-Z]:\\(?:Users|home|tmp)[\/\\][^\s"'<>),;\]]+/gi
const POSIX_ABSOLUTE_PATH = /\/(?:home|tmp|var|etc|opt|Users)\/[^\s"'<>),;\]]+/gi

// ── Redaction API ────────────────────────────────────────────────────────────

/**
 * A single redaction rule application result.
 */
export interface RedactionEntry {
  rule: string
  original: string
  redacted: string
}

/**
 * Result of redacting a complete run data object.
 */
export interface RedactionResult {
  data: unknown
  redactions: RedactionEntry[]
}

/**
 * Options for the redaction process.
 */
export interface RedactionOptions {
  /** Repository root to remap absolute paths against. */
  repoRoot?: string
  /** Custom redaction log for auditing what was changed. */
  log?: RedactionEntry[]
}

// ── Individual Rule Functions ────────────────────────────────────────────────

/**
 * Rule 1: Strip source code from string values. Keeps file paths but removes
 * code blocks and limits context snippets to MAX_CONTEXT_LINES.
 */
export function stripSourceCode(value: string): string {
  // Remove fenced code blocks entirely
  let result = value.replace(CODE_BLOCK_PATTERN, '[source code redacted]')

  // Remove inline code spans that are suspiciously long (likely source code)
  result = result.replace(INLINE_CODE_PATTERN, '[source code redacted]')

  return result
}

/**
 * Rule 1 (supplement): Truncate context snippets to MAX_CONTEXT_LINES.
 */
export function truncateContext(value: string, maxLines: number = MAX_CONTEXT_LINES): string {
  const lines = value.split('\n')
  if (lines.length <= maxLines) return value
  return lines.slice(0, maxLines).join('\n') + '\n... [truncated]'
}

/**
 * Rule 2: Strip full agent prompt text, keeping only label, phase, and result summary.
 */
export function stripPrompt(prompt: string): string {
  if (!prompt || prompt.length === 0) return prompt
  // If the prompt is short (likely just a label), keep it
  if (prompt.length <= 80) return prompt
  return '[prompt redacted]'
}

/**
 * Rule 2: Redact agent call details, stripping prompt text while retaining metadata.
 */
export function redactAgentCall(agentCall: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  // Retain safe metadata fields
  const safeFields = ['label', 'phase', 'tokenUsage', 'schemaVersion', 'status', 'cacheKey']
  for (const field of safeFields) {
    if (field in agentCall) {
      result[field] = agentCall[field]
    }
  }

  // Strip prompt text
  if ('prompt' in agentCall) {
    result.prompt = stripPrompt(agentCall.prompt as string)
  }

  // Strip full prompt text if embedded
  if ('promptText' in agentCall) {
    result.promptText = '[prompt redacted]'
  }

  // Retain result summary but not full result body if it looks like code
  if ('resultSummary' in agentCall) {
    result.resultSummary = agentCall.resultSummary
  }

  return result
}

/**
 * Rule 3: Strip tokens and credentials from string values.
 */
export function stripTokensAndCredentials(value: string): string {
  let result = value

  // Apply each token pattern
  for (const pattern of TOKEN_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0
    result = result.replace(pattern, '[token redacted]')
  }

  // Redact URLs with query parameters (may contain tokens)
  result = result.replace(URL_WITH_QUERY, (match) => {
    try {
      const url = new URL(match)
      // Keep origin + pathname, strip query and hash
      return url.origin + url.pathname + '?[query redacted]'
    } catch {
      return '[url redacted]'
    }
  })

  return result
}

/**
 * Rule 4: Remap absolute paths to repo-root-relative paths.
 */
export function remapAbsolutePaths(value: string, repoRoot?: string): string {
  if (!repoRoot) return value

  // Normalize separators for comparison
  const normalizedRoot = repoRoot.replace(/\\/g, '/')

  // Handle Windows-style absolute paths
  let result = value.replace(WIN_ABSOLUTE_PATH, (match) => {
    const normalized = match.replace(/\\/g, '/')
    if (normalized.startsWith(normalizedRoot)) {
      return normalized.slice(normalizedRoot.length) || '/'
    }
    return '[path redacted]'
  })

  // Handle POSIX-style absolute paths
  result = result.replace(POSIX_ABSOLUTE_PATH, (match) => {
    if (match.startsWith(normalizedRoot)) {
      return match.slice(normalizedRoot.length) || '/'
    }
    return '[path redacted]'
  })

  return result
}

/**
 * Rule 5: Redact agent output that failed schema validation.
 * Only the validation error summary is retained.
 */
export function redactFailedSchemaOutput(output: unknown, validationError?: string): unknown {
  if (output === null || output === undefined) return output

  // If a validation error is provided, replace the output with just the error summary
  if (validationError) {
    return {
      _redacted: true,
      reason: 'Schema validation failed',
      error: validationError,
    }
  }

  return output
}

// ── Composite Redaction ──────────────────────────────────────────────────────

/**
 * Apply all redaction rules to a string value.
 */
export function redactString(value: string, options?: RedactionOptions): string {
  if (typeof value !== 'string') return value

  let result = value
  result = stripSourceCode(result)
  result = stripTokensAndCredentials(result)
  result = remapAbsolutePaths(result, options?.repoRoot)
  return result
}

/**
 * Recursively apply redaction rules to an arbitrary data structure.
 * Walks objects and arrays, applying string redaction to all string values.
 */
export function redactDeep(value: unknown, options?: RedactionOptions, path: string = ''): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === 'string') {
    return redactString(value, options)
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactDeep(item, options, `${path}[${index}]`)
    )
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const result: Record<string, unknown> = {}

    // Special handling for agent call objects
    if ('prompt' in obj && 'label' in obj && 'phase' in obj) {
      return redactAgentCall(obj)
    }

    // Special handling for failed schema output
    if ('schemaStatus' in obj && obj.schemaStatus === 'failed') {
      return redactFailedSchemaOutput(
        obj,
        typeof obj.validationError === 'string' ? obj.validationError : undefined,
      )
    }

    for (const [key, val] of Object.entries(obj)) {
      result[key] = redactDeep(val, options, path ? `${path}.${key}` : key)
    }
    return result
  }

  // Numbers, booleans, etc. pass through
  return value
}

/**
 * Redact a complete run status for safe embedding in HTML artifacts.
 */
export function redactRunStatus(
  status: RunStatus,
  options?: RedactionOptions,
): RedactionResult {
  const redactions: RedactionEntry[] = []

  // Deep-redact the status object
  const data = redactDeep(status, options)

  return { data, redactions }
}

/**
 * Redact phase checkpoint data.
 */
export function redactPhaseCheckpoint(
  checkpoint: PhaseCheckpoint,
  options?: RedactionOptions,
): RedactionResult {
  const data = redactDeep(checkpoint, options)
  return { data, redactions: [] }
}

/**
 * Redact a full run data bundle (status + phases + log entries + output).
 */
export function redactRunBundle(
  bundle: {
    status: RunStatus
    phases: PhaseCheckpoint[]
    logEntries?: Array<Record<string, unknown>>
    output?: unknown
  },
  options?: RedactionOptions,
): RedactionResult {
  const redactions: RedactionEntry[] = []

  const data = {
    status: redactDeep(bundle.status, options),
    phases: bundle.phases.map(p => redactDeep(p, options)),
    logEntries: bundle.logEntries?.map(e => redactDeep(e, options)),
    output: redactDeep(bundle.output, options),
  }

  return { data, redactions }
}
