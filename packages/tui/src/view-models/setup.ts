import type { SetupReport, SetupFinding } from '@openslack/runtime'
import { sanitizeTerminalText } from '../sanitize.js'

export type SetupReadiness = 'ready' | 'almost ready' | 'needs setup help'

export type SetupFindingStatus = 'PASS' | 'WARN' | 'FAIL' | 'info'

export interface SetupFindingViewModel {
  id: string
  title: string
  status: SetupFindingStatus
  detail: string
  nextAction: string
  command: string
}

export interface SetupViewModel {
  readiness: SetupReadiness
  root: string
  totalChecks: number
  passedChecks: number
  fixable: SetupFindingViewModel[]
  needsAction: SetupFindingViewModel[]
  ok: SetupFindingViewModel[]
}

function mapStatus(status: SetupFinding['status']): SetupFindingStatus {
  switch (status) {
    case 'ok': return 'PASS'
    case 'fixable_by_command': return 'WARN'
    case 'requires_github_admin': return 'FAIL'
    case 'requires_human_approval': return 'FAIL'
    case 'informational': return 'info'
    default: return 'info'
  }
}

function mapFinding(f: SetupFinding): SetupFindingViewModel {
  return {
    id: sanitizeTerminalText(f.id),
    title: sanitizeTerminalText(f.title),
    status: mapStatus(f.status),
    detail: sanitizeTerminalText(f.detail),
    nextAction: f.nextAction ? sanitizeTerminalText(f.nextAction) : '',
    command: f.command ? sanitizeTerminalText(f.command) : '',
  }
}

export function mapSetupToViewModel(report: SetupReport): SetupViewModel {
  const fixable = report.findings
    .filter(f => f.status === 'fixable_by_command')
    .map(mapFinding)

  const needsAction = report.findings
    .filter(f => f.status === 'requires_github_admin' || f.status === 'requires_human_approval')
    .map(mapFinding)

  const ok = report.findings
    .filter(f => f.status === 'ok' || f.status === 'informational')
    .map(mapFinding)

  const allOk = fixable.length === 0 && needsAction.length === 0
  const readiness: SetupReadiness = allOk ? 'ready' : needsAction.length > 0 ? 'needs setup help' : 'almost ready'

  return {
    readiness,
    root: sanitizeTerminalText(report.root),
    totalChecks: report.findings.length,
    passedChecks: ok.length,
    fixable,
    needsAction,
    ok,
  }
}
