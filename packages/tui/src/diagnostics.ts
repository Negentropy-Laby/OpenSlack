/**
 * diagnostics.ts -- TUI terminal capability diagnostics.
 *
 * Decomposes the `isTuiSupported()` check into individual diagnostic findings
 * so users can understand why TUI is unavailable and how to fix it.
 *
 * Each finding has:
 * - A pass/warn/fail status
 * - A human-readable label and detail
 * - A fallback suggestion when the check fails
 */
import { isEnvTruthy } from './utils/env-utils.js'

// ── Types ──

export type DiagnosticStatus = 'pass' | 'warn' | 'fail'

export interface TuiDiagnosticFinding {
  /** Short label for the check */
  label: string
  /** pass / warn / fail */
  status: DiagnosticStatus
  /** Human-readable explanation of the result */
  detail: string
  /** Suggested fallback command or action when status is not 'pass' */
  fallback: string
}

export interface TuiDiagnosticReport {
  /** Overall recommendation: 'tui' or 'plain' */
  recommendedMode: 'tui' | 'plain'
  /** Terminal emulator name (best-effort detection) */
  terminal: string
  /** Individual findings */
  findings: TuiDiagnosticFinding[]
  /** Summary counts */
  summary: {
    pass: number
    warn: number
    fail: number
  }
}

// ── Constants ──

const MIN_COLUMNS = 40
const MIN_ROWS = 12

// ── Helpers ──

/**
 * Detect the terminal emulator name from environment variables.
 * Best-effort heuristic — not exhaustive.
 */
function detectTerminalName(): string {
  if (process.env.WT_SESSION) return 'Windows Terminal'
  if (process.env.TERM_PROGRAM === 'vscode') return 'VS Code Terminal'
  if (process.env.TERM_PROGRAM === 'iTerm.app') return 'iTerm2'
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return 'macOS Terminal'
  if (process.env.TERM_PROGRAM === 'Hyper') return 'Hyper'
  if (process.env.KONSOLE_VERSION) return 'Konsole'
  if (process.env.TERMINATOR_ID) return 'Terminator'
  if (process.env.GNOME_TERMINAL_SERVICE) return 'GNOME Terminal'
  if (process.env.TMUX) return 'tmux'
  if (process.env.SCREEN_SESSION) return 'GNU Screen'
  if (process.env.SSH_CONNECTION) return `SSH (${process.env.TERM ?? 'unknown'})`
  if (process.env.TERM) return `TERM=${process.env.TERM}`
  if (process.platform === 'win32') return 'Windows Console (conhost)'
  return 'Unknown'
}

/**
 * Detect whether the terminal likely supports Unicode / wide characters.
 * Uses COLORTERM and TERM as heuristics — not definitive.
 */
function estimateUnicodeSupport(): boolean {
  // Modern terminals that definitely support Unicode
  const term = process.env.TERM_PROGRAM ?? ''
  if (['vscode', 'iTerm.app', 'Hyper'].includes(term)) return true
  if (process.env.WT_SESSION) return true
  if (process.env.KONSOLE_VERSION) return true
  // xterm-256color usually implies Unicode-capable terminal
  if (process.env.TERM?.includes('256color')) return true
  // Default: assume no on minimal terminals
  if (process.env.TERM === 'dumb') return false
  // Unknown but not dumb — assume yes
  return true
}

/**
 * Detect whether the terminal likely supports true color / 256 color.
 */
function estimateColorSupport(): 'truecolor' | '256' | '16' | 'mono' {
  if (isEnvTruthy(process.env.NO_COLOR)) return 'mono'
  const colorterm = process.env.COLORTERM ?? ''
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'
  if (process.env.TERM?.includes('256color')) return '256'
  return '16'
}

/**
 * Detect whether the terminal supports DEC alternate screen (mode 1049).
 */
function supportsAltScreen(): boolean {
  if (!process.stdout.isTTY) return false
  if (process.platform !== 'win32') return true
  return !!process.env.WT_SESSION || process.env.TERM_PROGRAM === 'vscode'
}

// ── Main diagnostic function ──

/**
 * Run TUI terminal capability diagnostics and return a structured report.
 *
 * Each finding explains one terminal capability and provides a fallback
 * suggestion when the capability is missing.
 */
export function diagnoseTui(stdout?: { isTTY?: boolean; columns?: number; rows?: number }): TuiDiagnosticReport {
  const out = stdout ?? process.stdout
  const isTTY = !!out.isTTY
  const columns = out.columns ?? 0
  const rows = out.rows ?? 0

  const findings: TuiDiagnosticFinding[] = []

  // 1. TTY check
  findings.push({
    label: 'TTY',
    status: isTTY ? 'pass' : 'fail',
    detail: isTTY
      ? 'Output is a TTY device'
      : 'Output is not a TTY (piped or redirected)',
    fallback: 'Run in an interactive terminal. For CI, use: bun run openslack status --format standard',
  })

  // 2. Terminal dimensions
  const dimStatus: DiagnosticStatus = columns >= MIN_COLUMNS && rows >= MIN_ROWS
    ? 'pass'
    : columns > 0 && rows > 0
      ? 'warn'
      : 'fail'
  findings.push({
    label: 'Dimensions',
    status: dimStatus,
    detail: columns > 0 && rows > 0
      ? `${columns} x ${rows} (minimum: ${MIN_COLUMNS} x ${MIN_ROWS})`
      : 'Dimensions unknown (non-TTY)',
    fallback: `Resize terminal to at least ${MIN_COLUMNS} x ${MIN_ROWS}. For narrow terminals: bun run openslack status --format standard`,
  })

  // 3. TERM variable
  const term = process.env.TERM ?? ''
  findings.push({
    label: 'TERM',
    status: term && term !== 'dumb' ? 'pass' : 'warn',
    detail: term ? `TERM=${term}` : 'TERM not set',
    fallback: 'Set TERM=xterm-256color or use a modern terminal emulator',
  })

  // 4. NO_COLOR
  const noColor = isEnvTruthy(process.env.NO_COLOR)
  findings.push({
    label: 'NO_COLOR',
    status: noColor ? 'fail' : 'pass',
    detail: noColor ? 'NO_COLOR is set — color output disabled' : 'Not set (colors enabled)',
    fallback: 'Unset NO_COLOR for TUI mode, or use: bun run openslack status --format standard',
  })

  // 5. CI environment
  const isCI = isEnvTruthy(process.env.CI)
  findings.push({
    label: 'CI',
    status: isCI ? 'warn' : 'pass',
    detail: isCI ? 'Running in CI environment' : 'Not in CI',
    fallback: 'CI terminals do not support interactive TUI. Use: bun run openslack status --format standard',
  })

  // 6. Unicode support
  const unicode = estimateUnicodeSupport()
  findings.push({
    label: 'Unicode',
    status: unicode ? 'pass' : 'warn',
    detail: unicode ? 'Unicode/wide characters supported' : 'Unicode support uncertain',
    fallback: 'Use a modern terminal with Unicode support, or: bun run openslack status --format standard',
  })

  // 7. Color support
  const colorLevel = estimateColorSupport()
  findings.push({
    label: 'Color',
    status: colorLevel === 'mono' ? 'warn' : 'pass',
    detail: `Color depth: ${colorLevel}`,
    fallback: 'Set COLORTERM=truecolor for best results, or: bun run openslack status --format standard',
  })

  // 8. Alt screen support
  const altScreen = supportsAltScreen()
  findings.push({
    label: 'Alt Screen',
    status: altScreen ? 'pass' : 'warn',
    detail: altScreen
      ? 'DEC alternate screen supported'
      : process.platform === 'win32'
        ? 'Windows conhost: alt screen not fully supported (using main screen)'
        : 'Alt screen detection unavailable',
    fallback: 'Use Windows Terminal or VS Code Terminal for full alt screen support',
  })

  // 9. Mouse tracking
  findings.push({
    label: 'Mouse',
    status: isTTY ? 'pass' : 'warn',
    detail: isTTY ? 'Mouse tracking available in TUI mode' : 'Mouse tracking requires TTY',
    fallback: 'Mouse navigation is optional. Use keyboard shortcuts in TUI mode',
  })

  // 10. Platform
  findings.push({
    label: 'Platform',
    status: 'pass',
    detail: `${process.platform} (${process.arch})`,
    fallback: '',
  })

  // Compute summary
  const summary = {
    pass: findings.filter(f => f.status === 'pass').length,
    warn: findings.filter(f => f.status === 'warn').length,
    fail: findings.filter(f => f.status === 'fail').length,
  }

  // Overall recommendation
  const recommendedMode: 'tui' | 'plain' =
    summary.fail > 0 || (isCI && !isTTY) ? 'plain' : 'tui'

  return {
    recommendedMode,
    terminal: detectTerminalName(),
    findings,
    summary,
  }
}

/**
 * Render a TUI diagnostic report as plain text (for --format standard output).
 */
export function renderDiagnosticsPlain(report: TuiDiagnosticReport): string {
  const lines: string[] = []

  lines.push('TUI Terminal Diagnostics')
  lines.push(`Terminal: ${report.terminal}`)
  lines.push(`Recommended mode: ${report.recommendedMode}`)
  lines.push('')

  for (const finding of report.findings) {
    const icon = finding.status === 'pass' ? '[PASS]' : finding.status === 'warn' ? '[WARN]' : '[FAIL]'
    lines.push(`${icon} ${finding.label}: ${finding.detail}`)
    if (finding.fallback && finding.status !== 'pass') {
      lines.push(`      Fallback: ${finding.fallback}`)
    }
  }

  lines.push('')
  lines.push(`Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`)

  if (report.recommendedMode === 'plain') {
    lines.push('')
    lines.push('TUI is not available. Use these commands instead:')
    lines.push('  bun run openslack status --format standard')
    lines.push('  bun run openslack doctor')
    lines.push('  bun run openslack pr list')
  }

  return lines.join('\n')
}
