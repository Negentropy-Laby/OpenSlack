import { describe, it, expect } from 'vitest'
import {
  stripSourceCode,
  truncateContext,
  stripPrompt,
  redactAgentCall,
  stripTokensAndCredentials,
  remapAbsolutePaths,
  redactFailedSchemaOutput,
  redactString,
  redactDeep,
  redactRunStatus,
  redactPhaseCheckpoint,
  redactRunBundle,
} from '../redact.js'
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

// ── Rule 1: Source code stripping ────────────────────────────────────────────

describe('stripSourceCode', () => {
  it('removes fenced code blocks', () => {
    const input = 'Here is some code:\n```js\nconsole.log("hello")\n```\nEnd.'
    const result = stripSourceCode(input)
    expect(result).not.toContain('console.log')
    expect(result).toContain('[source code redacted]')
  })

  it('removes long inline code spans (50+ chars)', () => {
    const longCode = '`' + 'x'.repeat(60) + '`'
    const result = stripSourceCode(longCode)
    expect(result).toContain('[source code redacted]')
  })

  it('preserves short inline code', () => {
    const input = 'Use `foo` here.'
    const result = stripSourceCode(input)
    expect(result).toBe(input)
  })

  it('handles strings with no code', () => {
    const input = 'Just plain text here.'
    const result = stripSourceCode(input)
    expect(result).toBe(input)
  })

  it('handles empty string', () => {
    expect(stripSourceCode('')).toBe('')
  })
})

describe('truncateContext', () => {
  it('truncates context to 3 lines by default', () => {
    const input = 'line1\nline2\nline3\nline4\nline5'
    const result = truncateContext(input)
    expect(result).toBe('line1\nline2\nline3\n... [truncated]')
  })

  it('preserves content within limit', () => {
    const input = 'line1\nline2\nline3'
    const result = truncateContext(input)
    expect(result).toBe(input)
  })

  it('respects custom max lines', () => {
    const input = 'a\nb\nc\nd'
    const result = truncateContext(input, 2)
    expect(result).toBe('a\nb\n... [truncated]')
  })

  it('handles single line', () => {
    expect(truncateContext('single', 3)).toBe('single')
  })
})

// ── Rule 2: Prompt stripping ─────────────────────────────────────────────────

describe('stripPrompt', () => {
  it('replaces long prompts with redacted marker', () => {
    const longPrompt = 'A'.repeat(200)
    expect(stripPrompt(longPrompt)).toBe('[prompt redacted]')
  })

  it('preserves short prompts (<=80 chars)', () => {
    const shortPrompt = 'Short label'
    expect(stripPrompt(shortPrompt)).toBe('Short label')
  })

  it('handles empty string', () => {
    expect(stripPrompt('')).toBe('')
  })
})

describe('redactAgentCall', () => {
  it('strips prompt text from agent call', () => {
    const call = {
      label: 'scanner',
      phase: 'scan',
      prompt: 'A'.repeat(200),
      tokenUsage: 500,
    }
    const result = redactAgentCall(call)
    expect(result.prompt).toBe('[prompt redacted]')
    expect(result.label).toBe('scanner')
    expect(result.phase).toBe('scan')
    expect(result.tokenUsage).toBe(500)
  })

  it('strips promptText field', () => {
    const call = {
      label: 'scanner',
      phase: 'scan',
      promptText: 'Full prompt text here that is very long indeed',
    }
    const result = redactAgentCall(call)
    expect(result.promptText).toBe('[prompt redacted]')
  })

  it('retains resultSummary', () => {
    const call = {
      label: 'scanner',
      phase: 'scan',
      resultSummary: 'Found 3 issues',
    }
    const result = redactAgentCall(call)
    expect(result.resultSummary).toBe('Found 3 issues')
  })

  it('does not leak undeclared fields', () => {
    const call = {
      label: 'scanner',
      phase: 'scan',
      internalData: 'should not appear',
    }
    const result = redactAgentCall(call)
    expect(result).not.toHaveProperty('internalData')
  })
})

// ── Rule 3: Token/credential stripping ───────────────────────────────────────

describe('stripTokensAndCredentials', () => {
  it('redacts GitHub tokens (ghp_)', () => {
    const input = 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
    const result = stripTokensAndCredentials(input)
    expect(result).toContain('[token redacted]')
    expect(result).not.toContain('ghp_')
  })

  it('redacts bearer tokens', () => {
    const input = 'Authorization: Bearer abc123def456ghi789jkl012mno345'
    const result = stripTokensAndCredentials(input)
    expect(result).toContain('[token redacted]')
    expect(result).not.toContain('Bearer abc')
  })

  it('redacts URLs with query parameters', () => {
    const input = 'https://api.github.com/repos/foo/bar?token=secret123'
    const result = stripTokensAndCredentials(input)
    expect(result).toContain('[query redacted]')
    expect(result).not.toContain('token=secret123')
    expect(result).toContain('api.github.com/repos/foo/bar')
  })

  it('preserves URLs without query parameters', () => {
    const input = 'https://api.github.com/repos/foo/bar'
    const result = stripTokensAndCredentials(input)
    expect(result).toBe(input)
  })

  it('handles string with no tokens', () => {
    const input = 'No tokens here'
    const result = stripTokensAndCredentials(input)
    expect(result).toBe(input)
  })
})

// ── Rule 4: Absolute path remapping ──────────────────────────────────────────

describe('remapAbsolutePaths', () => {
  it('remaps repo-root paths to relative', () => {
    const input = 'File changed: /home/user/project/src/index.ts'
    const result = remapAbsolutePaths(input, '/home/user/project')
    expect(result).toContain('/src/index.ts')
    expect(result).not.toContain('/home/user/project')
  })

  it('redacts paths outside repo root', () => {
    const input = 'File changed: /etc/passwd'
    const result = remapAbsolutePaths(input, '/home/user/project')
    expect(result).toContain('[path redacted]')
  })

  it('handles Windows-style paths', () => {
    const input = 'File: C:\\Users\\dev\\project\\src\\main.ts'
    const result = remapAbsolutePaths(input, 'C:\\Users\\dev\\project')
    expect(result).toContain('/src/main.ts')
  })

  it('returns input unchanged when no repoRoot provided', () => {
    const input = '/home/user/project/src/index.ts'
    const result = remapAbsolutePaths(input)
    expect(result).toBe(input)
  })
})

// ── Rule 5: Failed schema output ────────────────────────────────────────────

describe('redactFailedSchemaOutput', () => {
  it('replaces output with redacted summary when validation error provided', () => {
    const output = { sensitive: 'data', nested: { deep: 'value' } }
    const result = redactFailedSchemaOutput(output, 'Missing required field "name"') as Record<string, unknown>
    expect(result._redacted).toBe(true)
    expect(result.reason).toBe('Schema validation failed')
    expect(result.error).toBe('Missing required field "name"')
    expect(result).not.toHaveProperty('sensitive')
  })

  it('passes output through when no validation error', () => {
    const output = { data: 'safe' }
    const result = redactFailedSchemaOutput(output)
    expect(result).toEqual(output)
  })

  it('handles null output', () => {
    expect(redactFailedSchemaOutput(null)).toBeNull()
  })

  it('handles undefined output', () => {
    expect(redactFailedSchemaOutput(undefined)).toBeUndefined()
  })
})

// ── Composite: redactString ──────────────────────────────────────────────────

describe('redactString', () => {
  it('applies source code stripping', () => {
    const input = 'Result:\n```js\nvar x = 1\n```'
    const result = redactString(input)
    expect(result).toContain('[source code redacted]')
  })

  it('applies token stripping', () => {
    const input = 'Used token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
    const result = redactString(input)
    expect(result).toContain('[token redacted]')
  })

  it('applies path remapping', () => {
    const input = '/home/user/project/src/app.ts'
    const result = redactString(input, { repoRoot: '/home/user/project' })
    expect(result).toContain('/src/app.ts')
    expect(result).not.toContain('/home/user')
  })
})

// ── Composite: redactDeep ────────────────────────────────────────────────────

describe('redactDeep', () => {
  it('walks nested objects and redacts strings', () => {
    const input = {
      message: 'File at /home/user/project/src/main.ts with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
      nested: {
        text: '```python\nprint("hello")\n```',
      },
    }
    const result = redactDeep(input, { repoRoot: '/home/user/project' }) as Record<string, unknown>
    const message = result.message as string
    expect(message).not.toContain('ghp_')
    expect(message).not.toContain('/home/user')
    const nested = result.nested as Record<string, unknown>
    expect(nested.text as string).toContain('[source code redacted]')
  })

  it('handles arrays', () => {
    const input = ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'safe text']
    const result = redactDeep(input) as string[]
    expect(result[0]).toContain('[token redacted]')
    expect(result[1]).toBe('safe text')
  })

  it('passes through primitives', () => {
    expect(redactDeep(42)).toBe(42)
    expect(redactDeep(true)).toBe(true)
    expect(redactDeep(null)).toBeNull()
  })
})

// ── Composite: redactRunStatus ───────────────────────────────────────────────

describe('redactRunStatus', () => {
  it('returns redacted data with redactions array', () => {
    const status = makeRunStatus()
    const result = redactRunStatus(status)
    expect(result.data).toBeDefined()
    expect(result.redactions).toBeDefined()
    expect(Array.isArray(result.redactions)).toBe(true)
  })

  it('preserves run metadata fields', () => {
    const status = makeRunStatus()
    const result = redactRunStatus(status)
    const data = result.data as Record<string, unknown>
    expect(data.runId).toBe('run-001')
    expect(data.workflowName).toBe('test-workflow')
  })
})

// ── Composite: redactPhaseCheckpoint ─────────────────────────────────────────

describe('redactPhaseCheckpoint', () => {
  it('returns redacted phase data', () => {
    const checkpoint = makePhaseCheckpoint()
    const result = redactPhaseCheckpoint(checkpoint)
    const data = result.data as Record<string, unknown>
    expect(data.phase).toBe('scan')
    expect(data.status).toBe('completed')
  })
})

// ── Composite: redactRunBundle ───────────────────────────────────────────────

describe('redactRunBundle', () => {
  it('redacts full bundle with all sections', () => {
    const bundle = {
      status: makeRunStatus(),
      phases: [makePhaseCheckpoint()],
      logEntries: [
        { ts: '2026-05-28T10:00:01Z', phase: 'scan', message: 'Scanning with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
      ],
      output: { findings: ['bug1'] },
    }
    const result = redactRunBundle(bundle, { repoRoot: '/home/user/project' })
    const data = result.data as Record<string, unknown>
    expect(data.status).toBeDefined()
    expect(data.phases).toBeDefined()
    expect(data.logEntries).toBeDefined()
    expect(data.output).toBeDefined()

    // Verify tokens were redacted from log entries
    const logEntries = data.logEntries as Array<Record<string, unknown>>
    const logMessage = logEntries[0].message as string
    expect(logMessage).not.toContain('ghp_')
  })
})
