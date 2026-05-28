import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  escapeJsonInHtml,
  renderRunHtml,
  renderRunJson,
  renderRunMarkdown,
} from '../html-renderer.js'
import type { RunStatus, PhaseCheckpoint } from '../types.js'

// ── Helper factories ─────────────────────────────────────────────────────────

function makeRunStatus(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    runId: 'run-001',
    workflowName: 'test-workflow',
    mode: 'execute',
    status: 'completed',
    startedAt: '2026-05-28T10:00:00.000Z',
    updatedAt: '2026-05-28T10:05:00.000Z',
    phases: [],
    args: {},
    ...overrides,
  }
}

function makePhaseCheckpoint(overrides: Partial<PhaseCheckpoint> = {}): PhaseCheckpoint {
  return {
    phase: 'scan',
    timestamp: '2026-05-28T10:01:00.000Z',
    status: 'completed',
    ...overrides,
  }
}

// ── escapeHtml ───────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar')
  })

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    )
  })

  it('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;')
  })

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s')
  })

  it('handles strings with no special characters', () => {
    expect(escapeHtml('plain text')).toBe('plain text')
  })

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('')
  })
})

// ── escapeJsonInHtml ─────────────────────────────────────────────────────────

describe('escapeJsonInHtml', () => {
  it('serializes and escapes for safe HTML embedding', () => {
    const data = { message: '<script>alert("xss")</script>' }
    const result = escapeJsonInHtml(data)
    expect(result).not.toContain('<script>')
    expect(result).toContain('&lt;script&gt;')
  })

  it('handles arrays', () => {
    const result = escapeJsonInHtml([1, 2, 3])
    expect(result).toBe('[1,2,3]')
  })

  it('handles null', () => {
    expect(escapeJsonInHtml(null)).toBe('null')
  })
})

// ── renderRunHtml ────────────────────────────────────────────────────────────

describe('renderRunHtml', () => {
  const status = makeRunStatus()
  const phases = [
    makePhaseCheckpoint({ phase: 'scan', status: 'completed' }),
    makePhaseCheckpoint({ phase: 'fix', status: 'completed' }),
    makePhaseCheckpoint({ phase: 'review', status: 'failed' }),
  ]
  const logEntries = [
    { ts: '2026-05-28T10:00:01Z', phase: 'scan', message: 'Scanning files' },
    { ts: '2026-05-28T10:01:00Z', phase: 'fix', message: 'Fixing issues' },
  ]
  const output = { findings: ['bug1', 'bug2'], fixed: 2 }

  it('produces a valid HTML document', () => {
    const html = renderRunHtml(status, phases, logEntries, output)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html')
    expect(html).toContain('</html>')
    expect(html).toContain('<head>')
    expect(html).toContain('</head>')
    expect(html).toContain('<body>')
    expect(html).toContain('</body>')
  })

  it('includes CSP meta tag', () => {
    const html = renderRunHtml(status, phases, logEntries, output)
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'none'")
    expect(html).toContain("default-src 'none'")
  })

  it('includes inline CSS', () => {
    const html = renderRunHtml(status, phases, logEntries, output)
    expect(html).toContain('<style>')
    expect(html).toContain('</style>')
  })

  it('contains no <script> tags', () => {
    const html = renderRunHtml(status, phases, logEntries, output)
    expect(html).not.toMatch(/<script[\s>]/i)
  })

  it('includes run metadata', () => {
    const html = renderRunHtml(status, phases, logEntries, output)
    expect(html).toContain('run-001')
    expect(html).toContain('test-workflow')
    expect(html).toContain('completed')
  })

  it('includes phases table', () => {
    const html = renderRunHtml(status, phases, logEntries, output)
    expect(html).toContain('scan')
    expect(html).toContain('fix')
    expect(html).toContain('review')
  })

  it('includes log entries when enabled', () => {
    const html = renderRunHtml(status, phases, logEntries, output, { includeLog: true })
    expect(html).toContain('Scanning files')
    expect(html).toContain('Fixing issues')
  })

  it('excludes log entries when disabled', () => {
    const html = renderRunHtml(status, phases, logEntries, output, { includeLog: false })
    expect(html).not.toContain('Scanning files')
  })

  it('includes output section when enabled', () => {
    const html = renderRunHtml(status, phases, logEntries, output, { includeOutput: true })
    expect(html).toContain('findings')
  })

  it('excludes output section when disabled', () => {
    const html = renderRunHtml(status, phases, logEntries, output, { includeOutput: false })
    // The output JSON should not be in the body (the word "findings" appears in meta, but not the output section)
    expect(html).not.toContain('<h2>Output</h2>')
  })

  it('XSS-escapes data with HTML characters', () => {
    const maliciousStatus = makeRunStatus({
      workflowName: '<script>alert("xss")</script>',
    })
    const html = renderRunHtml(maliciousStatus, [], [], null)
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  it('handles empty phases gracefully', () => {
    const html = renderRunHtml(makeRunStatus(), [], [], null)
    expect(html).toContain('No phases recorded')
  })

  it('handles null output gracefully', () => {
    const html = renderRunHtml(makeRunStatus(), [], [], null)
    expect(html).toContain('No output recorded')
  })

  it('applies redaction to tokens in data', () => {
    const logWithToken = [
      { ts: '2026-05-28T10:00:01Z', phase: 'scan', message: 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
    ]
    const html = renderRunHtml(status, [], logWithToken, null)
    expect(html).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')
  })
})

// ── renderRunJson ────────────────────────────────────────────────────────────

describe('renderRunJson', () => {
  it('produces valid JSON', () => {
    const json = renderRunJson(makeRunStatus(), [], [], null)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it('contains run metadata', () => {
    const json = renderRunJson(makeRunStatus(), [], [], null)
    const parsed = JSON.parse(json) as Record<string, unknown>
    const status = parsed.status as Record<string, unknown>
    expect(status.runId).toBe('run-001')
    expect(status.workflowName).toBe('test-workflow')
  })

  it('redacts tokens from log entries', () => {
    const logWithToken = [
      { ts: '2026-05-28T10:00:01Z', phase: 'scan', message: 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
    ]
    const json = renderRunJson(makeRunStatus(), [], logWithToken, null)
    expect(json).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')
    expect(json).toContain('[token redacted]')
  })
})

// ── renderRunMarkdown ────────────────────────────────────────────────────────

describe('renderRunMarkdown', () => {
  it('produces markdown with header', () => {
    const md = renderRunMarkdown(makeRunStatus(), [], [], null)
    expect(md).toContain('# Workflow Run: run-001')
  })

  it('includes workflow metadata', () => {
    const md = renderRunMarkdown(makeRunStatus(), [], [], null)
    expect(md).toContain('**Workflow:** test-workflow')
    expect(md).toContain('**Status:** completed')
  })

  it('includes phases table', () => {
    const phases = [
      makePhaseCheckpoint({ phase: 'scan', status: 'completed' }),
    ]
    const md = renderRunMarkdown(makeRunStatus(), phases, [], null)
    expect(md).toContain('## Phases')
    expect(md).toContain('| scan | completed |')
  })

  it('includes output when present', () => {
    const md = renderRunMarkdown(makeRunStatus(), [], [], { result: 'ok' })
    expect(md).toContain('## Output')
    expect(md).toContain('```json')
  })

  it('excludes output section when null', () => {
    const md = renderRunMarkdown(makeRunStatus(), [], [], null)
    expect(md).not.toContain('## Output')
  })

  it('includes log entries', () => {
    const logEntries = [
      { ts: '2026-05-28T10:00:01Z', phase: 'scan', message: 'Scanning' },
    ]
    const md = renderRunMarkdown(makeRunStatus(), [], logEntries, null)
    expect(md).toContain('## Log Entries')
    expect(md).toContain('Scanning')
  })

  it('redacts tokens in markdown output', () => {
    const logWithToken = [
      { ts: '2026-05-28T10:00:01Z', phase: 'scan', message: 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
    ]
    const md = renderRunMarkdown(makeRunStatus(), [], logWithToken, null)
    expect(md).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')
  })
})
