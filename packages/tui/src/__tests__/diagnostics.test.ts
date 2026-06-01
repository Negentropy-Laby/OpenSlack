/**
 * diagnostics.test.ts -- Tests for TUI terminal capability diagnostics.
 *
 * Verifies that diagnoseTui() returns structured findings for all
 * terminal properties, and renderDiagnosticsPlain() produces readable output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { diagnoseTui, renderDiagnosticsPlain } from '../diagnostics.js'
import type { TuiDiagnosticReport } from '../diagnostics.js'

describe('diagnoseTui', () => {
  const originalEnv: Record<string, string | undefined> = {}
  const envKeys = ['CI', 'NO_COLOR', 'TERM', 'WT_SESSION', 'TERM_PROGRAM', 'COLORTERM', 'OPENSLACK_TUI']

  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
  })

  it('returns a report with all required fields', () => {
    const report = diagnoseTui({ isTTY: true, columns: 80, rows: 24 })

    expect(report).toHaveProperty('recommendedMode')
    expect(report).toHaveProperty('terminal')
    expect(report).toHaveProperty('findings')
    expect(report).toHaveProperty('summary')

    expect(['tui', 'plain']).toContain(report.recommendedMode)
    expect(report.terminal).toBeTruthy()
    expect(report.findings.length).toBeGreaterThanOrEqual(8)
    expect(report.summary.pass + report.summary.warn + report.summary.fail).toBe(report.findings.length)
  })

  it('recommends plain mode for non-TTY output', () => {
    const report = diagnoseTui({ isTTY: false, columns: 0, rows: 0 })

    expect(report.recommendedMode).toBe('plain')
    expect(report.findings.find(f => f.label === 'TTY')!.status).toBe('fail')
  })

  it('recommends tui mode for capable TTY', () => {
    delete process.env.CI
    delete process.env.NO_COLOR
    process.env.TERM = 'xterm-256color'

    const report = diagnoseTui({ isTTY: true, columns: 80, rows: 24 })

    expect(report.recommendedMode).toBe('tui')
    expect(report.findings.find(f => f.label === 'TTY')!.status).toBe('pass')
  })

  it('detects CI environment as warn', () => {
    process.env.CI = 'true'

    const report = diagnoseTui({ isTTY: true, columns: 80, rows: 24 })

    const ciFinding = report.findings.find(f => f.label === 'CI')!
    expect(ciFinding.status).toBe('warn')
    expect(ciFinding.detail).toContain('CI')
  })

  it('detects NO_COLOR as fail', () => {
    process.env.NO_COLOR = '1'

    const report = diagnoseTui({ isTTY: true, columns: 80, rows: 24 })

    const noColorFinding = report.findings.find(f => f.label === 'NO_COLOR')!
    expect(noColorFinding.status).toBe('fail')
    expect(noColorFinding.fallback).toContain('standard')
  })

  it('detects narrow terminal as warn', () => {
    const report = diagnoseTui({ isTTY: true, columns: 30, rows: 10 })

    const dimFinding = report.findings.find(f => f.label === 'Dimensions')!
    expect(dimFinding.status).toBe('warn')
    expect(dimFinding.detail).toContain('30 x 10')
  })

  it('each finding has required fields', () => {
    const report = diagnoseTui({ isTTY: true, columns: 80, rows: 24 })

    for (const finding of report.findings) {
      expect(finding.label).toBeTruthy()
      expect(['pass', 'warn', 'fail']).toContain(finding.status)
      expect(finding.detail).toBeTruthy()
      expect(typeof finding.fallback).toBe('string')
    }
  })

  it('detects terminal dimensions', () => {
    const report = diagnoseTui({ isTTY: true, columns: 100, rows: 30 })

    const dimFinding = report.findings.find(f => f.label === 'Dimensions')!
    expect(dimFinding.status).toBe('pass')
    expect(dimFinding.detail).toContain('100 x 30')
  })

  it('detects platform', () => {
    const report = diagnoseTui({ isTTY: true, columns: 80, rows: 24 })

    const platformFinding = report.findings.find(f => f.label === 'Platform')!
    expect(platformFinding.status).toBe('pass')
    expect(platformFinding.detail).toContain(process.platform)
  })

  it('reports color depth', () => {
    process.env.COLORTERM = 'truecolor'

    const report = diagnoseTui({ isTTY: true, columns: 80, rows: 24 })

    const colorFinding = report.findings.find(f => f.label === 'Color')!
    expect(colorFinding.detail).toContain('truecolor')
  })
})

describe('renderDiagnosticsPlain', () => {
  it('renders report as readable plain text', () => {
    const report = diagnoseTui({ isTTY: true, columns: 80, rows: 24 })
    const plain = renderDiagnosticsPlain(report)

    expect(plain).toContain('TUI Terminal Diagnostics')
    expect(plain).toContain('Recommended mode:')
    expect(plain).toContain('[PASS]')
    expect(plain).toContain('Summary:')
  })

  it('includes fallback commands for plain mode recommendation', () => {
    const report = diagnoseTui({ isTTY: false, columns: 0, rows: 0 })
    const plain = renderDiagnosticsPlain(report)

    expect(plain).toContain('TUI is not available')
    expect(plain).toContain('openslack status')
  })

  it('does not include fallback section for tui mode', () => {
    delete process.env.CI
    delete process.env.NO_COLOR
    process.env.TERM = 'xterm-256color'

    const report = diagnoseTui({ isTTY: true, columns: 80, rows: 24 })
    if (report.recommendedMode === 'tui') {
      const plain = renderDiagnosticsPlain(report)
      expect(plain).not.toContain('TUI is not available')
    }
  })

  it('shows [WARN] and [FAIL] markers for non-passing findings', () => {
    process.env.CI = 'true'
    const report = diagnoseTui({ isTTY: false, columns: 0, rows: 0 })
    const plain = renderDiagnosticsPlain(report)

    expect(plain).toContain('[FAIL]')
    expect(plain).toContain('[WARN]')
  })
})
